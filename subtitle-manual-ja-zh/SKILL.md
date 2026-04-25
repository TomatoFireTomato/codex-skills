---
name: subtitle-manual-ja-zh
description: Use when the user wants a Japanese subtitle file corrected and manually translated into a Japanese-Chinese bilingual SRT. Best for Whisper or ASR-generated `.srt` files where the job is to fix likely recognition errors from context, preserve or lightly repair timing, and write natural Chinese subtitles without using external translation APIs.
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

Follow the existing transcript naming pattern when possible.

Examples:
- source: `transcript-raw.srt`
- bilingual output: `transcript-bilingual.srt`
- source: `transcript-raw (2).srt`
- bilingual output: `transcript-bilingual (2).srt`

If the user also wants a Japanese-only corrected file, use a parallel corrected name such as:
- `transcript-raw-corrected (2).srt`
- or `transcript-corrected-ja (2).srt`

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
- that you are first inspecting the subtitle structure
- then correcting likely Japanese recognition mistakes
- then writing a fully manual Chinese translation

In the final response, keep it short and include:
- the output file path
- whether timing was preserved or lightly repaired
- whether names/titles were unified
- whether any small uncertain spots remain because of source quality
