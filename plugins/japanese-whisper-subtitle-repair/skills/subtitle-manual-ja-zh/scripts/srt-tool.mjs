#!/usr/bin/env node

import crypto from "crypto";
import { spawnSync } from "node:child_process";
import fs from "fs";
import path from "path";

const TIMECODE_PATTERN = /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/;
const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);
const EVIDENCE_TYPES = new Set([
  "audio-confirmed",
  "official-transcript",
  "official-name",
  "context-inferred",
  "phonetic-analysis",
  "grammar-only",
  "alternate-asr",
  "speaker-profile",
  "reference-subtitle",
  "unresolved",
]);
const CHANGE_TYPES = new Set([
  "asr-homophone",
  "proper-name",
  "grammar",
  "punctuation",
  "segmentation",
  "hallucination",
  "duplicate",
  "timing",
  "speaker-label",
  "other",
]);
const AUDIO_REVIEW_STATUSES = new Set([
  "not-reviewed",
  "reviewed-clear",
  "reviewed-unclear",
  "not-needed",
]);
const OVERCORRECTION_REVIEW_STATUSES = new Set(["not-reviewed", "pass", "unresolved"]);
const ISSUE_WEIGHTS = { high: 5, medium: 2, low: 1 };

function printUsage() {
  console.log(`Usage:
  node <skill-dir>/scripts/srt-tool.mjs inspect <file.srt> [--json]
  node <skill-dir>/scripts/srt-tool.mjs dump-json <file.srt>
  node <skill-dir>/scripts/srt-tool.mjs export-template <file.srt> <output.json>
  node <skill-dir>/scripts/srt-tool.mjs audit-template <template.json> [--json]
  node <skill-dir>/scripts/srt-tool.mjs write-corrected <template.json> <output.srt>
  node <skill-dir>/scripts/srt-tool.mjs validate <file.srt> [--json]
  node <skill-dir>/scripts/srt-tool.mjs compare <source.srt> <corrected.srt> [--json]
  node <skill-dir>/scripts/srt-tool.mjs analyze-silence <file.srt> <audio-or-video> <output.json> [options]

Silence analysis options:
  --noise-db <number>      Silence threshold in dB (default: -35).
  --min-silence <seconds>  Minimum silence duration (default: 0.20).
  --max-trim-ms <ms>       Maximum suggested edge trim (default: 1500).

Commands:
  inspect          Summarize structure and flag likely ASR risks.
  dump-json        Output parsed blocks, summary, and risk findings as JSON.
  export-template  Export a correction template with risk and confidence fields.
  audit-template   Audit review coverage, confidence, and raw/corrected changes.
  write-corrected  Write a reviewed Japanese-only corrected SRT.
  validate         Validate a Japanese-only corrected SRT.
  compare          Compare source and output block counts, timing, and text changes.
  analyze-silence  Use local ffmpeg/ffprobe to suggest auditable timing repairs.
`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function parseTimestamp(value) {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) {
    return null;
  }

  const [, hh, mm, ss, ms] = match;
  return Number(hh) * 3600000 + Number(mm) * 60000 + Number(ss) * 1000 + Number(ms);
}

function msToSrt(ms) {
  const sign = ms < 0 ? "-" : "";
  const absolute = Math.abs(ms);
  const hh = String(Math.floor(absolute / 3600000)).padStart(2, "0");
  const mm = String(Math.floor((absolute % 3600000) / 60000)).padStart(2, "0");
  const ss = String(Math.floor((absolute % 60000) / 1000)).padStart(2, "0");
  const mmm = String(absolute % 1000).padStart(3, "0");
  return `${sign}${hh}:${mm}:${ss},${mmm}`;
}

function parseNumericOption(args, name, defaultValue) {
  const index = args.indexOf(name);
  if (index === -1) {
    return defaultValue;
  }
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} requires a numeric value.`);
  }
  return value;
}

function parseSilenceOptions(args) {
  const allowed = new Set(["--noise-db", "--min-silence", "--max-trim-ms"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index])) {
      throw new Error(`Unsupported silence analysis option: ${args[index] || "<empty>"}`);
    }
    if (args[index + 1] === undefined) {
      throw new Error(`${args[index]} requires a value.`);
    }
  }
  const options = {
    noiseDb: parseNumericOption(args, "--noise-db", -35),
    minSilenceSeconds: parseNumericOption(args, "--min-silence", 0.2),
    maxTrimMs: parseNumericOption(args, "--max-trim-ms", 1500),
    minDisplayMs: 500,
  };
  if (options.minSilenceSeconds <= 0) {
    throw new Error("--min-silence must be greater than 0.");
  }
  if (options.maxTrimMs < 0) {
    throw new Error("--max-trim-ms must be 0 or greater.");
  }
  return options;
}

function runMediaTool(executable, args, label) {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      `${label} is not installed. Do not search for or install it automatically; continue with manual audio review or ask the user for permission.`
    );
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

function probeDurationMs(mediaPath) {
  const executable = process.env.FFPROBE_PATH || "ffprobe";
  const result = runMediaTool(
    executable,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      mediaPath,
    ],
    "ffprobe"
  );
  const durationSeconds = Number(result.stdout.trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("ffprobe did not return a valid media duration.");
  }
  return Math.round(durationSeconds * 1000);
}

function detectSilenceIntervals(mediaPath, durationMs, noiseDb, minSilenceSeconds) {
  const executable = process.env.FFMPEG_PATH || "ffmpeg";
  const result = runMediaTool(
    executable,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      mediaPath,
      "-af",
      `silencedetect=noise=${noiseDb}dB:d=${minSilenceSeconds}`,
      "-f",
      "null",
      "-",
    ],
    "ffmpeg"
  );
  const intervals = [];
  const eventPattern = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/gu;
  let activeStartMs = null;
  let match;

  while ((match = eventPattern.exec(result.stderr)) !== null) {
    const valueMs = Math.max(0, Math.round(Number(match[2]) * 1000));
    if (match[1] === "start") {
      activeStartMs = valueMs;
    } else if (activeStartMs !== null) {
      intervals.push({ startMs: activeStartMs, endMs: Math.min(valueMs, durationMs) });
      activeStartMs = null;
    }
  }
  if (activeStartMs !== null && activeStartMs < durationMs) {
    intervals.push({ startMs: activeStartMs, endMs: durationMs });
  }

  return intervals.filter((interval) => interval.endMs > interval.startMs);
}

function findContainingSilence(intervals, timestampMs) {
  return intervals.find(
    (interval) => interval.startMs <= timestampMs && timestampMs <= interval.endMs
  );
}

function buildSilenceTimingReport(blocks, intervals, settings) {
  const findings = [];

  for (const block of blocks) {
    if (block.start === null || block.end === null || block.durationMs <= 0) {
      continue;
    }
    const fullySilent = intervals.some(
      (interval) => interval.startMs <= block.start && interval.endMs >= block.end
    );
    const startSilence = findContainingSilence(intervals, block.start);
    const endSilence = findContainingSilence(intervals, block.end);
    let suggestedStart = block.start;
    let suggestedEnd = block.end;
    const issues = [];

    if (fullySilent) {
      issues.push("subtitle-fully-in-silence");
    } else {
      if (startSilence && startSilence.endMs > block.start && startSilence.endMs < block.end) {
        const trimMs = startSilence.endMs - block.start;
        if (trimMs <= settings.maxTrimMs) {
          suggestedStart = startSilence.endMs;
          issues.push("leading-silence");
        } else {
          issues.push("large-leading-silence-offset");
        }
      }
      if (endSilence && endSilence.startMs > block.start && endSilence.startMs < block.end) {
        const trimMs = block.end - endSilence.startMs;
        if (trimMs <= settings.maxTrimMs) {
          suggestedEnd = endSilence.startMs;
          issues.push("trailing-silence");
        } else {
          issues.push("large-trailing-silence-offset");
        }
      }
    }

    if (suggestedEnd - suggestedStart < settings.minDisplayMs) {
      suggestedStart = block.start;
      suggestedEnd = block.end;
      issues.push("trim-would-be-too-short");
    }
    if (issues.length === 0) {
      continue;
    }

    const timingChanged = suggestedStart !== block.start || suggestedEnd !== block.end;
    findings.push({
      blockIndex: block.blockIndex,
      sourceTimecode: block.timecode,
      issues,
      fullySilent,
      suggestedTimecode: timingChanged
        ? `${msToSrt(suggestedStart)} --> ${msToSrt(suggestedEnd)}`
        : null,
      leadingTrimMs: suggestedStart - block.start,
      trailingTrimMs: block.end - suggestedEnd,
      recommendation: fullySilent
        ? "review-remove-or-retime"
        : timingChanged
          ? "review-suggested-timecode"
          : "manual-review",
    });
  }

  return findings;
}

function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}

function normalizeForComparison(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function normalizeForChangeDetection(text) {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function parseSrt(text) {
  const normalized = normalizeNewlines(text).trim();
  if (!normalized) {
    return [];
  }

  return normalized.split(/\n{2,}/).map((rawBlock, index) => {
    const lines = rawBlock.split("\n");
    const sequence = lines[0] || "";
    const timecode = lines[1] || "";
    const textLines = lines.slice(2);
    const timeMatch = timecode.match(TIMECODE_PATTERN);
    const start = timeMatch ? parseTimestamp(timeMatch[1]) : null;
    const end = timeMatch ? parseTimestamp(timeMatch[2]) : null;
    const joinedText = textLines.join(" ").trim();

    return {
      blockIndex: index + 1,
      raw: rawBlock,
      sequence,
      sequenceNumber: /^\d+$/.test(sequence) ? Number(sequence) : null,
      timecode,
      start,
      end,
      durationMs: start !== null && end !== null ? end - start : null,
      textLines,
      text: joinedText,
      normalizedText: normalizeForComparison(joinedText),
    };
  });
}

function findRepeatedRun(text) {
  const normalized = normalizeForComparison(text);
  if (normalized.length < 6) {
    return null;
  }

  const maxUnitLength = Math.min(12, Math.floor(normalized.length / 3));
  for (let unitLength = 2; unitLength <= maxUnitLength; unitLength += 1) {
    for (let start = 0; start <= normalized.length - unitLength * 3; start += 1) {
      const unit = normalized.slice(start, start + unitLength);
      let repeats = 1;
      while (
        normalized.slice(start + repeats * unitLength, start + (repeats + 1) * unitLength) === unit
      ) {
        repeats += 1;
      }
      if (repeats >= 3) {
        return { unit, repeats };
      }
    }
  }

  return null;
}

function addIssue(issues, block, type, detail, severity = "medium") {
  issues.push({
    type,
    severity,
    blockIndex: block.blockIndex,
    detail,
  });
}

function collectIssues(blocks, options = {}) {
  const expectCorrected = options.expectCorrected === true;
  const issues = [];
  const lastSeenText = new Map();

  blocks.forEach((block, index) => {
    const textLineCount = block.textLines.filter((line) => line.trim()).length;
    const textLength = [...block.text].length;
    const previousBlock = blocks[index - 1];

    if (block.sequenceNumber === null) {
      addIssue(issues, block, "invalid-sequence", `Sequence is not numeric: ${JSON.stringify(block.sequence)}`, "high");
    } else if (block.sequenceNumber !== block.blockIndex) {
      addIssue(issues, block, "non-sequential-numbering", `Expected ${block.blockIndex}, got ${block.sequenceNumber}`, "high");
    }

    if (block.start === null || block.end === null) {
      addIssue(issues, block, "invalid-timecode", `Could not parse timecode: ${JSON.stringify(block.timecode)}`, "high");
    }

    if (block.durationMs !== null && block.durationMs < 0) {
      addIssue(issues, block, "negative-duration", `Duration is ${block.durationMs}ms`, "high");
    }

    if (previousBlock && previousBlock.end !== null && block.start !== null && block.start < previousBlock.end) {
      addIssue(
        issues,
        block,
        "overlap",
        `Starts ${msToSrt(previousBlock.end - block.start)} before previous block ends`,
        "high"
      );
    }

    if (textLineCount === 0) {
      addIssue(issues, block, "empty-text", "Subtitle block has no text", "high");
    }

    if (expectCorrected && textLineCount !== 1) {
      addIssue(issues, block, "unexpected-text-line-count", `Expected 1 text line, got ${textLineCount}`, "high");
    } else if (!expectCorrected && textLineCount >= 3) {
      addIssue(issues, block, "fragmented-lines", `Block has ${textLineCount} text lines`);
    }

    if (textLength >= 60) {
      addIssue(issues, block, "oversized-block", `Block contains ${textLength} characters`);
    }

    if (block.durationMs !== null && block.durationMs > 0) {
      const charsPerSecond = textLength / (block.durationMs / 1000);
      if (textLength >= 18 && charsPerSecond >= 12) {
        addIssue(
          issues,
          block,
          "high-character-density",
          `${charsPerSecond.toFixed(1)} characters/second over ${block.durationMs}ms`
        );
      }
    }

    if (textLength >= 70 && block.durationMs !== null && block.durationMs >= 6000) {
      addIssue(issues, block, "possible-merged-block", "Long text and duration may contain merged utterances");
    }

    if (/\uFFFD|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(block.text)) {
      addIssue(issues, block, "garbled-character", "Contains replacement or control characters", "high");
    }

    const repeatedRun = findRepeatedRun(block.text);
    if (repeatedRun) {
      addIssue(
        issues,
        block,
        "possible-hallucination-loop",
        `Repeated sequence ${JSON.stringify(repeatedRun.unit)} appears ${repeatedRun.repeats} times`,
        "high"
      );
    }

    if (block.normalizedText) {
      const previousIndex = lastSeenText.get(block.normalizedText);
      if (previousIndex !== undefined) {
        const distance = block.blockIndex - previousIndex;
        addIssue(
          issues,
          block,
          distance === 1 ? "duplicate-consecutive-text" : "duplicate-nearby-text",
          `Text repeats block ${previousIndex}`,
          distance === 1 ? "high" : "medium"
        );
      }
      lastSeenText.set(block.normalizedText, block.blockIndex);
    }

    if (block.durationMs !== null && block.durationMs <= 1500 && textLength >= 24) {
      const followingText = blocks
        .slice(index + 1, index + 7)
        .map((candidate) => candidate.normalizedText)
        .join("");
      if (block.normalizedText.length >= 16 && followingText.includes(block.normalizedText)) {
        addIssue(
          issues,
          block,
          "flash-duplicate-ahead",
          "Short block is duplicated by following normally segmented blocks",
          "high"
        );
      }
    }
  });

  return issues;
}

function buildSummary(filePath, blocks, issues) {
  const durations = blocks.map((block) => block.durationMs).filter(Number.isFinite);
  const textLengths = blocks.map((block) => [...block.text].length);
  const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
  const issueCounts = {};
  const severityCounts = {};

  for (const issue of issues) {
    issueCounts[issue.type] = (issueCounts[issue.type] || 0) + 1;
    severityCounts[issue.severity] = (severityCounts[issue.severity] || 0) + 1;
  }

  return {
    file: path.resolve(filePath),
    blockCount: blocks.length,
    firstSequence: blocks[0]?.sequence ?? null,
    lastSequence: blocks.at(-1)?.sequence ?? null,
    avgDurationMs: durations.length ? Math.round(totalDurationMs / durations.length) : 0,
    maxTextLength: textLengths.length ? Math.max(...textLengths) : 0,
    issueCounts,
    severityCounts,
  };
}

function printInspect(summary, issues) {
  console.log(`File: ${summary.file}`);
  console.log(`Blocks: ${summary.blockCount}`);
  console.log(`First sequence: ${summary.firstSequence ?? "-"}`);
  console.log(`Last sequence: ${summary.lastSequence ?? "-"}`);
  console.log(`Average duration: ${summary.avgDurationMs}ms`);
  console.log(`Max text length: ${summary.maxTextLength}`);
  console.log(`Risk findings: ${issues.length}`);
  console.log("");

  if (issues.length === 0) {
    console.log("No structural or heuristic ASR risks detected.");
    return;
  }

  console.log("Issue counts:");
  for (const type of Object.keys(summary.issueCounts).sort()) {
    console.log(`- ${type}: ${summary.issueCounts[type]}`);
  }

  console.log("");
  console.log("Flagged blocks:");
  for (const issue of issues) {
    console.log(`- block ${issue.blockIndex}: [${issue.severity}] ${issue.type} - ${issue.detail}`);
  }
}

function issuesByBlock(issues) {
  const grouped = new Map();
  for (const issue of issues) {
    const current = grouped.get(issue.blockIndex) || [];
    current.push(issue);
    grouped.set(issue.blockIndex, current);
  }
  return grouped;
}

function riskScoreForIssues(issues) {
  return Math.min(
    10,
    issues.reduce((score, issue) => score + (ISSUE_WEIGHTS[issue.severity] || 1), 0)
  );
}

function exportTemplate(sourceText, blocks, sourcePath) {
  const issues = collectIssues(blocks);
  const blockRisks = issuesByBlock(issues);

  return {
    schemaVersion: 3,
    sourceFile: path.resolve(sourcePath),
    sourceSha256: sha256(sourceText),
    generatedAt: new Date().toISOString(),
    blockCount: blocks.length,
    audioAvailable: null,
    audioSource: "",
    speakers: [],
    glossary: [],
    systematicPatterns: [],
    blocks: blocks.map((block) => {
      const blockIssues = blockRisks.get(block.blockIndex) || [];
      return {
        blockIndex: block.blockIndex,
        sequenceNumber: block.sequenceNumber ?? block.blockIndex,
        timecode: block.timecode,
        sourceTextLines: block.textLines,
        sourceText: block.text,
        riskFlags: blockIssues.map((issue) => issue.type),
        riskScore: riskScoreForIssues(blockIssues),
        speaker: "",
        correctedJapanese: block.textLines.join(" ").trim(),
        candidateReadings: [],
        changeTypes: [],
        confidence: "unreviewed",
        evidence: [],
        audioReview: {
          status: "not-reviewed",
          notes: "",
        },
        overcorrectionReview: {
          status: "not-reviewed",
          notes: "",
        },
        notes: "",
      };
    }),
  };
}

function assertTemplateShape(template) {
  if (!template || typeof template !== "object" || !Array.isArray(template.blocks)) {
    throw new Error("Template JSON must be an object with a blocks array.");
  }
}

function validateEvidence(label, evidence) {
  if (!Array.isArray(evidence)) {
    throw new Error(`${label}.evidence must be an array.`);
  }

  evidence.forEach((item, index) => {
    const evidenceLabel = `${label}.evidence[${index}]`;
    if (typeof item === "string") {
      if (!item.trim()) {
        throw new Error(`${evidenceLabel} must not be empty.`);
      }
      return;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${evidenceLabel} must be a string or evidence object.`);
    }
    if (!EVIDENCE_TYPES.has(item.type)) {
      throw new Error(`${evidenceLabel}.type is not a supported evidence type.`);
    }
    if (typeof item.detail !== "string" || !item.detail.trim()) {
      throw new Error(`${evidenceLabel}.detail must be non-empty.`);
    }
  });
}

