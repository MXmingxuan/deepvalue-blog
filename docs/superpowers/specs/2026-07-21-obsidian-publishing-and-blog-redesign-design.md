# Deep Value Obsidian Publishing and Blog Redesign

Date: 2026-07-21
Status: Approved for implementation planning

## 1. Product Direction

Deep Value is a professional personal publication centered on investment, trading, and commodity research, with AI applications and observations as a secondary focus. It also leaves a deliberately lower-emphasis space for personal interests and life-related writing.

The project has two connected goals:

1. Make Obsidian the private writing and knowledge-management environment while making selected notes easy and safe to publish.
2. Redesign the public site into a distinctive commodities and macro research publication rather than a generic dark portfolio.

The system must support both durable research articles and frequent research logs. Length does not determine the content format. A long entry may remain a log when it records a time-specific or evolving judgment; an article is a durable, structured conclusion intended for later reuse.

## 2. Current-State Findings

The current site is an Astro 6 static site deployed through Vercel. Markdown in `src/content/blog/` is the public source consumed by Astro content collections.

The repository already includes `scripts/prepare-publish.mjs`, which converts Obsidian image embeds and organizes image assets. It does not provide a complete Obsidian workflow: it does not scan an external vault, manage stable identities, convert normal wiki links and callouts, create a safe preview transaction, or protect private notes.

The current site also renders entries with `status: draft` on public routes because collection queries do not filter them. This is the first publishing-safety issue to fix.

A previously implemented content-operations workspace exists on the remote branch `origin/codex/blog-content-ops`. It was built against an older site structure and must not be merged wholesale. Its parsing, validation, command-running, and preview ideas may be selectively reused later.

## 3. Core Decisions

### 3.1 Separate Vault and Repository

The Obsidian Vault and blog repository remain physically separate.

- The Vault is the source of truth for authored content.
- The blog contains generated publishing copies.
- Published Markdown must not be edited as an independent second source.
- Publishing copies attachments; it never moves Vault attachments.
- Absolute Vault paths and private publishing state never enter Git.

Nesting the repository inside the Vault, or the Vault inside the repository, is explicitly rejected because it weakens privacy boundaries, causes Obsidian to index development files, and increases the chance of unintended Git commits.

### 3.2 Explicit Eligibility and Manual Confirmation

A note becomes eligible only when its Obsidian frontmatter contains:

```yaml
publish: true
```

Eligibility does not trigger deployment. The user manually invokes either “Publish current note” or “Publish all pending notes.” The workflow builds a temporary version and opens a local preview. Only an explicit confirmation writes the result to the blog, creates a scoped Git commit, and pushes it.

### 3.3 One Primary Domain

Every entry has exactly one primary domain based on what the entry mainly studies:

- `investment`: investment, industry, commodities, macro, markets, and trading
- `ai`: AI applications, industry observations, tools, workflows, and experiments
- `beyond`: life, personal projects, broad reading, and other boundary exploration

Reading and podcast consumption are sources, not primary categories. A petroleum-history book note belongs to `investment`; an AI podcast note belongs to `ai`; a personal travel or general-interest note belongs to `beyond`.

### 3.4 Format Is Independent of Domain

Every entry has one format:

- `article`: a durable, structured piece with a clear question, evidence, conclusion, and appropriate limitations or falsification conditions
- `log`: a time-oriented observation, research update, evolving judgment, or working note

Both formats may be short or long. Every log receives a permanent URL. Short logs render in full in the timeline; long logs show an excerpt and link to a detail page.

### 3.5 Source Is Independent of Domain and Format

`source_type` records how the entry originated:

- `original`
- `book`
- `podcast`
- `report`
- `news`
- `mixed`

This prevents “reading” and “podcast” from competing with subject categories or content formats.

## 4. Content Taxonomy

### 4.1 Investment Research

- Commodities
  - Energy
  - Metals and mining
  - Chemicals and materials
  - Agriculture
  - Shipping and logistics
- Industries and companies
- Macro and cycles
- Markets and trading

### 4.2 AI and Technology

- AI applications
- AI products and industry observations
- Research tools and workflows
- Experiments and practice

### 4.3 Beyond the Boundary

- Life observations
- Reading and thought not primarily about investment or AI
- Personal projects
- Other interests that do not fit the two professional domains

“Beyond the Boundary” is present in navigation but receives lower visual emphasis so the professional identity remains clear.

## 5. Obsidian Authoring Model

### 5.1 Common Fields

