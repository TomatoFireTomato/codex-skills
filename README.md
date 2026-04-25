# codex-skills

Custom Codex skills maintained in this repository.

## Available Skills

### `subtitle-manual-ja-zh`

Manually correct Japanese `.srt` subtitles and translate them into Japanese-Chinese bilingual subtitles.

Use it for:
- fixing likely ASR or Whisper subtitle errors
- producing `日中双语字幕`
- keeping timing unless there is an obvious timestamp problem
- keeping names and terminology consistent across the file

## Install

Codex loads local skills from `~/.codex/skills`.

### Option 1: Copy this skill into the local skills directory

```bash
mkdir -p ~/.codex/skills
cp -R subtitle-manual-ja-zh ~/.codex/skills/
```

### Option 2: Clone this repo and symlink the skill directory

```bash
mkdir -p ~/.codex/skills
ln -s /absolute/path/to/codex-skills/subtitle-manual-ja-zh ~/.codex/skills/subtitle-manual-ja-zh
```

The symlink approach is convenient if you want future updates from this repo to take effect without copying files again.

## Verify

After installation, confirm these files exist:

```bash
ls -la ~/.codex/skills/subtitle-manual-ja-zh
ls -la ~/.codex/skills/subtitle-manual-ja-zh/agents
```

You should see at least:
- `SKILL.md`
- `agents/openai.yaml`
- `scripts/srt-tool.mjs`

## Usage

Once the skill is installed, ask Codex with wording like:

- `用 $subtitle-manual-ja-zh 修正这个日文 srt 并翻成中日双语字幕`
- `Use $subtitle-manual-ja-zh to fix this Japanese subtitle file and output a JP-ZH bilingual SRT`

## Bundled Script

This skill includes a reusable Node parser for SRT inspection:

```bash
node ~/.codex/skills/subtitle-manual-ja-zh/scripts/srt-tool.mjs inspect /path/to/file.srt
```

Structured JSON output:

```bash
node ~/.codex/skills/subtitle-manual-ja-zh/scripts/srt-tool.mjs inspect /path/to/file.srt --json
node ~/.codex/skills/subtitle-manual-ja-zh/scripts/srt-tool.mjs dump-json /path/to/file.srt
```

The script helps identify:
- malformed numbering
- invalid timestamps
- overlapping subtitles
- negative durations
- suspiciously dense short blocks
- fragmented or empty blocks

## Update

If you installed by copying files, recopy the directory after pulling updates:

```bash
cp -R subtitle-manual-ja-zh ~/.codex/skills/
```

If you installed by symlink, just pull the latest repo changes.