function validateReviewField(label, review, allowedStatuses) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new Error(`${label} must be an object.`);
  }
  if (!allowedStatuses.has(review.status)) {
    throw new Error(`${label}.status is not supported.`);
  }
  if (review.notes !== undefined && typeof review.notes !== "string") {
    throw new Error(`${label}.notes must be a string.`);
  }
}

function validateTemplateBlocks(template, requireReviewed = false) {
  assertTemplateShape(template);
  const structuredReview = Number(template.schemaVersion) >= 3;

  if (structuredReview) {
    if (![null, true, false].includes(template.audioAvailable)) {
      throw new Error("audioAvailable must be null, true, or false.");
    }
    if (typeof template.audioSource !== "string") {
      throw new Error("audioSource must be a string.");
    }
    for (const field of ["speakers", "glossary", "systematicPatterns"]) {
      if (!Array.isArray(template[field])) {
        throw new Error(`${field} must be an array.`);
      }
    }
  }
  if (structuredReview && requireReviewed && typeof template.audioAvailable !== "boolean") {
    throw new Error("audioAvailable must be set to true or false before writing output.");
  }

  template.blocks.forEach((block, index) => {
    const label = `blocks[${index}]`;
    if (!Number.isInteger(block.sequenceNumber) || block.sequenceNumber <= 0) {
      throw new Error(`${label}.sequenceNumber must be a positive integer.`);
    }
    if (typeof block.timecode !== "string" || !TIMECODE_PATTERN.test(block.timecode)) {
      throw new Error(`${label}.timecode is not a valid SRT timecode.`);
    }
    if (typeof block.correctedJapanese !== "string" || block.correctedJapanese.trim() === "") {
      throw new Error(`${label}.correctedJapanese must be non-empty.`);
    }
    if (/\r|\n/.test(block.correctedJapanese)) {
      throw new Error(`${label}.correctedJapanese must contain exactly one text line.`);
    }
    if (requireReviewed && !CONFIDENCE_LEVELS.has(block.confidence)) {
      throw new Error(`${label}.confidence must be high, medium, or low before writing output.`);
    }
    if (block.confidence === "low" && (!block.notes || !block.notes.trim())) {
      throw new Error(`${label}.notes must explain low-confidence wording.`);
    }
    if (!structuredReview && block.evidence !== undefined) {
      validateEvidence(label, block.evidence);
    }

    if (structuredReview) {
      if (!Array.isArray(block.riskFlags) || block.riskFlags.some((item) => typeof item !== "string")) {
        throw new Error(`${label}.riskFlags must contain only strings.`);
      }
      if (!Number.isInteger(block.riskScore) || block.riskScore < 0 || block.riskScore > 10) {
        throw new Error(`${label}.riskScore must be an integer from 0 to 10.`);
      }
      if (typeof block.speaker !== "string") {
        throw new Error(`${label}.speaker must be a string.`);
      }
      if (!Array.isArray(block.candidateReadings) || block.candidateReadings.some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`${label}.candidateReadings must contain only non-empty strings.`);
      }
      if (!Array.isArray(block.changeTypes) || block.changeTypes.some((item) => !CHANGE_TYPES.has(item))) {
        throw new Error(`${label}.changeTypes contains an unsupported change type.`);
      }
      validateEvidence(label, block.evidence);
      validateReviewField(`${label}.audioReview`, block.audioReview, AUDIO_REVIEW_STATUSES);
      validateReviewField(
        `${label}.overcorrectionReview`,
        block.overcorrectionReview,
        OVERCORRECTION_REVIEW_STATUSES
      );

      const changed =
        normalizeForChangeDetection(block.sourceText || "") !==
        normalizeForChangeDetection(block.correctedJapanese);
      if (requireReviewed && changed && block.evidence.length === 0) {
        throw new Error(`${label}.evidence must explain every material change.`);
      }
      if (requireReviewed && changed && block.changeTypes.length === 0) {
        throw new Error(`${label}.changeTypes must classify every material change.`);
      }
      if (requireReviewed && changed && block.overcorrectionReview.status !== "pass") {
        throw new Error(`${label}.overcorrectionReview must pass before writing output.`);
      }
      if (
        requireReviewed &&
        template.audioAvailable === true &&
        block.riskScore >= 5 &&
        block.audioReview.status === "not-reviewed"
      ) {
        throw new Error(`${label}.audioReview must resolve high-risk audio when audio is available.`);
      }
      if (
        requireReviewed &&
        ["reviewed-unclear", "not-needed"].includes(block.audioReview.status) &&
        !block.audioReview.notes.trim()
      ) {
        throw new Error(`${label}.audioReview.notes must explain ${block.audioReview.status}.`);
      }
    }
  });
}

