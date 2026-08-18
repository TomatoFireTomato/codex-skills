import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./srt-tool.mjs", import.meta.url));

function runTool(...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
}

function runToolWithEnv(env, ...args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function createWorkspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "srt-tool-test-"));
  const sourcePath = path.join(directory, "raw.srt");
  const templatePath = path.join(directory, "work.json");
  const outputPath = path.join(directory, "corrected-ja.srt");
  fs.writeFileSync(
    sourcePath,
    "1\n00:00:00,000 --> 00:00:02,000\nこれはテストです\n\n2\n00:00:02,000 --> 00:00:04,000\nこれはテストです\n",
    "utf8"
  );
  return { directory, sourcePath, templatePath, outputPath };
}

test("schema v3 records structured review fields and writes an audited correction", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  const exported = runTool("export-template", workspace.sourcePath, workspace.templatePath);
  assert.equal(exported.status, 0, exported.stderr);

  const template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  assert.equal(template.schemaVersion, 3);
  assert.equal(template.audioAvailable, null);
  assert.ok(template.blocks[1].riskScore >= 5);
  assert.deepEqual(template.blocks[0].candidateReadings, []);

  template.audioAvailable = false;
  for (const block of template.blocks) {
    block.confidence = "high";
  }
  template.blocks[1].correctedJapanese = "これは試験です";
  template.blocks[1].changeTypes = ["asr-homophone"];
  template.blocks[1].evidence = [
    { type: "context-inferred", detail: "The surrounding discussion distinguishes a formal test." },
  ];
  template.blocks[1].overcorrectionReview.status = "pass";
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

  const audit = runTool("audit-template", workspace.templatePath, "--json");
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).readyToWrite, true);

  const written = runTool("write-corrected", workspace.templatePath, workspace.outputPath);
  assert.equal(written.status, 0, written.stderr);
  assert.match(fs.readFileSync(workspace.outputPath, "utf8"), /これは試験です/u);
});

test("schema v3 rejects a changed block without evidence or reverse review", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  const template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.audioAvailable = false;
  for (const block of template.blocks) {
    block.confidence = "high";
  }
  template.blocks[0].correctedJapanese = "根拠のない変更です";
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

  const written = runTool("write-corrected", workspace.templatePath, workspace.outputPath);
  assert.equal(written.status, 1);
  assert.match(written.stderr, /not ready to write/u);
});

test("legacy schema v2 templates remain writable", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  const template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.schemaVersion = 2;
  delete template.audioAvailable;
  delete template.audioSource;
  delete template.speakers;
  delete template.glossary;
  delete template.systematicPatterns;
  for (const block of template.blocks) {
    block.confidence = "high";
    delete block.riskScore;
    delete block.speaker;
    delete block.candidateReadings;
    delete block.changeTypes;
    delete block.audioReview;
    delete block.overcorrectionReview;
  }
  template.blocks[0].correctedJapanese = "これは旧形式です";
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

  const written = runTool("write-corrected", workspace.templatePath, workspace.outputPath);
  assert.equal(written.status, 0, written.stderr);
  assert.match(fs.readFileSync(workspace.outputPath, "utf8"), /これは旧形式です/u);
});

test("punctuation-only edits still require evidence and reverse review", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  const template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.audioAvailable = false;
  for (const block of template.blocks) {
    block.confidence = "high";
  }
  template.blocks[0].correctedJapanese = "これはテストです。";
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

  const audit = runTool("audit-template", workspace.templatePath, "--json");
  assert.equal(audit.status, 0, audit.stderr);
  const result = JSON.parse(audit.stdout);
  assert.deepEqual(result.changedBlocks, [1]);
  assert.deepEqual(result.changedMissingEvidence, [1]);
  assert.equal(result.readyToWrite, false);
});

test("silence analysis suggests edge trims and flags fully silent blocks", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));
  const mediaPath = path.join(workspace.directory, "audio.wav");
  const reportPath = path.join(workspace.directory, "silence-report.json");
  const ffprobePath = path.join(workspace.directory, "fake-ffprobe");
  const ffmpegPath = path.join(workspace.directory, "fake-ffmpeg");

  fs.writeFileSync(
    workspace.sourcePath,
    "1\n00:00:00,000 --> 00:00:02,000\n一つ目\n\n2\n00:00:03,200 --> 00:00:04,000\n二つ目\n",
    "utf8"
  );
  fs.writeFileSync(mediaPath, "fake media", "utf8");
  writeExecutable(ffprobePath, "#!/usr/bin/env node\nprocess.stdout.write('5\\n');\n");
  writeExecutable(
    ffmpegPath,
    "#!/usr/bin/env node\nprocess.stderr.write('[silencedetect] silence_start: 0\\n[silencedetect] silence_end: 0.5\\n[silencedetect] silence_start: 1.8\\n[silencedetect] silence_end: 2.5\\n[silencedetect] silence_start: 3\\n[silencedetect] silence_end: 5\\n');\n"
  );

  const analyzed = runToolWithEnv(
    { FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath },
    "analyze-silence",
    workspace.sourcePath,
    mediaPath,
    reportPath
  );
  assert.equal(analyzed.status, 0, analyzed.stderr);

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.summary.fullySilentBlockCount, 1);
  assert.equal(report.summary.suggestedTimingCount, 1);
  assert.equal(report.findings[0].suggestedTimecode, "00:00:00,500 --> 00:00:01,800");
  assert.deepEqual(report.findings[0].issues, ["leading-silence", "trailing-silence"]);
  assert.equal(report.findings[1].recommendation, "review-remove-or-retime");
});

test("silence analysis never installs a missing media tool", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));
  const mediaPath = path.join(workspace.directory, "audio.wav");
  const reportPath = path.join(workspace.directory, "silence-report.json");
  fs.writeFileSync(mediaPath, "fake media", "utf8");

  const analyzed = runToolWithEnv(
    { FFPROBE_PATH: path.join(workspace.directory, "missing-ffprobe") },
    "analyze-silence",
    workspace.sourcePath,
    mediaPath,
    reportPath
  );
  assert.equal(analyzed.status, 1);
  assert.match(analyzed.stderr, /Do not search for or install it automatically/u);
  assert.equal(fs.existsSync(reportPath), false);
});
