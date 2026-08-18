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

function advanceToFrozen(templatePath) {
  for (const phase of ["initial-reviewed", "drafted", "reverse-reviewed", "frozen"]) {
    const advanced = runTool("advance-workflow", templatePath, phase);
    assert.equal(advanced.status, 0, advanced.stderr);
  }
}

test("managed work directories are created below system temp and safely removed", () => {
  const created = runTool("create-workdir", "字幕 task");
  assert.equal(created.status, 0, created.stderr);
  const directory = created.stdout.trim();
  assert.equal(path.dirname(directory), path.join(os.tmpdir(), "japanese-whisper-subtitle-repair"));
  assert.equal(fs.existsSync(path.join(directory, ".srt-repair-workspace.json")), true);
  const runtimeScript = path.join(directory, "srt-tool.mjs");
  assert.equal(fs.existsSync(runtimeScript), true);
  const runtimeUsage = spawnSync(process.execPath, [runtimeScript], { encoding: "utf8" });
  assert.equal(runtimeUsage.status, 1);
  assert.match(runtimeUsage.stdout, /create-workdir/u);

  fs.writeFileSync(path.join(directory, "work.json"), "temporary", "utf8");
  const cleaned = runTool("cleanup-workdir", directory);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(fs.existsSync(directory), false);
});

test("cleanup refuses directories not created by the tool", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "unmanaged-srt-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const cleaned = runTool("cleanup-workdir", directory);
  assert.equal(cleaned.status, 1);
  assert.match(cleaned.stderr, /Refusing to clean an unmanaged directory/u);
  assert.equal(fs.existsSync(directory), true);
});

test("dump-json and compare can write JSON reports without shell redirection", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));
  const dumpPath = path.join(workspace.directory, "source.json");
  const comparisonPath = path.join(workspace.directory, "comparison.json");

  const dumped = runTool("dump-json", workspace.sourcePath, dumpPath);
  assert.equal(dumped.status, 0, dumped.stderr);
  assert.equal(JSON.parse(fs.readFileSync(dumpPath, "utf8")).blocks.length, 2);

  const compared = runTool(
    "compare",
    workspace.sourcePath,
    workspace.sourcePath,
    comparisonPath,
    "--json"
  );
  assert.equal(compared.status, 0, compared.stderr);
  assert.equal(JSON.parse(fs.readFileSync(comparisonPath, "utf8")).blockCountsMatch, true);
});

test("removed automated audio analysis command is unavailable", () => {
  const result = runTool("analyze-silence", "raw.srt", "audio.wav", "report.json");
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /analyze-silence|ffmpeg|ffprobe/iu);
});

test("schema v5 records bounded review fields and writes with the exact source timeline", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  const exported = runTool("export-template", workspace.sourcePath, workspace.templatePath);
  assert.equal(exported.status, 0, exported.stderr);

  const template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  assert.equal(template.schemaVersion, 5);
  assert.equal(template.timingPolicy, "preserve-source-exactly");
  assert.equal(template.workflow.phase, "triage");
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
  template.blocks[1].overcorrectionReview.notes = "Reverse reviewer cleared block 2 against raw context.";
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  advanceToFrozen(workspace.templatePath);

  const audit = runTool("audit-template", workspace.templatePath, "--json");
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).readyToWrite, true);
  assert.equal(JSON.parse(audit.stdout).sourceTimelinePreserved, true);

  const written = runTool("write-corrected", workspace.templatePath, workspace.outputPath);
  assert.equal(written.status, 0, written.stderr);
  assert.match(fs.readFileSync(workspace.outputPath, "utf8"), /これは試験です/u);
  const compared = runTool("compare", workspace.sourcePath, workspace.outputPath, "--json");
  assert.equal(compared.status, 0, compared.stderr);
  assert.equal(JSON.parse(compared.stdout).sourceTimelinePreserved, true);
});

test("schema v5 rejects changed timecodes, reordered blocks, and timing change types", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  let template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.audioAvailable = false;
  for (const block of template.blocks) block.confidence = "high";
  template.blocks[0].timecode = "00:00:00,100 --> 00:00:02,000";
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  let frozen = runTool("advance-workflow", workspace.templatePath, "initial-reviewed");
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.equal(runTool("advance-workflow", workspace.templatePath, "drafted").status, 0);
  assert.equal(runTool("advance-workflow", workspace.templatePath, "reverse-reviewed").status, 0);
  frozen = runTool("advance-workflow", workspace.templatePath, "frozen");
  assert.equal(frozen.status, 1);
  assert.match(frozen.stderr, /Strict source timeline was not preserved/u);

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.audioAvailable = false;
  for (const block of template.blocks) block.confidence = "high";
  template.blocks[0].blockIndex = 2;
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  const reordered = runTool("audit-template", workspace.templatePath);
  assert.equal(reordered.status, 1);
  assert.match(reordered.stderr, /preserve the original block order/u);

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.blocks[0].changeTypes = ["timing"];
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  const timingType = runTool("audit-template", workspace.templatePath);
  assert.equal(timingType.status, 1);
  assert.match(timingType.stderr, /unsupported change type/u);
});