function getSourceIntegrity(template) {
  if (!template.sourceFile || !template.sourceSha256) {
    return "not-recorded";
  }
  if (!fs.existsSync(template.sourceFile)) {
    return "source-missing";
  }
  return sha256(readText(template.sourceFile)) === template.sourceSha256 ? "match" : "mismatch";
}

function buildTemplateAudit(template) {
  validateTemplateBlocks(template, false);
  const structuredReview = Number(template.schemaVersion) >= 3;
  const confidenceCounts = { high: 0, medium: 0, low: 0, unreviewed: 0 };
  const unreviewedBlocks = [];
  const lowConfidenceBlocks = [];
  const riskyUnreviewedBlocks = [];
  const changedBlocks = [];
  const changedMissingEvidence = [];
  const changedMissingChangeTypes = [];
  const changedPendingOvercorrection = [];
  const highRiskPendingAudio = [];
  const audioReviewMissingNotes = [];
  const sourceIntegrity = getSourceIntegrity(template);

  for (const block of template.blocks) {
    const confidence = CONFIDENCE_LEVELS.has(block.confidence) ? block.confidence : "unreviewed";
    confidenceCounts[confidence] += 1;
    if (confidence === "unreviewed") {
      unreviewedBlocks.push(block.blockIndex);
      if (Array.isArray(block.riskFlags) && block.riskFlags.length > 0) {
        riskyUnreviewedBlocks.push(block.blockIndex);
      }
    }
    if (confidence === "low") {
      lowConfidenceBlocks.push(block.blockIndex);
    }
    const changed =
      normalizeForChangeDetection(block.sourceText || "") !==
      normalizeForChangeDetection(block.correctedJapanese);
    if (changed) {
      changedBlocks.push(block.blockIndex);
      if (structuredReview && block.evidence.length === 0) {
        changedMissingEvidence.push(block.blockIndex);
      }
      if (structuredReview && block.changeTypes.length === 0) {
        changedMissingChangeTypes.push(block.blockIndex);
      }
      if (structuredReview && block.overcorrectionReview.status !== "pass") {
        changedPendingOvercorrection.push(block.blockIndex);
      }
    }
    if (
      structuredReview &&
      template.audioAvailable === true &&
      block.riskScore >= 5 &&
      block.audioReview.status === "not-reviewed"
    ) {
      highRiskPendingAudio.push(block.blockIndex);
    }
    if (
      structuredReview &&
      ["reviewed-unclear", "not-needed"].includes(block.audioReview.status) &&
      !block.audioReview.notes.trim()
    ) {
      audioReviewMissingNotes.push(block.blockIndex);
    }
  }

  const audioAvailabilityResolved = !structuredReview || typeof template.audioAvailable === "boolean";
  const sourceIntegrityResolved = structuredReview
    ? sourceIntegrity === "match"
    : sourceIntegrity !== "mismatch";

  return {
    schemaVersion: template.schemaVersion ?? 1,
    blockCount: template.blocks.length,
    changedBlockCount: changedBlocks.length,
    unchangedBlockCount: template.blocks.length - changedBlocks.length,
    confidenceCounts,
    unreviewedBlocks,
    riskyUnreviewedBlocks,
    lowConfidenceBlocks,
    changedBlocks,
    changedMissingEvidence,
    changedMissingChangeTypes,
    changedPendingOvercorrection,
    highRiskPendingAudio,
    audioReviewMissingNotes,
    audioAvailable: template.audioAvailable ?? null,
    audioAvailabilityResolved,
    sourceIntegrity,
    sourceIntegrityResolved,
    readyToWrite:
      unreviewedBlocks.length === 0 &&
      sourceIntegrityResolved &&
      audioAvailabilityResolved &&
      changedMissingEvidence.length === 0 &&
      changedMissingChangeTypes.length === 0 &&
      changedPendingOvercorrection.length === 0 &&
      highRiskPendingAudio.length === 0 &&
      audioReviewMissingNotes.length === 0,
  };
}