```yaml
---
publish: true
publish_id: copper-supply-cycle
domain: investment
section: commodities
topic: copper
format: article
source_type: original
title: 铜矿供给约束
summary: 从资本开支、精矿供给和加工费观察铜矿周期。
tags: [铜, 矿山, 加工费]
---
```

Field rules:

- `publish` is required for eligibility and must equal `true`.
- `publish_id` is the immutable public identity and URL slug. The first publication may generate it and write it back to the note.
- `domain` is required and accepts `investment`, `ai`, or `beyond`.
- `section` is required for articles and optional for logs.
- `topic` is optional and accepts a stable topic identifier such as `copper`.
- `format` is required and accepts `article` or `log`.
- `source_type` defaults to `original`.
- `title` and `summary` are required for articles.
- A log may omit `title`; the publisher derives a short title from the first meaningful sentence.
- A log may omit `summary`; the publisher derives an excerpt.
- `tags` is optional and defaults to an empty array.

### 5.2 Investment-Specific Fields

```yaml
commodities: [铜]
companies: []
tickers: []
thesis: 铜矿供给响应仍受长期资本开支不足约束。
confidence: medium
```

These fields are optional for logs. `confidence` accepts `low`, `medium`, or `high`.

### 5.3 Publication Dates

- `published_at` is assigned at the first confirmed publication.
- `updated_at` changes on later confirmed publications.
- The original `published_at` remains stable.
- The publisher stores publication timestamps in local state and emitted frontmatter; it does not depend on filesystem creation dates after first publication.

## 6. Public Content Model

The redesigned Astro site uses one public content collection for both articles and logs. The recommended target layout is:

```text
src/content/entries/
├── copper-supply-cycle.md
├── oil-tanker-log-20260721.md
└── ai-research-agent.md

public/media/
├── copper-supply-cycle/
└── oil-tanker-log-20260721/
```

The emitted schema contains:

```ts
{
  title: string;
  publish_id: string;
  domain: 'investment' | 'ai' | 'beyond';
  section?: string;
  topic?: string;
  format: 'article' | 'log';
  status: 'draft' | 'published' | 'archived';
  published_at: Date;
  updated_at?: Date;
  summary?: string;
  source_type: 'original' | 'book' | 'podcast' | 'report' | 'news' | 'mixed';
  source_title?: string;
  source_url?: string;
  tags: string[];
  commodities: string[];
  companies: string[];
  tickers: string[];
  thesis?: string;
  confidence?: 'low' | 'medium' | 'high';
}
```

Public page queries and static-path generation include only `status: published`. Archived entries remain excluded from normal navigation and may later receive a dedicated archive policy. Drafts never receive a public route.

### 6.1 Existing-Content Migration

The current content migrates with explicit status decisions:

- `滨化股份 G5 级电子级氢氟酸：真业务、小体量与第二曲线验证` becomes a published investment article under chemicals and materials. Its existing public URL remains valid through a preserved `publish_id` or an explicit redirect.
- `AI数据中心研究占位`, `氟化工研究占位`, and `能源研究占位` remain drafts and stop producing public article routes.
- The old chemical, AI infrastructure, shipping and shipbuilding, and energy landing-page URLs remain as compatibility redirects to the corresponding section or filtered view in the new Investment Research or AI and Technology structure.
- Project entries remain in their existing collection during Project 1. Their later placement under Beyond the Boundary is a presentation change, not a required source migration.

## 7. Publishing Architecture

The publisher is a local Node.js application inside the blog repository. It has clear internal boundaries:

### 7.1 Configuration

`publish.config.local.json` is Git-ignored and contains the local Vault root, attachment search rules, and preferred command integration. A committed example file documents the required shape without personal paths.

`.publish-state.json` is Git-ignored and maps `publish_id` to:

- source note path
- last published source hash
- emitted Markdown path
- emitted asset paths
- first publication time
- last publication time

### 7.2 Scanner

- Resolves the current note or scans the Vault.
- Considers only Markdown notes with `publish: true`.
- For batch publication, selects new or changed notes by comparing hashes.
- Does not search or copy unrelated private notes.

### 7.3 Parser and Validator

- Parses Obsidian YAML frontmatter and Markdown.
- Applies format-specific requirements.
- Rejects duplicate `publish_id` values.
- Validates domain and section combinations.
- Reports exact files and fields for every error.

### 7.4 Transformer

