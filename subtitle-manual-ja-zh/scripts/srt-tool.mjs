#!/usr/bin/env node

import fs from "fs";
import path from "path";

function printUsage() {
  console.log(`Usage:
  node subtitle-manual-ja-zh/scripts/srt-tool.mjs inspect <file.srt> [--json]
  node subtitle-manual-ja-zh/scripts/srt-tool.mjs dump-json <file.srt>

Commands:
  inspect    Print a quick structural summary and flag suspicious subtitle blocks.
  dump-json  Output parsed subtitle blocks as JSON for follow-up processing.
`);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
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

function collectIssues(blocks) {
  const issues = [];
  let previousBlock = null;

  for (const block of blocks) {
    const textLineCount = block.textLines.filter(Boolean).length;

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

    if (textLineCount >= 3) {
      issues.push({
        type: "fragmented-lines",
        blockIndex: block.blockIndex,
        detail: `Block has ${textLineCount} text lines`,
      });
    }

    if (previousBlock && previousBlock.end !== null && block.start !== null && block.start < previousBlock.end) {
      issues.push({
        type: "overlap",
        blockIndex: block.blockIndex,
        detail: `Starts ${msToSrt(previousBlock.end - block.start)} before previous block ends`,
      });
    }

    if (
      previousBlock &&
      previousBlock.text &&
      block.text &&
      previousBlock.text === block.text
    ) {
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
  const durations = blocks.map((block) => block.durationMs).filter((value) => typeof value === "number");
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

function main(argv) {
  const [, , command, filePath, ...rest] = argv;
  const jsonMode = rest.includes("--json");

  if (!command || !filePath || !["inspect", "dump-json"].includes(command)) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const text = readText(filePath);
  const blocks = parseSrt(text);
  const issues = collectIssues(blocks);
  const summary = buildSummary(filePath, blocks, issues);

  if (command === "dump-json" || jsonMode) {
    console.log(
      JSON.stringify(
        {
          summary,
          issues,
          blocks,
        },
        null,
        2
      )
    );
    return;
  }

  printInspect(summary, issues);
}

main(process.argv);