function renderCorrectedSrt(template) {
  validateTemplateBlocks(template, true);
  return `${template.blocks
    .map((block, index) => [String(index + 1), block.timecode, block.correctedJapanese.trim()].join("\n"))
    .join("\n\n")}\n`;
}

function printAudit(audit) {
  console.log(`Template schema: ${audit.schemaVersion}`);
  console.log(`Blocks: ${audit.blockCount}`);
  console.log(`Changed: ${audit.changedBlockCount}`);
  console.log(`Unchanged: ${audit.unchangedBlockCount}`);
  console.log(`Confidence: high=${audit.confidenceCounts.high}, medium=${audit.confidenceCounts.medium}, low=${audit.confidenceCounts.low}, unreviewed=${audit.confidenceCounts.unreviewed}`);
  console.log(`Source integrity: ${audit.sourceIntegrity}`);
  console.log(`Audio available: ${audit.audioAvailable === null ? "not-set" : audit.audioAvailable ? "yes" : "no"}`);
  console.log(`Ready to write: ${audit.readyToWrite ? "yes" : "no"}`);
  if (audit.unreviewedBlocks.length) {
    console.log(`Unreviewed blocks: ${audit.unreviewedBlocks.join(", ")}`);
  }
  if (audit.riskyUnreviewedBlocks.length) {
    console.log(`Risky unreviewed blocks: ${audit.riskyUnreviewedBlocks.join(", ")}`);
  }
  if (audit.lowConfidenceBlocks.length) {
    console.log(`Low-confidence blocks: ${audit.lowConfidenceBlocks.join(", ")}`);
  }
  if (audit.changedMissingEvidence.length) {
    console.log(`Changed blocks missing evidence: ${audit.changedMissingEvidence.join(", ")}`);
  }
  if (audit.changedMissingChangeTypes.length) {
    console.log(`Changed blocks missing change types: ${audit.changedMissingChangeTypes.join(", ")}`);
  }
  if (audit.changedPendingOvercorrection.length) {
    console.log(`Changed blocks pending overcorrection review: ${audit.changedPendingOvercorrection.join(", ")}`);
  }
  if (audit.highRiskPendingAudio.length) {
    console.log(`High-risk blocks pending audio review: ${audit.highRiskPendingAudio.join(", ")}`);
  }
  if (audit.audioReviewMissingNotes.length) {
    console.log(`Audio review dispositions missing notes: ${audit.audioReviewMissingNotes.join(", ")}`);
  }
}

