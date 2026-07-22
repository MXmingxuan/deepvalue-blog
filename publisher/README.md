# Obsidian Publisher

This publisher turns selected notes from a **separate Obsidian Vault** into this
Astro site's public entries. It is manual by design: source notes are read-only,
the candidate site is built outside the live repository, and a browser page shows
the exact manifest before anything is applied.

## 1. Configure a separate Vault

Copy the example beside the repository root:

```bash
cp publish.config.example.json publish.config.local.json
```

Edit the local copy:

```json
{
  "vaultRoot": "/absolute/path/to/your/Obsidian/Vault",
  "entryOutputDir": "src/content/entries",
  "mediaOutputDir": "public/media",
  "attachmentRoots": ["Attachments"],
  "ignoreFolders": [".obsidian", ".trash", "Templates"],
  "includeInlineHashtags": true
}
```

`vaultRoot` must be absolute. Output directories must remain inside this Git
repository; attachment roots must remain inside the Vault. The local config,
state file, and temporary staging data are Git-ignored. Do not put the blog
repository inside the Vault or the Vault inside the repository.

## 2. Mark a note for publication

Only the YAML boolean `publish: true` is eligible. The string `"true"` is not.
A finished investment article can use:

```yaml
---
publish: true
publish_id: copper-supply-cycle
title: 铜供给周期
domain: investment
section: commodities
topic: copper
format: article
summary: 从资本开支与库存观察铜供给约束。
source_type: original
tags: [铜, 供给]
commodities: [铜]
companies: []
tickers: []
thesis: 长期资本开支不足仍约束供给。
confidence: medium
---
```

`publish_id` is the permanent public identity and URL slug. If it is omitted,
the command prints a deterministic suggested value but never writes it into the
Vault. Add that suggestion to the note before relying on a permanent URL.

### Articles and logs

- `format: article` is a finished argument. `title`, `summary`, and `section` are
  required.
- `format: log` is a chronological research record. It may be short or long and
  does not need a title or summary; the publisher derives them from its opening
  text. Long logs remain full Markdown pages rather than being truncated into a
  Flomo-style card.

The subject taxonomy is MECE at the top level:

- `investment`: industries, commodities, companies, markets, and trading.
  Its `section` is one of `commodities`, `industries`, `companies`, `macro`, or
  `trading`.
- `ai`: AI applications, tools, systems, and observations.
- `beyond`: exploration outside the two professional domains, including life.

`source_type` records where the thinking came from: `original`, `book`,
`podcast`, `report`, `news`, or `mixed`. Optional `confidence` is `low`,
`medium`, or `high`.

## 3. Supported Obsidian Markdown

- `[[Published Note]]` becomes `/blog/<publish_id>/`.
- A link to an unpublished note becomes visible plain text; no private Vault path
  is emitted.
- `> [!warning] Title` becomes a standard labeled blockquote.
- `![[Attachments/chart.png|Alt text]]` is copied to a deterministic path under
  `/media/<publish_id>/`; the source image is never moved or changed.
- Inline hashtags are merged into public frontmatter tags, except inside code
  fences, inline code, and URLs.

Ambiguous links, missing or case-mismatched images, and unsupported PDF, audio,
or canvas embeds stop publication with a diagnostic. Tables, footnotes, code
fences, lists, blockquotes, and ordinary Markdown are preserved.

## 4. Publish and confirm

For the note currently open in Obsidian:

```bash
npm run publish:current -- --source "/absolute/path/to/note.md"
```

For every eligible note that is new or changed since its last confirmed publish:

```bash
npm run publish:pending
```

The command validates notes, transforms Markdown, builds an isolated Astro site,
and opens a loopback-only preview. The page lists every entry and asset plus its
create/update status:

- **Confirm & Push** applies exact targets, builds again, commits only those
  targets, updates local publish state, and pushes.
- **Confirm without Push** performs the same local apply and exact commit but
  leaves pushing to you.
- **Cancel** removes temporary data and leaves tracked repository content
  unchanged.

Safe CLI options:

```bash
# Print the preview URL instead of opening it automatically
npm run publish:pending -- --no-open

# Explicit non-interactive local confirmation (never pushes)
npm run publish:pending -- --yes --no-push
```

`--yes` is required for a non-interactive apply. `--no-push` does not imply
confirmation. Without either browser confirmation or `--yes`, nothing is
applied.

## 5. Obsidian shell-command bridge

Install an Obsidian community plugin that can execute a local shell command (for
example, Shell Commands). Define a command like this, replacing both absolute
paths:

```bash
cd "/absolute/path/to/deepvalue-blog" && npm run publish:current -- --source "{{file_path:absolute}}"
```

Configure the plugin's variable for the active file's absolute path if its syntax
differs, then add the command to the command palette or a hotkey. Obsidian only
launches the publisher; confirmation still happens in the browser.

## 6. Failures and recovery

- **Validation error:** correct the reported YAML field, link, or image, then
  rerun. Nothing has been applied.
- **Preview/build error:** fix the site build. The live repository is unchanged.
- **Target conflict:** a generated destination has unrelated edits. Resolve it
  deliberately; the publisher refuses to overwrite it.
- **Git error:** inspect `git status`. Publication never uses `git add .` and
  preserves unrelated work.
- **Push error:** the exact local publication commit is retained. Fix remote
  access and push that commit normally.
- **Interrupted preview:** rerun the command. Temporary staging lives outside
  tracked output paths and contains no note bodies in persistent state.
- **Rollback warning:** inspect every path printed in the exact manifest before
  retrying; do not assume a partially failed rollback is clean.

Useful verification commands:

```bash
npm run publish:test
npm test
npm run build
```

The old `npm run prepare:publish` attachment mover is disabled. It exits with
migration instructions and never edits Markdown or moves source attachments.
