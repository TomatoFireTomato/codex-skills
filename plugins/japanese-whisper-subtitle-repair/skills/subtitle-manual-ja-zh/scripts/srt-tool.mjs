#!/usr/bin/env node

import crypto from "crypto";
import fs from "fs";
import path from "path";

const TIMECODE_PATTERN = /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/;
const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);

function printUsage() {
  console.log(`Usage:
  node <skill-dir>/scripts/srt-tool.mjs inspect <file.srt> [--json]
  node <skill-dir>/scripts/srt-tool.mjs dump-json <file.srt>
  node <skill-dir>/scripts/srt-tool.mjs export-template <file.srt> <output.json>
  node <skill-dir>/scripts/srt-tool.mjs audit-template <template.json> [--json]
  node <skill-dir>/scripts/srt-tool.mjs write-corrected <template.json> <output.srt>
  node <skill-dir>/scripts/srt-tool.mjs validate <file.srt> [--json]
  node <skill-dir>/scripts/srt-tool.mjs compare <source.srt> <corrected.srt> [--json]

Commands:
  inspect          Summarize structure and flag likely ASR risks.
  dump-json        Output parsed blocks, summary, and risk findings as JSON.
  export-template  Export a correction template with risk and confidence fields.
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
    current.push(issue.type);
    grouped.set(issue.blockIndex, current);
  }
  return grouped;
}

function exportTemplate(sourceText, blocks, sourcePath) {
  const issues = collectIssues(blocks);
  const blockRisks = issuesByBlock(issues);

  return {
    schemaVersion: 2,
    sourceFile: path.resolve(sourcePath),
    sourceSha256: sha256(sourceText),
    generatedAt: new Date().toISOString(),
    blockCount: blocks.length,
    blocks: blocks.map((block) => ({
      blockIndex: block.blockIndex,
      sequenceNumber: block.sequenceNumber ?? block.blockIndex,
      timecode: block.timecode,
      sourceTextLines: block.textLines,
      sourceText: block.text,
      riskFlags: blockRisks.get(block.blockIndex) || [],
      correctedJapanese: block.textLines.join(" ").trim(),
      confidence: "unreviewed",
      evidence: [],
      notes: "",
    })),
  };
}

function assertTemplateShape(template) {
  if (!template || typeof template !== "object" || !Array.isArray(template.blocks)) {
    throw new Error("Template JSON must be an object with a blocks array.");
  }
}

function validateTemplateBlocks(template, requireReviewed = false) {
  assertTemplateShape(template);

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
    if (block.evidence !== undefined && !Array.isArray(block.evidence)) {
      throw new Error(`${label}.evidence must be an array.`);
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
  const confidenceCounts = { high: 0, medium: 0, low: 0, unreviewed: 0 };
  const unreviewedBlocks = [];
  const lowConfidenceBlocks = [];
  const riskyUnreviewedBlocks = [];
  const changedBlocks = [];
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
    if (normalizeForComparison(block.sourceText || "") !== normalizeForComparison(block.correctedJapanese)) {
      changedBlocks.push(block.blockIndex);
    }
  }

  return {
    blockCount: template.blocks.length,
    changedBlockCount: changedBlocks.length,
    unchangedBlockCount: template.blocks.length - changedBlocks.length,
    confidenceCounts,
    unreviewedBlocks,
    riskyUnreviewedBlocks,
    lowConfidenceBlocks,
    changedBlocks,
    sourceIntegrity,
    readyToWrite: unreviewedBlocks.length === 0 && sourceIntegrity !== "mismatch",
  };
}

function renderCorrectedSrt(template) {
  validateTemplateBlocks(template, true);
  return `${template.blocks
    .map((block, index) => [String(index + 1), block.timecode, block.correctedJapanese.trim()].join("\n"))
    .join("\n\n")}\n`;
}

function printAudit(audit) {
  console.log(`Blocks: ${audit.blockCount}`);
  console.log(`Changed: ${audit.changedBlockCount}`);
  console.log(`Unchanged: ${audit.unchangedBlockCount}`);
  console.log(`Confidence: high=${audit.confidenceCounts.high}, medium=${audit.confidenceCounts.medium}, low=${audit.confidenceCounts.low}, unreviewed=${audit.confidenceCounts.unreviewed}`);
  console.log(`Source integrity: ${audit.sourceIntegrity}`);
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
    if (source.normalizedText !== output.normalizedText) {
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
    throw new Error(`Template has ${audit.unreviewedBlocks.length} unreviewed blocks. Run audit-template first.`);
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

    printUsage();
    process.exitCode = 1;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main(process.argv);