function buildComparison(sourcePath, sourceBlocks, outputPath, outputBlocks) {
  const issues = [];
  const maxBlocks = Math.max(sourceBlocks.length, outputBlocks.length);
  let textChangedBlocks = 0;
  let timingChangedBlocks = 0;

  if (sourceBlocks.length !== outputBlocks.length) {
    issues.push({
      type: "block-count-mismatch",
      detail: `Source has ${sourceBlocks.length} blocks; output has ${outputBlocks.length}`,
    });
  }

  for (let index = 0; index < maxBlocks; index += 1) {
    const source = sourceBlocks[index];
    const output = outputBlocks[index];
    if (!source || !output) {
      continue;
    }
    if (source.timecode !== output.timecode) {
      timingChangedBlocks += 1;
      issues.push({
        type: "timecode-changed",
        blockIndex: index + 1,
        detail: `${source.timecode} -> ${output.timecode}`,
      });
    }
    if (normalizeForChangeDetection(source.text) !== normalizeForChangeDetection(output.text)) {
      textChangedBlocks += 1;
    }
  }

  return {
    sourceFile: path.resolve(sourcePath),
    outputFile: path.resolve(outputPath),
    sourceBlockCount: sourceBlocks.length,
    outputBlockCount: outputBlocks.length,
    blockCountsMatch: sourceBlocks.length === outputBlocks.length,
    textChangedBlocks,
    timingChangedBlocks,
    finalBlockPresent: outputBlocks.length > 0 && outputBlocks.at(-1).text.trim() !== "",
    issues,
  };
}