- Converts `![[image.png]]` into public Markdown image links.
- Converts links to published notes into permanent public links.
- Converts links to unpublished notes into plain text by default.
- Converts Obsidian callouts into supported blog callout markup.
- Normalizes Obsidian hashtags into the `tags` field when configured.
- Preserves standard Markdown tables, code fences, lists, blockquotes, and footnotes supported by the site.
- Warns and stops for unsupported PDF, audio, canvas, or ambiguous embeds unless an explicit fallback is configured.

### 7.5 Asset Copier

- Resolves attachments using configured Vault attachment rules.
- Copies supported image files into `public/media/<publish_id>/`.
- Generates deterministic safe filenames.
- Never renames or removes Vault files.
- Detects missing and case-mismatched references before preview.

### 7.6 Staging and Preview

- Generates Markdown and assets in a temporary staging workspace.
- Builds the Astro site from staged content.
- Opens a local preview showing the real target route.
- Provides Confirm Publication and Cancel actions.
- Cancel removes staging output and leaves the repository unchanged.

### 7.7 Commit and Deploy

After confirmation:

1. Check for overlapping repository changes.
2. Copy staged generated files into explicit target paths.
3. Run the production build again against the final working tree.
4. Stage only the generated Markdown, generated assets, and intentional publishing-state-independent changes.
5. Create a scoped commit.
6. Push the current branch so Vercel deploys it.

Unrelated local modifications are never staged. If a generated target has conflicting manual changes, publication stops rather than overwriting them. If pushing fails, the local commit remains and the UI offers a retry.

### 7.8 Obsidian Entry Points

The first version exposes two commands through an Obsidian-compatible local command integration:

- Publish current note
- Publish all pending notes

The canonical CLI interfaces are:

```text
npm run publish:current -- --source <absolute-note-path>
npm run publish:pending
```

The Obsidian command integration passes the active note's absolute path to `publish:current`. The first release documents configuration through a local shell-command bridge; it does not require a custom Obsidian plugin. The browser confirmation UI is served by the publisher's local Node process. A custom plugin can later call the same command boundary without changing the publisher core.

## 8. Public Information Architecture

Primary navigation:

```text
首页
投资研究
AI 与技术
研究日志
边界之外
档案
关于
```

### 8.1 Homepage

- Cinematic, dark macro hero establishes commodities, trade, industry, and long-cycle positioning.
- The page transitions into a warm-paper editorial surface.
- One featured research article receives primary emphasis.
- Latest investment research forms the main editorial body.
- Recent research logs form a visible chronological stream.
- AI and Technology receives a dedicated secondary module.
- Beyond the Boundary appears later and with lower emphasis.

### 8.2 Domain Pages

Investment Research, AI and Technology, and Beyond the Boundary each have a landing page. Domain pages prioritize durable articles and also show recent related logs. Investment supports filters for commodities, industries and companies, macro and cycles, and markets and trading.

### 8.3 Topic Pages

A stable topic such as copper may receive a topic page containing:

- featured and recent articles
- recent topic logs
- related commodities, companies, and tags
- long-running research questions

The first release may generate topic pages only for topics with content; it does not require an editorial topic database.

### 8.4 Research Log

The Research Log is a cross-domain chronological view inspired by the low-friction feel of a memo stream without imposing a short-form limit.

- Short logs display in full.
- Long logs show an excerpt and Read More action.
- Every log has a permanent detail URL.
- Users can filter by domain, topic, commodity, company, and tag.
- A log may later be promoted into an article while keeping its original URL and relationships.
- Articles may link back to relevant historical logs to show how a judgment evolved.

### 8.5 Article Detail

Article pages include:

- domain and topic
- title, summary, publication date, and update date
- thesis and confidence when provided
- commodities, companies, tickers, and tags
- source information
- related articles and research logs
- high-readability long-form typography

### 8.6 Log Detail

Log detail pages use a simpler header and retain timestamp, domain, topic, and tags. They support the same Markdown features as article pages and do not truncate long content.

### 8.7 Archive

The archive provides chronological browsing and combined filtering across published articles and logs. Full-text search is not required for the first release; the data model and page structure must not prevent adding it later.

## 9. Visual System

The selected direction is “cinematic macro hero plus warm-paper editorial body.”

### 9.1 Mood

- monumental but restrained
- historical depth without nostalgia theater
- commodities as the connection between resources, industry, transport, power, and technology
- professional publication rather than trading-terminal decoration

### 9.2 Palette

- deep charcoal for the site shell and hero
- warm grey paper for content surfaces
- oxidized copper for links, status, and selected data
- muted olive for secondary metadata

### 9.3 Typography

- Chinese serif typography for headlines and long-form reading
- restrained sans-serif support where interface clarity requires it
- monospaced typography for dates, commodity codes, tickers, and metadata
- no oversized display type that compromises Chinese readability

