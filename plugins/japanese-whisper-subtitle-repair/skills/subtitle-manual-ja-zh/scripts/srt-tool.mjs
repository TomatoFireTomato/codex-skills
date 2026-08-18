#!/usr/bin/env node

import crypto from "crypto";
import fs from "fs";
import os from "node:os";
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
const WORKFLOW_PHASES = ["triage", "initial-reviewed", "drafted", "reverse-reviewed", "frozen"];
const STRICT_TIMELINE_POLICY = "preserve-source-exactly";
const AUDIO_CRITICAL_RISK_FLAGS = new Set([
  "garbled-character",
  "possible-hallucination-loop",
  "duplicate-consecutive-text",
  "duplicate-nearby-text",
  "flash-duplicate-ahead",
]);
const AUDIO_CRITICAL_CHANGE_TYPES = new Set([
  "asr-homophone",
  "hallucination",
  "duplicate",
]);
const WORKSPACE_ROOT = path.join(os.tmpdir(), "japanese-whisper-subtitle-repair");
const WORKSPACE_MARKER = ".srt-repair-workspace.json";
const WORKSPACE_CREATED_BY = "japanese-whisper-subtitle-repair/srt-tool.mjs";

function printUsage() {
  console.log(`Usage:
  node <skill-dir>/scripts/srt-tool.mjs inspect <file.srt> [--json]
  node <skill-dir>/scripts/srt-tool.mjs dump-json <file.srt> [output.json]
  node <skill-dir>/scripts/srt-tool.mjs create-workdir [label]
  node <skill-dir>/scripts/srt-tool.mjs cleanup-workdir <directory>
  node <skill-dir>/scripts/srt-tool.mjs export-template <file.srt> <output.json>
  node <skill-dir>/scripts/srt-tool.mjs accept-low-risk <template.json>
  node <skill-dir>/scripts/srt-tool.mjs advance-workflow <template.json> <phase>
  node <skill-dir>/scripts/srt-tool.mjs audit-template <template.json> [--json]
  node <skill-dir>/scripts/srt-tool.mjs write-corrected <template.json> <output.srt>
  node <skill-dir>/scripts/srt-tool.mjs validate <file.srt> [--json]
  node <skill-dir>/scripts/srt-tool.mjs compare <source.srt> <corrected.srt> [output.json] [--json]

Commands:
  inspect          Summarize structure and flag likely ASR risks.
  dump-json        Output parsed blocks, summary, and risk findings as JSON.
  create-workdir   Create a marked task directory below the system temp directory.
  cleanup-workdir  Safely remove a marked task directory created by this tool.
  export-template  Export a correction template with risk and confidence fields.
  accept-low-risk  Batch-dispose unchanged blocks with no detected risk flags.
  advance-workflow Move a schema-v4+ template to its next bounded workflow phase.
  audit-template   Audit review coverage, confidence, and raw/corrected changes.
  write-corrected  Write a reviewed Japanese-only corrected SRT.
  validate         Validate a Japanese-only corrected SRT.
  compare          Compare source and output block counts, timing, and text changes.
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

function sanitizeWorkspaceLabel(value) {
  const sanitized = String(value || "task")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return sanitized || "task";
}

function runCreateWorkdir(label) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
  const prefix = `${sanitizeWorkspaceLabel(label)}-`;
  const directory = fs.mkdtempSync(path.join(WORKSPACE_ROOT, prefix));
  const runtimeScript = path.join(directory, "srt-tool.mjs");
  fs.copyFileSync(fs.realpathSync(process.argv[1]), runtimeScript);
  fs.chmodSync(runtimeScript, 0o755);
  const marker = {
    schemaVersion: 1,
    createdBy: WORKSPACE_CREATED_BY,
    createdAt: new Date().toISOString(),
    runtimeScript,
    runtimeSha256: sha256(readText(runtimeScript)),
  };
  writeText(path.join(directory, WORKSPACE_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  console.log(directory);
}

function assertManagedWorkdir(directory) {
  const resolvedRoot = path.resolve(WORKSPACE_ROOT);
  const resolvedDirectory = path.resolve(directory);
  if (resolvedDirectory === resolvedRoot || path.dirname(resolvedDirectory) !== resolvedRoot) {
    throw new Error(`Refusing to clean an unmanaged directory: ${resolvedDirectory}`);
  }
  if (!fs.existsSync(resolvedDirectory) || fs.lstatSync(resolvedDirectory).isSymbolicLink()) {
    throw new Error(`Managed work directory does not exist: ${resolvedDirectory}`);
  }
  const markerPath = path.join(resolvedDirectory, WORKSPACE_MARKER);
  if (!fs.existsSync(markerPath) || !fs.lstatSync(markerPath).isFile()) {
    throw new Error(`Refusing to clean a directory without ${WORKSPACE_MARKER}.`);
  }
  const marker = readJson(markerPath);
  if (marker.createdBy !== WORKSPACE_CREATED_BY || marker.schemaVersion !== 1) {
    throw new Error("Refusing to clean a directory with an invalid workspace marker.");
  }
  return resolvedDirectory;
}

function runCleanupWorkdir(directory) {
  const resolvedDirectory = assertManagedWorkdir(directory);
  fs.rmSync(resolvedDirectory, { recursive: true, force: false });
  console.log(`Removed temporary workspace: ${resolvedDirectory}`);
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

function requiresAudioReview(block) {
  const hasAuthoritativeTextEvidence = block.evidence?.some((item) =>
    item && typeof item === "object" && ["official-transcript", "official-name"].includes(item.type)
  );
  const hasCriticalRisk = block.riskFlags?.some((flag) => AUDIO_CRITICAL_RISK_FLAGS.has(flag));
  const hasCriticalNonHomophoneChange = block.changeTypes?.some((type) =>
    ["hallucination", "duplicate"].includes(type)
  );
  if (
    hasAuthoritativeTextEvidence &&
    !hasCriticalRisk &&
    !hasCriticalNonHomophoneChange &&
    !(block.candidateReadings?.length > 1)
  ) {
    return false;
  }
  return (
    block.candidateReadings?.length > 1 ||
    hasCriticalRisk ||
    block.changeTypes?.some((type) => AUDIO_CRITICAL_CHANGE_TYPES.has(type))
  );
}

function correctedContentSha256(template) {
  const content = template.blocks.map((block) => ({
    blockIndex: block.blockIndex,
    timecode: block.timecode,
    correctedJapanese: block.correctedJapanese,
  }));
  return sha256(JSON.stringify(content));
}

function exportTemplate(sourceText, blocks, sourcePath) {
  const issues = collectIssues(blocks);
  const blockRisks = issuesByBlock(issues);
  const generatedAt = new Date().toISOString();

  return {
    schemaVersion: 5,
    sourceFile: path.resolve(sourcePath),
    sourceSha256: sha256(sourceText),
    timingPolicy: STRICT_TIMELINE_POLICY,
    generatedAt,
    blockCount: blocks.length,
    audioAvailable: null,
    audioSource: "",
    speakers: [],
    glossary: [],
    systematicPatterns: [],
    workflow: {
      phase: "triage",
      history: [{ phase: "triage", at: generatedAt }],
      frozenContentSha256: "",
    },
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

function inspectStrictTimeline(template) {
  if (Number(template.schemaVersion) < 5) {
    return {
      policy: "legacy",
      preserved: null,
      issues: [],
    };
  }

  const issues = [];
  if (template.timingPolicy !== STRICT_TIMELINE_POLICY) {
    issues.push(`timingPolicy must be ${STRICT_TIMELINE_POLICY}.`);
  }
  if (!template.sourceFile || !fs.existsSync(template.sourceFile)) {
    issues.push("Source SRT is unavailable for strict timeline verification.");
    return { policy: template.timingPolicy, preserved: false, issues };
  }
  if (getSourceIntegrity(template) !== "match") {
    issues.push("Source SRT changed after template export.");
    return { policy: template.timingPolicy, preserved: false, issues };
  }

  const sourceBlocks = parseSrt(readText(template.sourceFile));
  if (template.blocks.length !== sourceBlocks.length) {
    issues.push(
      `Block count changed: source=${sourceBlocks.length}, template=${template.blocks.length}.`
    );
  }
  if (template.blockCount !== sourceBlocks.length) {
    issues.push(
      `Recorded blockCount does not match source: source=${sourceBlocks.length}, template=${template.blockCount}.`
    );
  }

  const sharedCount = Math.min(template.blocks.length, sourceBlocks.length);
  for (let index = 0; index < sharedCount; index += 1) {
    const block = template.blocks[index];
    const source = sourceBlocks[index];
    if (block.blockIndex !== index + 1) {
      issues.push(`Block order changed at template position ${index + 1}.`);
    }
    if (block.timecode !== source.timecode) {
      issues.push(
        `Block ${index + 1} timecode changed: ${source.timecode} -> ${block.timecode}.`
      );
    }
  }

  return {
    policy: template.timingPolicy,
    preserved: issues.length === 0,
    issues,
  };
}

function validateTemplateBlocks(template, requireReviewed = false) {
  assertTemplateShape(template);
  const structuredReview = Number(template.schemaVersion) >= 3;
  const boundedWorkflow = Number(template.schemaVersion) >= 4;
  const strictTimeline = Number(template.schemaVersion) >= 5;

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
  if (boundedWorkflow) {
    if (!template.workflow || typeof template.workflow !== "object" || Array.isArray(template.workflow)) {
      throw new Error("workflow must be an object for schema v4 templates.");
    }
    if (!WORKFLOW_PHASES.includes(template.workflow.phase)) {
      throw new Error("workflow.phase is not supported.");
    }
    if (!Array.isArray(template.workflow.history)) {
      throw new Error("workflow.history must be an array.");
    }
    const expectedHistory = WORKFLOW_PHASES.slice(
      0,
      WORKFLOW_PHASES.indexOf(template.workflow.phase) + 1
    );
    const actualHistory = template.workflow.history.map((entry) => entry?.phase);
    if (
      actualHistory.length !== expectedHistory.length ||
      actualHistory.some((phase, index) => phase !== expectedHistory[index]) ||
      template.workflow.history.some((entry) => typeof entry?.at !== "string" || !entry.at.trim())
    ) {
      throw new Error("workflow.history must contain each phase exactly once in order.");
    }
    if (typeof template.workflow.frozenContentSha256 !== "string") {
      throw new Error("workflow.frozenContentSha256 must be a string.");
    }
    if (requireReviewed && template.workflow.phase !== "frozen") {
      throw new Error("workflow must be frozen before writing output.");
    }
    if (
      template.workflow.phase === "frozen" &&
      template.workflow.frozenContentSha256 !== correctedContentSha256(template)
    ) {
      throw new Error("Corrected text or timing changed after workflow freeze.");
    }
  }
  if (strictTimeline && template.timingPolicy !== STRICT_TIMELINE_POLICY) {
    throw new Error(`timingPolicy must be ${STRICT_TIMELINE_POLICY}.`);
  }

  template.blocks.forEach((block, index) => {
    const label = `blocks[${index}]`;
    if (!Number.isInteger(block.sequenceNumber) || block.sequenceNumber <= 0) {
      throw new Error(`${label}.sequenceNumber must be a positive integer.`);
    }
    if (typeof block.timecode !== "string" || !TIMECODE_PATTERN.test(block.timecode)) {
      throw new Error(`${label}.timecode is not a valid SRT timecode.`);
    }
    if (strictTimeline && block.blockIndex !== index + 1) {
      throw new Error(`${label}.blockIndex must preserve the original block order.`);
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
        changed &&
        block.overcorrectionReview.status === "pass" &&
        !block.overcorrectionReview.notes.trim()
      ) {
        throw new Error(`${label}.overcorrectionReview.notes must identify the reverse-review basis.`);
      }
      if (
        requireReviewed &&
        template.audioAvailable === true &&
        requiresAudioReview(block) &&
        block.audioReview.status === "not-reviewed"
      ) {
        throw new Error(`${label}.audioReview must resolve audio-critical evidence when audio is available.`);
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

  if (strictTimeline && requireReviewed) {
    const timeline = inspectStrictTimeline(template);
    if (!timeline.preserved) {
      throw new Error(`Strict source timeline was not preserved: ${timeline.issues.join(" ")}`);
    }
  }
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
  const audioCriticalPending = [];
  const audioReviewMissingNotes = [];
  const sourceIntegrity = getSourceIntegrity(template);
  const timeline = inspectStrictTimeline(template);

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
      requiresAudioReview(block) &&
      block.audioReview.status === "not-reviewed"
    ) {
      audioCriticalPending.push(block.blockIndex);
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
  const boundedWorkflow = Number(template.schemaVersion) >= 4;
  const workflowPhase = boundedWorkflow ? template.workflow.phase : "legacy";
  const freezeIntegrity = !boundedWorkflow || (
    workflowPhase === "frozen" &&
    template.workflow.frozenContentSha256 === correctedContentSha256(template)
  );

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
    audioCriticalPending,
    audioReviewMissingNotes,
    audioAvailable: template.audioAvailable ?? null,
    audioAvailabilityResolved,
    sourceIntegrity,
    sourceIntegrityResolved,
    timingPolicy: timeline.policy,
    sourceTimelinePreserved: timeline.preserved,
    sourceTimelineIssues: timeline.issues,
    workflowPhase,
    freezeIntegrity,
    readyToWrite:
      unreviewedBlocks.length === 0 &&
      sourceIntegrityResolved &&
      audioAvailabilityResolved &&
      changedMissingEvidence.length === 0 &&
      changedMissingChangeTypes.length === 0 &&
      changedPendingOvercorrection.length === 0 &&
      audioCriticalPending.length === 0 &&
      audioReviewMissingNotes.length === 0 &&
      timeline.preserved !== false &&
      freezeIntegrity,
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
  console.log(`Timing policy: ${audit.timingPolicy}`);
  console.log(`Source timeline preserved: ${audit.sourceTimelinePreserved === null ? "legacy" : audit.sourceTimelinePreserved ? "yes" : "no"}`);
  console.log(`Audio available: ${audit.audioAvailable === null ? "not-set" : audit.audioAvailable ? "yes" : "no"}`);
  console.log(`Workflow phase: ${audit.workflowPhase}`);
  console.log(`Freeze integrity: ${audit.freezeIntegrity ? "yes" : "no"}`);
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
  if (audit.audioCriticalPending.length) {
    console.log(`Audio-critical blocks pending review: ${audit.audioCriticalPending.join(", ")}`);
  }
  if (audit.audioReviewMissingNotes.length) {
    console.log(`Audio review dispositions missing notes: ${audit.audioReviewMissingNotes.join(", ")}`);
  }
  if (audit.sourceTimelineIssues.length) {
    console.log("Source timeline issues:");
    for (const issue of audit.sourceTimelineIssues) {
      console.log(`- ${issue}`);
    }
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
    sourceTimelinePreserved:
      sourceBlocks.length === outputBlocks.length && timingChangedBlocks === 0,
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
  console.log(`Source timeline preserved: ${comparison.sourceTimelinePreserved ? "yes" : "no"}`);
  console.log(`Final block present: ${comparison.finalBlockPresent ? "yes" : "no"}`);
  if (comparison.issues.length) {
    console.log("Comparison issues:");
    for (const issue of comparison.issues) {
      const block = issue.blockIndex ? ` block ${issue.blockIndex}:` : "";
      console.log(`- ${issue.type}:${block} ${issue.detail}`);
    }
  }
}

function runInspect(filePath, jsonMode, outputPath = null) {
  const blocks = parseSrt(readText(filePath));
  const issues = collectIssues(blocks);
  const summary = buildSummary(filePath, blocks, issues);
  if (jsonMode) {
    const serialized = `${JSON.stringify({ summary, issues, blocks }, null, 2)}\n`;
    if (outputPath) {
      writeText(outputPath, serialized);
      console.log(`Structured subtitle data written: ${path.resolve(outputPath)}`);
    } else {
      process.stdout.write(serialized);
    }
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

function runAcceptLowRisk(templatePath) {
  const template = readJson(templatePath);
  validateTemplateBlocks(template, false);
  if (Number(template.schemaVersion) < 4) {
    throw new Error("accept-low-risk requires a schema v4 template.");
  }
  if (!["triage", "initial-reviewed"].includes(template.workflow.phase)) {
    throw new Error("Low-risk blocks must be accepted before the integrated draft.");
  }

  let accepted = 0;
  for (const block of template.blocks) {
    const unchanged =
      normalizeForChangeDetection(block.sourceText || "") ===
      normalizeForChangeDetection(block.correctedJapanese);
    if (
      unchanged &&
      block.confidence === "unreviewed" &&
      block.riskScore === 0 &&
      block.riskFlags.length === 0
    ) {
      block.confidence = "medium";
      block.notes = block.notes.trim()
        ? block.notes
        : "Accepted by deterministic low-risk triage after representative sampling.";
      accepted += 1;
    }
  }

  template.lowRiskTriage = {
    acceptedAt: new Date().toISOString(),
    acceptedBlockCount: accepted,
    method: "risk-free-unchanged-blocks-after-representative-sampling",
  };
  writeText(templatePath, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`Accepted unchanged low-risk blocks: ${accepted}`);
}

function runAdvanceWorkflow(templatePath, nextPhase) {
  const template = readJson(templatePath);
  validateTemplateBlocks(template, false);
  if (Number(template.schemaVersion) < 4) {
    throw new Error("advance-workflow requires a schema v4 template.");
  }
  if (!WORKFLOW_PHASES.includes(nextPhase)) {
    throw new Error(`Unsupported workflow phase: ${nextPhase}`);
  }

  const currentIndex = WORKFLOW_PHASES.indexOf(template.workflow.phase);
  const expectedPhase = WORKFLOW_PHASES[currentIndex + 1];
  if (nextPhase !== expectedPhase) {
    throw new Error(
      expectedPhase
        ? `Workflow can only advance from ${template.workflow.phase} to ${expectedPhase}.`
        : "Workflow is already frozen and cannot advance."
    );
  }

  template.workflow.phase = nextPhase;
  template.workflow.history.push({ phase: nextPhase, at: new Date().toISOString() });
  if (nextPhase === "frozen") {
    template.workflow.frozenContentSha256 = correctedContentSha256(template);
    validateTemplateBlocks(template, true);
  }
  writeText(templatePath, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`Workflow advanced: ${nextPhase}`);
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

function runCompare(sourcePath, outputPath, jsonMode, reportPath = null) {
  const sourceBlocks = parseSrt(readText(sourcePath));
  const outputBlocks = parseSrt(readText(outputPath));
  const comparison = buildComparison(sourcePath, sourceBlocks, outputPath, outputBlocks);
  if (jsonMode) {
    const serialized = `${JSON.stringify(comparison, null, 2)}\n`;
    if (reportPath) {
      writeText(reportPath, serialized);
      console.log(`Comparison report written: ${path.resolve(reportPath)}`);
    } else {
      process.stdout.write(serialized);
    }
  } else {
    printComparison(comparison);
  }
  if (!comparison.sourceTimelinePreserved) {
    process.exitCode = 1;
  }
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
      runInspect(positionals[0], command === "dump-json" || jsonMode, positionals[1]);
      return;
    }
    if (command === "create-workdir") {
      runCreateWorkdir(positionals[0]);
      return;
    }
    if (command === "cleanup-workdir") {
      if (!positionals[0]) {
        throw new Error("A managed work directory path is required.");
      }
      runCleanupWorkdir(positionals[0]);
      return;
    }
    if (command === "export-template") {
      if (!positionals[0] || !positionals[1]) {
        throw new Error("Source SRT and output JSON paths are required.");
      }
      runExportTemplate(positionals[0], positionals[1]);
      return;
    }
    if (command === "accept-low-risk") {
      if (!positionals[0]) {
        throw new Error("A template JSON path is required.");
      }
      runAcceptLowRisk(positionals[0]);
      return;
    }
    if (command === "advance-workflow") {
      if (!positionals[0] || !positionals[1]) {
        throw new Error("A template JSON path and next workflow phase are required.");
      }
      runAdvanceWorkflow(positionals[0], positionals[1]);
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
      runCompare(positionals[0], positionals[1], jsonMode, positionals[2]);
      return;
    }
    printUsage();
    process.exitCode = 1;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main(process.argv);
