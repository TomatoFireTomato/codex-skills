---
name: subtitle-manual-ja-zh
description: Use when the user wants a Japanese subtitle file corrected and manually translated into a Japanese-Chinese bilingual SRT. Best for Whisper or ASR-generated `.srt` files where the job is to fix likely recognition errors from context, preserve or lightly repair timing, and write natural Chinese subtitles by the current Codex session directly, without external translation APIs, other LLMs, or delegated translation services.
---

# Subtitle Manual Ja Zh

## Overview

This skill is for Japanese subtitle cleanup and fully manual Chinese translation.

Use it when we need to:
- read a Japanese `.srt`
- correct likely ASR mistakes from context
- keep the subtitle timing unless it is clearly broken
- produce a Japanese-Chinese bilingual `.srt`
- avoid external translation APIs and translate by direct understanding
- keep all translation work inside the current Codex session

## Hard Constraints

When this skill is active, translation must be performed by the current Codex session directly.

Do not:
- call any external translation API or SaaS
- invoke any extra LLM, model endpoint, MCP translation tool, browser translation feature, or plugin whose purpose is translation
- delegate the translation task to another agent, worker, or background process
- send subtitle text to online services for translation, paraphrasing, or post-editing

Allowed helpers:
- local file inspection
- local scripts in this skill directory
- local shell utilities for parsing, counting, validating, or writing files
- optional official source lookups only for factual name verification when the user explicitly wants stronger validation

If a line is uncertain, resolve it from context and your own understanding first. Prefer a best-effort local human-style translation over any external dependency.

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
- the user specifically asks to route the translation through another model or service

## Workflow

### 1. Inspect the source SRT

Read the file first and confirm:
- block count
- whether lines are badly fragmented
- whether there are obvious repeated lines, merged lines, or broken timestamps
- whether the content is short enough to complete in one pass or should be processed in batches

Prefer the bundled parser first:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs inspect /path/to/file.srt
```

Use `--json` when you want structured output for follow-up processing:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs inspect /path/to/file.srt --json
```

Use `dump-json` when you want the full parsed block list:

```bash
node subtitle-manual-ja-zh/scripts/srt-tool.mjs dump-json /path/to/file.srt
```

Fallback to fast local inspection tools such as `sed` and `rg` only when you need extra spot checks.

### 2. Correct the Japanese line first

For each subtitle block, treat the Japanese line as the source of truth to repair before translating.

Fix:
- obvious kana/kanji recognition mistakes
- merged or duplicated phrases
- obvious speaker-name and title errors
- broken punctuation when it affects meaning
- known product names, character names, event names, song names, and staff names

Do not over-rewrite:
- keep spoken style when readable
- keep fillers if they reflect the actual rhythm
- do not turn casual speech into formal prose unless needed for clarity

If the user asked for stronger name validation, check official Japanese sources first. Japanese Wikipedia can be a fallback, but prioritize official pages when available.

### 3. Translate into natural Chinese manually

Translate from understanding, not by literal substitution.

Operational rule:
- write the Chinese lines yourself in this Codex session
- do not ask another model or tool to draft, improve, or verify the translation
- do not use online lookup except for factual proper-name validation when needed

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

### 4. Build the bilingual SRT

Output each block as:

```text
序号
时间轴
修正后的日文
手工中文
```

Keep the original timing unless it is clearly unreasonable.

Fix timing only when there is an obvious problem such as:
- negative duration
- overlapping blocks
- extremely short display time for a long sentence
- clear timestamp corruption from ASR export

### 5. Verify before finishing

Confirm:
- block numbering is sequential
- every block has exactly 4 lines in the bilingual output
- no blocks were dropped
- the last block is intact
- timing still parses as valid `SRT`

Before starting manual translation work, use the script output to identify:
- malformed numbering
- invalid timestamps
- overlaps and negative durations
- suspiciously dense short subtitles
- fragmented or empty blocks

## Naming Convention

Preserve the original base filename and append a suffix before the extension.

Default rule:
- bilingual output: append `-bilingual`
- Japanese-only corrected output: append `-corrected-ja`

Examples:
- source: `transcript-raw.srt`
- bilingual output: `transcript-raw-bilingual.srt`
- source: `transcript-raw (2).srt`
- bilingual output: `transcript-raw (2)-bilingual.srt`

If the user also wants a Japanese-only corrected file, use:
- `transcript-raw-corrected-ja.srt`
- `transcript-raw (2)-corrected-ja.srt`

Keep the original directory and original extension unchanged.

If the user explicitly requests a different suffix, follow the user's suffix while still preserving the original base filename.

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
- that you are first inspecting the subtitle structure
- then correcting likely Japanese recognition mistakes
- then writing a fully manual Chinese translation in the current Codex session without external translation services or extra LLM calls

In the final response, keep it short and include:
- the output file path
- whether timing was preserved or lightly repaired
- whether names/titles were unified
- whether any small uncertain spots remain because of source quality
