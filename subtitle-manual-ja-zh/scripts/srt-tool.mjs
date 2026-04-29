#!/usr/bin/env node

import fs from "fs";
import path from "path";

function printUsage() {
  console.log(`Usage:
  node subtitle-manual-ja-zh/scripts/srt-tool.mjs inspect <file.srt> [--json]
  node subtitle-manual-ja-zh/scripts/srt-tool.mjs dump-json <file.srt>
  node subtitle-manual-ja-zh/scripts/srt-tool.mjs export-template <file.srt> <output.json>
  node subtitle-manual-ja-zh/scripts/srt-tool.mjs write-corrected <template.json> <output.srt>
  node subtitle-manual-ja-zh/scripts/srt-tool.mjs write-bilingual <template.json> <output.srt>
  node subtitle-manual-ja-zh/scripts/srt-tool.mjs validate <file.srt> [--json]

Commands:
  inspect          Print a quick structural summary and flag suspicious subtitle blocks.
  dump-json        Output parsed subtitle blocks as JSON for follow-up processing.
  export-template  Export a JSON work template for manual correction and translation.
  write-corrected  Write a Japanese-only corrected SRT from a template JSON file.
  write-bilingual  Write a Japanese-Chinese bilingual SRT from a template JSON file.
  validate         Validate an output SRT and print summary plus structural issues.
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

function parseTimestamp(value) {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) {
    return null;
  }

  const [, hh, mm, ss, ms] = match;
  return (
    Number(hh) * 3600000 +
    Number(mm) * 60000 +
    Number(ss) * 1000 +
    Number(ms)
  );
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

function parseSrt(text) {
  const normalized = normalizeNewlines(text).trim();
  if (!normalized) {
    return [];
  }

  const rawBlocks = normalized.split(/\n{2,}/);
  return rawBlocks.map((rawBlock, index) => {
    const lines = rawBlock.split("\n");
    const idLine = lines[0] || "";
    const timeLine = lines[1] || "";
    const textLines = lines.slice(2);
    const timeMatch = timeLine.match(
      /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/
    );

    const start = timeMatch ? parseTimestamp(timeMatch[1]) : null;
    const end = timeMatch ? parseTimestamp(timeMatch[2]) : null;

    return {
      blockIndex: index + 1,
      raw: rawBlock,
      sequence: idLine,
      sequenceNumber: /^\d+$/.test(idLine) ? Number(idLine) : null,
      timecode: timeLine,
      start,
      end,
      durationMs: start !== null && end !== null ? end - start : null,
      textLines,
      text: textLines.join(" ").trim(),
    };
  });
}

function collectIssues(blocks, options = {}) {
  const expectBilingual = options.expectBilingual === true;
  const expectCorrected = options.expectCorrected === true;
  const issues = [];
  let previousBlock = null;

  for (const block of blocks) {
    const textLineCount = block.textLines.filter((line) => line.trim()).length;

    if (block.sequenceNumber === null) {
      issues.push({
        type: "invalid-sequence",
        blockIndex: block.blockIndex,
        detail: `Sequence is not numeric: ${JSON.stringify(block.sequence)}`,
      });
    }

    if (block.sequenceNumber !== null && block.sequenceNumber !== block.blockIndex) {
      issues.push({
        type: "non-sequential-numbering",
        blockIndex: block.blockIndex,
        detail: `Expected ${block.blockIndex}, got ${block.sequenceNumber}`,
      });
    }

    if (block.start === null || block.end === null) {
      issues.push({
        type: "invalid-timecode",
        blockIndex: block.blockIndex,
        detail: `Could not parse timecode: ${JSON.stringify(block.timecode)}`,
      });
    }

    if (block.durationMs !== null && block.durationMs < 0) {
      issues.push({
        type: "negative-duration",
        blockIndex: block.blockIndex,
        detail: `Duration is ${block.durationMs}ms`,
      });
    }

    if (block.durationMs !== null && block.durationMs <= 800 && block.text.length >= 25) {
      issues.push({
        type: "dense-short-duration",
        blockIndex: block.blockIndex,
        detail: `Long text in short duration: ${block.text.length} chars over ${block.durationMs}ms`,
      });
    }

    if (textLineCount === 0) {
      issues.push({
        type: "empty-text",
        blockIndex: block.blockIndex,
        detail: "Subtitle block has no text lines",
      });
    }

    if (textLineCount >= 3 && !expectBilingual) {
      issues.push({
        type: "fragmented-lines",
        blockIndex: block.blockIndex,
        detail: `Block has ${textLineCount} text lines`,
      });
    }

    if (expectCorrected && textLineCount !== 1) {
      issues.push({
        type: "unexpected-text-line-count",
        blockIndex: block.blockIndex,
        detail: `Expected 1 text line, got ${textLineCount}`,
      });
    }

    if (expectBilingual && textLineCount !== 2) {
      issues.push({
        type: "unexpected-text-line-count",
        blockIndex: block.blockIndex,
        detail: `Expected 2 text lines, got ${textLineCount}`,
      });
    }

    if (previousBlock && previousBlock.end !== null && block.start !== null && block.start < previousBlock.end) {
      issues.push({
        type: "overlap",
        blockIndex: block.blockIndex,
        detail: `Starts ${msToSrt(previousBlock.end - block.start)} before previous block ends`,
      });
    }

    if (previousBlock && previousBlock.text && block.text && previousBlock.text === block.text) {
      issues.push({
        type: "duplicate-consecutive-text",
        blockIndex: block.blockIndex,
        detail: "Text is identical to the previous block",
      });
    }

    previousBlock = block;
  }

  return issues;
}

function buildSummary(filePath, blocks, issues) {
  const durations = blocks
    .map((block) => block.durationMs)
    .filter((value) => typeof value === "number");
  const textLengths = blocks.map((block) => block.text.length);
  const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
  const issueCounts = issues.reduce((map, issue) => {
    map[issue.type] = (map[issue.type] || 0) + 1;
    return map;
  }, {});

  return {
    file: path.resolve(filePath),
    blockCount: blocks.length,
    firstSequence: blocks[0] ? blocks[0].sequence : null,
    lastSequence: blocks[blocks.length - 1] ? blocks[blocks.length - 1].sequence : null,
    avgDurationMs: durations.length ? Math.round(totalDurationMs / durations.length) : 0,
    maxTextLength: textLengths.length ? Math.max(...textLengths) : 0,
    issueCounts,
  };
}

function printInspect(summary, issues) {
  console.log(`File: ${summary.file}`);
  console.log(`Blocks: ${summary.blockCount}`);
  console.log(`First sequence: ${summary.firstSequence ?? "-"}`);
  console.log(`Last sequence: ${summary.lastSequence ?? "-"}`);
  console.log(`Average duration: ${summary.avgDurationMs}ms`);
  console.log(`Max text length: ${summary.maxTextLength}`);
  console.log("");

  if (Object.keys(summary.issueCounts).length === 0) {
    console.log("No structural issues detected.");
    return;
  }

  console.log("Issue counts:");
  for (const type of Object.keys(summary.issueCounts).sort()) {
    console.log(`- ${type}: ${summary.issueCounts[type]}`);
  }

  console.log("");
  console.log("Flagged blocks:");
  for (const issue of issues) {
    console.log(`- block ${issue.blockIndex}: ${issue.type} - ${issue.detail}`);
  }
}

function exportTemplate(blocks, sourcePath) {
  return {
    sourceFile: path.resolve(sourcePath),
    generatedAt: new Date().toISOString(),
    blockCount: blocks.length,
    blocks: blocks.map((block) => ({
      blockIndex: block.blockIndex,
      sequenceNumber: block.sequenceNumber ?? block.blockIndex,
      timecode: block.timecode,
      sourceTextLines: block.textLines,
      sourceText: block.text,
      correctedJapanese: block.textLines.join(" ").trim(),
      chinese: "",
      notes: "",
    })),
  };
}

function assertTemplateShape(template) {
  if (!template || typeof template !== "object") {
    throw new Error("Template JSON must be an object.");
  }

  if (!Array.isArray(template.blocks)) {
    throw new Error("Template JSON must include a blocks array.");
  }
}

function validateTemplateBlocks(template, mode) {
  assertTemplateShape(template);

  template.blocks.forEach((block, index) => {
    const label = `blocks[${index}]`;

    if (!Number.isInteger(block.sequenceNumber) || block.sequenceNumber <= 0) {
      throw new Error(`${label}.sequenceNumber must be a positive integer.`);
    }

    if (typeof block.timecode !== "string") {
      throw new Error(`${label}.timecode must be a string.`);
    }

    const match = block.timecode.match(
      /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})$/
    );
    if (!match) {
      throw new Error(`${label}.timecode is not a valid SRT timecode.`);
    }

    if (typeof block.correctedJapanese !== "string" || block.correctedJapanese.trim() === "") {
      throw new Error(`${label}.correctedJapanese must be a non-empty string.`);
    }

    if (mode === "bilingual" && (typeof block.chinese !== "string" || block.chinese.trim() === "")) {
      throw new Error(`${label}.chinese must be a non-empty string for bilingual output.`);
    }
  });
}

function renderSrtFromTemplate(template, mode) {
  validateTemplateBlocks(template, mode);

  return `${template.blocks
    .map((block, index) => {
      const lines = [
        String(index + 1),
        block.timecode,
        block.correctedJapanese.trim(),
      ];

      if (mode === "bilingual") {
        lines.push(block.chinese.trim());
      }

      return lines.join("\n");
    })
    .join("\n\n")}\n`;
}

function detectOutputMode(blocks) {
  const nonEmptyCounts = blocks.map((block) =>
    block.textLines.filter((line) => line.trim()).length
  );

  if (nonEmptyCounts.every((count) => count === 2)) {
    return "bilingual";
  }

  if (nonEmptyCounts.every((count) => count === 1)) {
    return "corrected";
  }

  return "mixed";
}

function runInspect(filePath, jsonMode) {
  const text = readText(filePath);
  const blocks = parseSrt(text);
  const issues = collectIssues(blocks);
  const summary = buildSummary(filePath, blocks, issues);

  if (jsonMode) {
    console.log(JSON.stringify({ summary, issues, blocks }, null, 2));
    return;
  }

  printInspect(summary, issues);
}

function runExportTemplate(inputPath, outputPath) {
  const text = readText(inputPath);
  const blocks = parseSrt(text);
  const template = exportTemplate(blocks, inputPath);
  writeText(outputPath, `${JSON.stringify(template, null, 2)}\n`);
  console.log(`Template written: ${path.resolve(outputPath)}`);
}

function runWrite(templatePath, outputPath, mode) {
  const template = readJson(templatePath);
  const rendered = renderSrtFromTemplate(template, mode);
  writeText(outputPath, rendered);
  console.log(`Wrote ${mode} SRT: ${path.resolve(outputPath)}`);
}

function runValidate(filePath, jsonMode) {
  const text = readText(filePath);
  const blocks = parseSrt(text);
  const mode = detectOutputMode(blocks);
  const issues = collectIssues(blocks, {
    expectBilingual: mode === "bilingual",
    expectCorrected: mode === "corrected",
  });
  const summary = {
    ...buildSummary(filePath, blocks, issues),
    detectedMode: mode,
  };

  if (jsonMode) {
    console.log(JSON.stringify({ summary, issues, blocks }, null, 2));
    return;
  }

  printInspect(summary, issues);
  console.log("");
  console.log(`Detected mode: ${mode}`);
}

function main(argv) {
  const [, , command, filePath, maybeOutputPath, ...rest] = argv;
  const jsonMode = rest.includes("--json") || maybeOutputPath === "--json";

  if (!command) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  try {
    if (command === "inspect" || command === "dump-json") {
      if (!filePath) {
        throw new Error("A source SRT file path is required.");
      }
      runInspect(filePath, command === "dump-json" || jsonMode);
      return;
    }

    if (command === "export-template") {
      if (!filePath || !maybeOutputPath) {
        throw new Error("Source SRT path and output JSON path are required.");
      }
      runExportTemplate(filePath, maybeOutputPath);
      return;
    }

    if (command === "write-corrected") {
      if (!filePath || !maybeOutputPath) {
        throw new Error("Template JSON path and output SRT path are required.");
      }
      runWrite(filePath, maybeOutputPath, "corrected");
      return;
    }

    if (command === "write-bilingual") {
      if (!filePath || !maybeOutputPath) {
        throw new Error("Template JSON path and output SRT path are required.");
      }
      runWrite(filePath, maybeOutputPath, "bilingual");
      return;
    }

    if (command === "validate") {
      if (!filePath) {
        throw new Error("An SRT file path is required.");
      }
      runValidate(filePath, jsonMode);
      return;
    }

    printUsage();
    process.exitCode = 1;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main(process.argv);