### 9.4 Imagery

The user-provided reference image is a mood reference only and must not be included, traced, or directly imitated.

Production imagery must be original and compositionally distinct. Suitable elements include ports, bulk carriers, mines, grain storage, energy infrastructure, cartographic routes, restrained classical architecture, and geological or archival textures. Imagery appears mainly in the homepage hero and selected topic covers. Article bodies remain visually quiet.

The initial generated macro illustration is an exploratory mockup asset, not automatically the final production asset.

### 9.5 Layout

- The homepage starts with a full-width dark visual field.
- Editorial content transitions to a warm-paper grid.
- Borders, rules, issue labels, and metadata create publication structure.
- Research logs use a chronological stream rather than uniform rounded cards.
- Mobile layouts preserve reading order and use touch targets of at least 44 pixels.

## 10. Error Handling and Safety

The publisher follows transaction-like behavior: validate and preview before repository mutation.

- Missing required metadata: abort with field-level errors.
- Duplicate `publish_id`: abort and show both source paths.
- Missing attachment: abort and show the note and reference.
- Ambiguous wiki link: warn or abort according to explicit configuration; never choose silently.
- Unsupported embed: abort unless an explicit fallback exists.
- Build failure: preserve logs and do not publish.
- Preview cancellation: remove staging output.
- Overlapping worktree changes: abort before overwriting.
- Git push failure: retain the local commit and permit retry.
- State-file corruption: keep a backup and rebuild derivable mappings from emitted frontmatter where possible.

No public output may include absolute Vault paths, private-note titles that were not linked for publication, or unpublished note bodies.

## 11. Verification Strategy

### 11.1 Unit Tests

- frontmatter parsing and normalization
- stable `publish_id` generation
- domain and format validation
- wiki-link conversion
- callout conversion
- hashtag normalization
- asset-path resolution and safe filenames
- public route generation filters

### 11.2 Integration Tests

Use temporary fixture Vaults and repositories to verify:

- only `publish: true` notes are eligible
- a second publication updates rather than duplicates
- moving or renaming a source note preserves the public URL
- images are copied and source files remain unchanged
- long logs build and render through detail routes
- missing assets and ambiguous links prevent publication
- cancel leaves the repository unchanged
- unrelated working-tree modifications are not staged

### 11.3 Site Verification

- Astro production build passes.
- Draft and archived content do not produce normal public routes.
- Existing published research migrates without broken URLs where practical.
- Homepage, domain pages, log feed, article pages, and mobile layouts receive visual verification.
- Tables, code, images, callouts, Chinese punctuation, and long headings render correctly.

## 12. Implementation Sequence

The work is divided into three bounded implementation projects that share this design.

### Project 1: Content Foundation and Publishing Safety

- introduce the unified entry schema
- migrate current content
- centralize published-entry queries
- prevent draft routes
- establish the new taxonomy and route model

### Project 2: Obsidian Publisher

- implement configuration and local state
- implement scanner, parser, validator, transformer, and asset copier
- implement staging, build, preview, confirm, commit, and push
- expose current-note and pending-note commands

### Project 3: Site Redesign

- implement the selected visual system
- build homepage and domain pages
- build research-log feed and detail pages
- build archive and relationships
- produce and validate original production imagery

Project 1 is implemented first because it establishes the safe public contract required by both the publisher and the redesigned site. Project 2 follows so the workflow is usable before visual expansion. Project 3 completes the public experience.

## 13. Out of Scope for the First Release

- hosted CMS or database
- multi-user authoring
- automatic publishing immediately after setting `publish: true`
- importing all private Vault notes into a search index
- bidirectional synchronization from blog to Vault
- full Obsidian plugin with custom panes
- automatic AI rewriting or summarization of private notes
- public comments, accounts, or subscriptions
- real-time commodity prices
- full knowledge-graph visualization

These features may be considered later only if the publishing workflow and content volume justify them.

## 14. Success Criteria

The design succeeds when:

1. The user writes and maintains a publishable note only in Obsidian.
2. Marking `publish: true` plus a manual command produces a trustworthy preview.
3. Confirming publication updates the correct permanent URL without touching private notes or unrelated Git changes.
4. Drafts never become public accidentally.
5. Formal research and research logs coexist without using length as the distinction.
6. Visitors immediately understand that Deep Value focuses on investment, commodities, markets, and trading while also covering AI.
7. The site has a distinctive macro and commodities identity without using or imitating the supplied reference artwork.