function printComparison(comparison) {
  console.log(`Source blocks: ${comparison.sourceBlockCount}`);
  console.log(`Output blocks: ${comparison.outputBlockCount}`);
  console.log(`Block counts match: ${comparison.blockCountsMatch ? "yes" : "no"}`);
  console.log(`Text-changed blocks: ${comparison.textChangedBlocks}`);
  console.log(`Timing-changed blocks: ${comparison.timingChangedBlocks}`);
  console.log(`Final block present: ${comparison.finalBlockPresent ? "yes" : "no"}`);
  if (comparison.issues.length) {
    console.log("Comparison issues:");
    for (const issue of comparison.issues) {
      const block = issue.blockIndex ? ` block ${issue.blockIndex}:` : "";
      console.log(`- ${issue.type}:${block} ${issue.detail}`);
    }
  }
}

function runInspect(filePath, jsonMode) {
  const blocks = parseSrt(readText(filePath));
  const issues = collectIssues(blocks);
  const summary = buildSummary(filePath, blocks, issues);
  if (jsonMode) {
    console.log(JSON.stringify({ summary, issues, blocks }, null, 2));
  } else {
    printInspect(summary, issues);
  }
}

function runExportTemplate(inputPath, outputPath) {
  const sourceText = readText(inputPath);
  const blocks = parseSrt(sourceText);
  const template = exportTemplate(sourceText, blocks, inputPath);
  writeText(outputPath, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`Template written: ${path.resolve(outputPath)}`);
}