test("compare exits with failure when output does not preserve the source timeline", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));
  fs.writeFileSync(
    workspace.outputPath,
    "1\n00:00:00,100 --> 00:00:02,000\nこれはテストです\n\n2\n00:00:02,000 --> 00:00:04,000\nこれはテストです\n",
    "utf8"
  );

  const compared = runTool("compare", workspace.sourcePath, workspace.outputPath, "--json");
  assert.equal(compared.status, 1);
  assert.equal(JSON.parse(compared.stdout).sourceTimelinePreserved, false);
});

test("schema v5 audit rejects a changed block count", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  const template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.blocks.pop();
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

  const audit = runTool("audit-template", workspace.templatePath, "--json");
  assert.equal(audit.status, 0, audit.stderr);
  const result = JSON.parse(audit.stdout);
  assert.equal(result.sourceTimelinePreserved, false);
  assert.equal(result.readyToWrite, false);
  assert.match(result.sourceTimelineIssues.join(" "), /Block count changed/u);
});

test("low-risk triage batch accepts only unchanged blocks without risk flags", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));
  fs.writeFileSync(
    workspace.sourcePath,
    "1\n00:00:00,000 --> 00:00:02,000\n最初の文です\n\n2\n00:00:02,000 --> 00:00:04,000\n次の文です\n",
    "utf8"
  );

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  const accepted = runTool("accept-low-risk", workspace.templatePath);
  assert.equal(accepted.status, 0, accepted.stderr);
  const template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  assert.deepEqual(template.blocks.map((block) => block.confidence), ["medium", "medium"]);
  assert.equal(template.lowRiskTriage.acceptedBlockCount, 2);
});

test("bounded workflow rejects skipped phases and detects edits after freeze", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  const skipped = runTool("advance-workflow", workspace.templatePath, "drafted");
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /can only advance/u);

  const template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.audioAvailable = false;
  for (const block of template.blocks) {
    block.confidence = "high";
  }
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  advanceToFrozen(workspace.templatePath);

  const frozen = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  frozen.blocks[0].correctedJapanese = "凍結後の変更です";
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(frozen, null, 2)}\n`, "utf8");
  const written = runTool("write-corrected", workspace.templatePath, workspace.outputPath);
  assert.equal(written.status, 1);
  assert.match(written.stderr, /changed after workflow freeze/u);
});

test("audio review targets acoustic ambiguity rather than every high risk score", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  fs.writeFileSync(
    workspace.sourcePath,
    "1\n00:00:00,000 --> 00:00:03,000\n一つ目です\n\n2\n00:00:02,500 --> 00:00:04,000\n二つ目です\n",
    "utf8"
  );
  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  let template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.audioAvailable = true;
  for (const block of template.blocks) block.confidence = "high";
  template.blocks[1].correctedJapanese = "公式名の二つ目です";
  template.blocks[1].changeTypes = ["proper-name", "asr-homophone"];
  template.blocks[1].evidence = [
    { type: "official-name", detail: "Confirmed by the official Japanese cast page." },
  ];
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  let audit = runTool("audit-template", workspace.templatePath, "--json");
  assert.equal(audit.status, 0, audit.stderr);
  assert.deepEqual(JSON.parse(audit.stdout).audioCriticalPending, []);

  fs.writeFileSync(
    workspace.sourcePath,
    "1\n00:00:00,000 --> 00:00:02,000\n同じです\n\n2\n00:00:02,000 --> 00:00:04,000\n同じです\n",
    "utf8"
  );
  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.audioAvailable = true;
  for (const block of template.blocks) block.confidence = "high";
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  audit = runTool("audit-template", workspace.templatePath, "--json");
  assert.equal(audit.status, 0, audit.stderr);
  assert.deepEqual(JSON.parse(audit.stdout).audioCriticalPending, [2]);
});

test("schema v5 rejects a changed block without evidence or reverse review", (t) => {
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

test("legacy schema v3 templates remain writable without bounded workflow metadata", (t) => {
  const workspace = createWorkspace();
  t.after(() => fs.rmSync(workspace.directory, { recursive: true, force: true }));

  assert.equal(runTool("export-template", workspace.sourcePath, workspace.templatePath).status, 0);
  const template = JSON.parse(fs.readFileSync(workspace.templatePath, "utf8"));
  template.schemaVersion = 3;
  delete template.workflow;
  delete template.lowRiskTriage;
  template.audioAvailable = false;
  for (const block of template.blocks) block.confidence = "high";
  fs.writeFileSync(workspace.templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

  const written = runTool("write-corrected", workspace.templatePath, workspace.outputPath);
  assert.equal(written.status, 0, written.stderr);
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
