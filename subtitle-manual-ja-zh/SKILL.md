---
name: subtitle-manual-ja-zh
description: Use when the user wants a Japanese subtitle file corrected and manually translated into a Japanese-Chinese bilingual SRT. This skill requires the agent to use the bundled Node.js script for all subtitle file reading, template export, output writing, and validation; only the Japanese correction and Chinese translation are done manually by the agent.
---

# Subtitle Manual Ja Zh

## Overview

This skill is for Japanese subtitle cleanup and fully manual Chinese translation.

Use it when we need to:
- inspect a Japanese `.srt`
- correct likely ASR mistakes from context
- keep the subtitle timing unless it is clearly broken
- produce a Japanese-Chinese bilingual `.srt`
- avoid external translation APIs and translate by direct understanding

## Required Execution Rule

When this skill is active, the agent must use the bundled Node.js script for subtitle file operations.

This is mandatory:
- read source subtitle structure with the Node.js script
- export the work template with the Node.js script
- write corrected or bilingual subtitle files with the Node.js script
- validate final subtitle files with the Node.js script

Do not:
- directly read the target subtitle file with `cat`, `sed`, `awk`, or ad hoc shell pipelines as the main workflow
- directly write `.srt` output by manual shell redirection or freehand file editing
- bypass the JSON template and write final subtitle blocks line by line by hand

The only manual part is the language work:
- correct the Japanese
- translate the Chinese
- unify names, titles, and terminology

## When To Use

Use this skill when the user asks for any of the following:
- repair Whisper or ASR errors in Japanese subtitles
- turn a Japanese subtitle file into `日中双语字幕`
- manually translate subtitles instead of machine translation
- unify names, titles, and terms across the file
- review and fix obviously unreasonable time ranges

Do not use this skill when:
- the user wants OCR from video rather than subtitle editing
- the user explicitly wants external translation APIs or a fully automated pipeline
- the user only wants a short excerpt translated in chat instead of file output

## Workflow

### 1. Inspect the source SRT with Node.js

Start with the bundled script and do not substitute shell text tools for this step:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs inspect /path/to/file.srt
```

Use structured output when you need block-level data:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs dump-json /path/to/file.srt
```

Confirm:
- block count
- whether lines are badly fragmented
- whether there are obvious repeated lines, merged lines, or broken timestamps
- whether the content is short enough to complete in one pass or should be processed in batches

### 2. Export the working JSON template

Always create a template before doing manual subtitle work:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs export-template /path/to/file.srt /path/to/work-template.json
```

The template is the only file the agent should manually edit for translation work.

Expected editable fields per block:
- `correctedJapanese`
- `chinese`
- `notes`

Preserve:
- `sequenceNumber`
- `timecode`

### 3. Correct the Japanese line manually

For each subtitle block, treat the Japanese line as the source of truth to repair before translating.

Fix:
- obvious kana or kanji recognition mistakes
- merged or duplicated phrases
- obvious speaker-name and title errors
- broken punctuation when it affects meaning
- known product names, character names, event names, song names, and staff names

Do not over-rewrite:
- keep spoken style when readable
- keep fillers if they reflect the actual rhythm
- do not turn casual speech into formal prose unless needed for clarity

If the user asked for stronger name validation, check official Japanese sources first. Japanese Wikipedia can be a fallback, but prioritize official pages when available.

### 4. Translate into natural Chinese manually

Translate from understanding, not by literal substitution.

Target style:
- natural subtitle Chinese
- concise and readable
- preserves jokes, reactions, and conversational flow
- avoids stiff machine-translation phrasing

Preferred translation behavior:
- keep short reaction lines short
- translate repeated excitement naturally instead of mechanically
- preserve speaker intent over word-for-word structure
- keep references to brands, works, and people consistent across the full file

### 5. Write the output SRT with Node.js

For bilingual output:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs write-bilingual /path/to/work-template.json /path/to/output-bilingual.srt
```

For Japanese-only corrected output:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs write-corrected /path/to/work-template.json /path/to/output-corrected-ja.srt
```

The script writes each block in a normalized structure.

Bilingual output format:

```text
序号
时间轴
修正后的日文
手工中文
```

Corrected-only output format:

```text
序号
时间轴
修正后的日文
```

Keep the original timing unless it is clearly unreasonable.

Fix timing only when there is an obvious problem such as:
- negative duration
- overlapping blocks
- extremely short display time for a long sentence
- clear timestamp corruption from ASR export

### 6. Validate the final output with Node.js

Always validate the output file before finishing:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs validate /path/to/output-bilingual.srt
```

Or:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs validate /path/to/output-corrected-ja.srt
```

Confirm:
- block numbering is sequential
- no blocks were dropped
- the last block is intact
- timing still parses as valid `SRT`
- bilingual output has exactly 2 text lines per block
- corrected-only output has exactly 1 text line per block

## Naming Convention

Follow the existing transcript naming pattern when possible.

Examples:
- source: `transcript-raw.srt`
- bilingual output: `transcript-bilingual.srt`
- source: `transcript-raw (2).srt`
- bilingual output: `transcript-bilingual (2).srt`

If the user also wants a Japanese-only corrected file, use a parallel corrected name such as:
- `transcript-raw-corrected (2).srt`
- `transcript-corrected-ja (2).srt`

Preserve the user's established naming style if earlier files in the same batch already imply one.

## Quality Bar

The final result should feel like human subtitle work, not raw machine output.

Aim for:
- corrected Japanese that reads naturally
- Chinese that sounds like subtitle Chinese, not translation software
- consistent names and terminology
- minimal unnecessary rewriting
- preserved timing and subtitle structure

If some lines remain uncertain because the source itself is garbled, make the most contextually plausible repair and keep the final wording smooth.

## Communication

When using this skill, tell the user briefly:
- that you are first inspecting the subtitle structure with the Node.js tool
- then exporting a template and manually correcting and translating it
- then writing and validating the final subtitle file with the Node.js tool

In the final response, keep it short and include:
- the output file path
- whether timing was preserved or lightly repaired
- whether names or titles were unified
- whether any small uncertain spots remain because of source quality