function runAuditTemplate(templatePath, jsonMode) {
  const audit = buildTemplateAudit(readJson(templatePath));
  if (jsonMode) {
    console.log(JSON.stringify(audit, null, 2));
  } else {
    printAudit(audit);
  }
}

function runWriteCorrected(templatePath, outputPath) {
  const template = readJson(templatePath);
  const audit = buildTemplateAudit(template);
  if (audit.sourceIntegrity === "mismatch") {
    throw new Error("Source SRT changed after template export. Export a new template before writing.");
  }
  if (!audit.readyToWrite) {
    throw new Error("Template is not ready to write. Run audit-template and resolve every reported item.");
  }
  writeText(outputPath, renderCorrectedSrt(template));
  console.log(`Wrote corrected Japanese SRT: ${path.resolve(outputPath)}`);
}

function runValidate(filePath, jsonMode) {
  const blocks = parseSrt(readText(filePath));
  const issues = collectIssues(blocks, { expectCorrected: true });
  const summary = buildSummary(filePath, blocks, issues);
  if (jsonMode) {
    console.log(JSON.stringify({ summary, issues, blocks }, null, 2));
  } else {
    printInspect(summary, issues);
  }
}

function runCompare(sourcePath, outputPath, jsonMode) {
  const sourceBlocks = parseSrt(readText(sourcePath));
  const outputBlocks = parseSrt(readText(outputPath));
  const comparison = buildComparison(sourcePath, sourceBlocks, outputPath, outputBlocks);
  if (jsonMode) {
    console.log(JSON.stringify(comparison, null, 2));
  } else {
    printComparison(comparison);
  }
}

function runAnalyzeSilence(srtPath, mediaPath, outputPath, optionArgs) {
  if (!fs.existsSync(srtPath)) {
    throw new Error(`SRT file does not exist: ${path.resolve(srtPath)}`);
  }
  if (!fs.existsSync(mediaPath)) {
    throw new Error(`Audio or video file does not exist: ${path.resolve(mediaPath)}`);
  }
  const settings = parseSilenceOptions(optionArgs);
  const blocks = parseSrt(readText(srtPath));
  const durationMs = probeDurationMs(mediaPath);
  const silenceIntervals = detectSilenceIntervals(
    mediaPath,
    durationMs,
    settings.noiseDb,
    settings.minSilenceSeconds
  );
  const findings = buildSilenceTimingReport(blocks, silenceIntervals, settings);
  const report = {
    schemaVersion: 1,
    sourceSrt: path.resolve(srtPath),
    mediaFile: path.resolve(mediaPath),
    generatedAt: new Date().toISOString(),
    durationMs,
    settings,
    limitations: [
      "Amplitude silence is not the same as absence of speech.",
      "Background music or noise can hide speech-free regions.",
      "Suggestions require listening review before changing timestamps or removing blocks.",
    ],
    summary: {
      blockCount: blocks.length,
      silenceIntervalCount: silenceIntervals.length,
      findingCount: findings.length,
      fullySilentBlockCount: findings.filter((finding) => finding.fullySilent).length,
      suggestedTimingCount: findings.filter((finding) => finding.suggestedTimecode).length,
    },
    silenceIntervals,
    findings,
  };
  writeText(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Silence timing report written: ${path.resolve(outputPath)}`);
  console.log(`Findings: ${report.summary.findingCount}`);
  console.log(`Fully silent blocks: ${report.summary.fullySilentBlockCount}`);
  console.log(`Timing suggestions: ${report.summary.suggestedTimingCount}`);
}

function main(argv) {
  const [command, ...args] = argv.slice(2);
  const jsonMode = args.includes("--json");
  const positionals = args.filter((value) => value !== "--json");

  try {
    if (command === "inspect" || command === "dump-json") {
      if (!positionals[0]) {
        throw new Error("A source SRT path is required.");
      }
      runInspect(positionals[0], command === "dump-json" || jsonMode);
      return;
    }
    if (command === "export-template") {
      if (!positionals[0] || !positionals[1]) {
        throw new Error("Source SRT and output JSON paths are required.");
      }
      runExportTemplate(positionals[0], positionals[1]);
      return;
    }
    if (command === "audit-template") {
      if (!positionals[0]) {
        throw new Error("A template JSON path is required.");
      }
      runAuditTemplate(positionals[0], jsonMode);
      return;
    }
    if (command === "write-corrected") {
      if (!positionals[0] || !positionals[1]) {
        throw new Error("Template JSON and output SRT paths are required.");
      }
      runWriteCorrected(positionals[0], positionals[1]);
      return;
    }
    if (command === "validate") {
      if (!positionals[0]) {
        throw new Error("An SRT path is required.");
      }
      runValidate(positionals[0], jsonMode);
      return;
    }
    if (command === "compare") {
      if (!positionals[0] || !positionals[1]) {
        throw new Error("Source and corrected SRT paths are required.");
      }
      runCompare(positionals[0], positionals[1], jsonMode);
      return;
    }
    if (command === "analyze-silence") {
      const [srtPath, mediaPath, outputPath, ...optionArgs] = args;
      if (!srtPath || !mediaPath || !outputPath) {
        throw new Error("SRT, audio/video, and output JSON paths are required.");
      }
      runAnalyzeSilence(srtPath, mediaPath, outputPath, optionArgs);
      return;
    }

    printUsage();
    process.exitCode = 1;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main(process.argv);
