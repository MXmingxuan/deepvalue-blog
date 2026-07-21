# Content Foundation and Publishing Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the unified Deep Value entry model, migrate current research content, guarantee that drafts never receive public routes, and establish functional domain, log, and archive routes for the later publisher and redesign.

**Architecture:** Astro continues to own public rendering through a single `entries` content collection. Pure entry-selection helpers provide testable visibility, sorting, and filtering rules, while an Astro-facing content module centralizes collection access. Existing public URLs remain compatible, and current placeholder notes stay in the collection as drafts without generated routes.

**Tech Stack:** Astro 6.1, JavaScript ES modules, Astro content collections with Zod, Node.js 22 built-in test runner, Markdown, existing Vercel static deployment.

## Global Constraints

- Only entries with `status: published` may appear in lists or receive static detail routes.
- The Obsidian Vault remains separate from this repository; this project does not implement Vault scanning.
- Use one `entries` collection for both `article` and `log` formats.
- Every entry has exactly one domain: `investment`, `ai`, or `beyond`.
- Preserve the existing public URL for the 滨化股份 article.
- Keep the three current placeholder entries as drafts and remove their public detail routes.
- Keep project content in its existing `projects` collection.
- Do not stage or modify `.DS_Store`, `.claude/settings.local.json`, or `.superpowers/`.

---

## File Structure

### Create

- `src/lib/entry-utils.mjs` — pure predicates, sorters, and domain/format selectors.
- `src/lib/entries.mjs` — Astro collection access through the pure utilities.
- `tests/entry-utils.test.mjs` — Node tests for all public-visibility rules.
- `src/content/entries/滨化股份-g5-级电子级氢氟酸真业务小体量与第二曲线验证.md` — migrated published article with stable public identity.
- `src/content/entries/draft-ai-data-center-framework.md` — migrated AI draft placeholder.
- `src/content/entries/draft-fluorochemicals-framework.md` — migrated chemical draft placeholder.
- `src/content/entries/draft-energy-framework.md` — migrated energy draft placeholder.
- `src/components/EntryList.astro` — shared functional list for transitional domain pages.
- `src/pages/investment/index.astro` — published investment entries.
- `src/pages/ai/index.astro` — published AI entries.
- `src/pages/beyond/index.astro` — published beyond entries.
- `src/pages/research-log/index.astro` — published logs across domains.
- `src/pages/archive/index.astro` — all published entries in chronological order.
- `src/pages/about/index.astro` — concise publication positioning and scope.

### Modify

- `package.json` — add the Node test command.
- `src/content.config.ts` — add the unified `entries` schema and remove `blog` after migration.
- `src/pages/index.astro` — read only published entries.
- `src/pages/blog/index.astro` — become the published article index using `entries`.
- `src/pages/blog/[slug].astro` — generate paths only for published entries.
- `src/layouts/Base.astro` — switch navigation to the approved information architecture.
- `src/pages/chemical-research/index.astro` — compatibility redirect.
- `src/pages/ai-infrastructure-research/index.astro` — compatibility redirect.
- `src/pages/shipping-shipbuilding-research/index.astro` — compatibility redirect.
- `src/pages/energy-research/index.astro` — compatibility redirect.
- `src/pages/ai-data-center-research/index.astro` — compatibility redirect.
- `src/pages/fluorochemical-research/index.astro` — compatibility redirect.
- `README.md` — document the unified model, public-status rule, and routes.

### Delete after route migration

- `src/content/blog/AI数据中心研究占位.md`
- `src/content/blog/氟化工研究占位.md`
- `src/content/blog/滨化股份 G5 级电子级氢氟酸：真业务、小体量与第二曲线验证.md`
- `src/content/blog/能源研究占位.md`

---

### Task 1: Testable Public-Visibility Rules

**Files:**
- Create: `src/lib/entry-utils.mjs`
- Create: `tests/entry-utils.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `isPublished(entry) -> boolean`
- Produces: `sortEntriesNewestFirst(entries) -> Entry[]`
- Produces: `selectPublished(entries, filters?) -> Entry[]`
- `filters` shape: `{ domain?: 'investment' | 'ai' | 'beyond', format?: 'article' | 'log' }`

- [ ] **Step 1: Add the test script**

Change the `scripts` section in `package.json` to include:

```json
"test": "node --test tests/*.test.mjs"
```

- [ ] **Step 2: Write failing visibility tests**

Create `tests/entry-utils.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublished,
  selectPublished,
  sortEntriesNewestFirst,
} from '../src/lib/entry-utils.mjs';

function entry(id, overrides = {}) {
  return {
    id,
    data: {
      status: 'published',
      domain: 'investment',
      format: 'article',
      published_at: new Date('2026-07-01'),
      ...overrides,
    },
  };
}

test('isPublished accepts only published entries', () => {
  assert.equal(isPublished(entry('published')), true);
  assert.equal(isPublished(entry('draft', { status: 'draft' })), false);
  assert.equal(isPublished(entry('archived', { status: 'archived' })), false);
});

test('selectPublished filters drafts before applying domain and format filters', () => {
  const entries = [
    entry('investment-article'),
    entry('investment-log', { format: 'log' }),
    entry('ai-log', { domain: 'ai', format: 'log' }),
    entry('private-draft', { status: 'draft', domain: 'ai', format: 'log' }),
  ];

  assert.deepEqual(
    selectPublished(entries, { domain: 'ai', format: 'log' }).map(item => item.id),
    ['ai-log'],
  );
});

test('sortEntriesNewestFirst uses updated_at before published_at', () => {
  const entries = [
    entry('older', { published_at: new Date('2026-07-01') }),
    entry('updated', {
      published_at: new Date('2026-06-01'),
      updated_at: new Date('2026-07-03'),
    }),
    entry('newer', { published_at: new Date('2026-07-02') }),
  ];

  assert.deepEqual(
    sortEntriesNewestFirst(entries).map(item => item.id),
    ['updated', 'newer', 'older'],
  );
});
```

- [ ] **Step 3: Run the tests and verify the expected failure**

Run:

```bash
npm test
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/entry-utils.mjs`.

- [ ] **Step 4: Implement the pure entry utilities**

Create `src/lib/entry-utils.mjs`:

```js
export function isPublished(entry) {
  return entry?.data?.status === 'published';
}

export function entryTimestamp(entry) {
  const value = entry.data.updated_at ?? entry.data.published_at;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function sortEntriesNewestFirst(entries) {
  return [...entries].sort((left, right) => entryTimestamp(right) - entryTimestamp(left));
}

export function selectPublished(entries, filters = {}) {
  const selected = entries.filter(entry => {
    if (!isPublished(entry)) return false;
    if (filters.domain && entry.data.domain !== filters.domain) return false;
    if (filters.format && entry.data.format !== filters.format) return false;
    return true;
  });

  return sortEntriesNewestFirst(selected);
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run:

```bash
npm test
```

Expected: 3 tests pass and the process exits with code 0.

- [ ] **Step 6: Commit the visibility boundary**

```bash
git add package.json src/lib/entry-utils.mjs tests/entry-utils.test.mjs
git commit -m "test: define published entry visibility"
```

---

### Task 2: Unified Entry Schema

**Files:**
- Modify: `src/content.config.ts`
- Create: `src/content/entries/*.md`

**Interfaces:**
- Consumes: the approved domain, format, source, and status values.
- Produces: Astro collection `entries` with validated public frontmatter.

- [ ] **Step 1: Add the entry collection without removing the existing blog collection**

In `src/content.config.ts`, define these reusable enums and the new collection above `projects`:

```ts
const domain = z.enum(['investment', 'ai', 'beyond']);
const format = z.enum(['article', 'log']);
const status = z.enum(['draft', 'published', 'archived']);
const sourceType = z.enum(['original', 'book', 'podcast', 'report', 'news', 'mixed']);

const entries = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/entries' }),
  schema: z.object({
    title: z.string(),
    publish_id: z.string().regex(/^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u),
    domain,
    section: z.string().optional(),
    topic: z.string().optional(),
    format,
    status,
    published_at: z.date(),
    updated_at: z.date().optional(),
    summary: z.string().optional(),
    source_type: sourceType.default('original'),
    source_title: z.string().optional(),
    source_url: z.string().url().optional(),
    tags: z.array(z.string()).default([]),
    commodities: z.array(z.string()).default([]),
    companies: z.array(z.string()).default([]),
    tickers: z.array(z.string()).default([]),
    thesis: z.string().optional(),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
  }).superRefine((entry, context) => {
    if (entry.format === 'article' && !entry.section) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['section'],
        message: 'Published article metadata requires section',
      });
    }
    if (entry.format === 'article' && !entry.summary) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message: 'Published article metadata requires summary',
      });
    }
  }),
});
```

Temporarily export all three collections:

```ts
export const collections = { blog, entries, projects };
```

- [ ] **Step 2: Create the migrated published article**

Create `src/content/entries/滨化股份-g5-级电子级氢氟酸真业务小体量与第二曲线验证.md` by copying the existing article body unchanged and replacing its frontmatter with:

```yaml
---
title: 滨化股份 G5 级电子级氢氟酸：真业务、小体量与第二曲线验证
publish_id: 滨化股份-g5-级电子级氢氟酸真业务小体量与第二曲线验证
domain: investment
section: commodities
topic: fluorochemicals
format: article
status: published
published_at: 2026-07-02
summary: 滨化股份 G5 级电子级氢氟酸具备真实产能与客户基础，但业务体量、盈利能力与第二曲线价值仍需持续验证。
source_type: original
tags: [氟化工, 电子化学品, 半导体材料]
commodities: [氢氟酸]
companies: [滨化股份]
tickers: ['601678']
thesis: G5 级电子级氢氟酸是真实业务，但其投资价值取决于客户放量、毛利率转正和产品平台化。
confidence: medium
---
```

- [ ] **Step 3: Create the three draft entries**

Copy each placeholder body into its target file and use these exact identity fields:

```yaml
# draft-ai-data-center-framework.md
publish_id: draft-ai-data-center-framework
domain: ai
section: ai-industry
topic: ai-infrastructure
format: article
status: draft
published_at: 2026-07-02
source_type: original
```

```yaml
# draft-fluorochemicals-framework.md
publish_id: draft-fluorochemicals-framework
domain: investment
section: commodities
topic: fluorochemicals
format: article
status: draft
published_at: 2026-07-02
source_type: original
```

```yaml
# draft-energy-framework.md
publish_id: draft-energy-framework
domain: investment
section: commodities
topic: energy
format: article
status: draft
published_at: 2026-07-02
source_type: original
```

For each draft, retain its existing `title`, `summary`, `tags`, `commodities`, `companies`, `tickers`, `thesis`, and body, translating the old field names only where the new schema requires it.

- [ ] **Step 4: Run Astro build against both collections**

Run:

```bash
npm run build
```

Expected: build passes; existing pages still use `blog`, while Astro validates all four new `entries` files.

- [ ] **Step 5: Commit the new schema and migrated copies**

```bash
git add src/content.config.ts src/content/entries
git commit -m "feat: add unified entry content model"
```

---

### Task 3: Centralized Astro Content Access

**Files:**
- Create: `src/lib/entries.mjs`
- Modify: `tests/entry-utils.test.mjs`

**Interfaces:**
- Consumes: `selectPublished(entries, filters)` from Task 1.
- Produces: `getPublishedEntries(filters?) -> Promise<CollectionEntry<'entries'>[]>`.

- [ ] **Step 1: Extend the selector test with an empty-filter case**

Append to `tests/entry-utils.test.mjs`:

```js
test('selectPublished returns all and only published entries when filters are empty', () => {
  const entries = [
    entry('article'),
    entry('log', { format: 'log' }),
    entry('draft', { status: 'draft' }),
  ];

  assert.deepEqual(selectPublished(entries).map(item => item.id), ['article', 'log']);
});
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
npm test
```

Expected: 4 tests pass.

- [ ] **Step 3: Create the Astro-facing content accessor**

Create `src/lib/entries.mjs`:

```js
import { getCollection } from 'astro:content';
import { selectPublished } from './entry-utils.mjs';

export async function getPublishedEntries(filters = {}) {
  const entries = await getCollection('entries');
  return selectPublished(entries, filters);
}
```

- [ ] **Step 4: Build to validate the Astro import boundary**

Run:

```bash
npm run build
```

Expected: build passes without changing generated routes.

- [ ] **Step 5: Commit the collection accessor**

```bash
git add src/lib/entries.mjs tests/entry-utils.test.mjs
git commit -m "feat: centralize published entry access"
```

---

### Task 4: Migrate Existing Public Pages to Published Entries

**Files:**
- Modify: `src/pages/index.astro`
- Modify: `src/pages/blog/index.astro`
- Modify: `src/pages/blog/[slug].astro`
- Modify: `src/pages/chemical-research/index.astro`
- Modify: `src/pages/ai-infrastructure-research/index.astro`
- Modify: `src/pages/shipping-shipbuilding-research/index.astro`
- Modify: `src/pages/energy-research/index.astro`

**Interfaces:**
- Consumes: `getPublishedEntries(filters?)` from Task 3.
- Produces: no list or static path derived from draft or archived entries.

- [ ] **Step 1: Replace collection access on the homepage**

In `src/pages/index.astro`, replace the `astro:content` import and local sorting with:

```js
import { getPublishedEntries } from '../lib/entries.mjs';

const sortedPosts = await getPublishedEntries();
```

Update old field references:

```js
post.data.date       -> post.data.published_at
post.data.sector     -> post.data.topic
`/blog/${post.id}`   -> `/blog/${post.data.publish_id}`
```

Map current homepage topic definitions to the new model:

```js
chemical              -> domain investment, topic fluorochemicals
ai-infrastructure     -> domain ai, topic ai-infrastructure
shipping-shipbuilding -> domain investment, topic shipping
energy                -> domain investment, topic energy
```

- [ ] **Step 2: Replace collection access on the blog index**

Use:

```js
import { getPublishedEntries } from '../../lib/entries.mjs';

const sortedPosts = await getPublishedEntries({ format: 'article' });
```

Replace sector filtering with domain filtering and link with `publish_id`. The transitional domain labels are:

```js
const domainLabels = {
  investment: '投资研究',
  ai: 'AI 与技术',
  beyond: '边界之外',
};
```

- [ ] **Step 3: Restrict detail static paths**

In `src/pages/blog/[slug].astro`, implement:

```js
import { render } from 'astro:content';
import { getPublishedEntries } from '../../lib/entries.mjs';

export async function getStaticPaths() {
  const entries = await getPublishedEntries();
  return entries.map(entry => ({
    params: { slug: entry.data.publish_id },
    props: { post: entry },
  }));
}
```

Replace `date` with `published_at`, `updated` with `updated_at`, `research_type` with `format`, and sector labels with domain labels.

- [ ] **Step 4: Migrate the four active section pages**

For each current section page, replace direct `getCollection('blog')` calls with `getPublishedEntries()` and filter using the mapping from Step 1. Replace old date, link, and type fields exactly as on the homepage.

- [ ] **Step 5: Build and verify draft routes are absent before deleting old sources**

Run:

```bash
npm run build
test -f 'dist/blog/滨化股份-g5-级电子级氢氟酸真业务小体量与第二曲线验证/index.html'
test ! -e 'dist/blog/ai数据中心研究占位'
test ! -e 'dist/blog/氟化工研究占位'
test ! -e 'dist/blog/能源研究占位'
```

Expected: all commands exit with code 0.

- [ ] **Step 6: Remove the old collection and old Markdown files**

Delete the `blog` collection definition from `src/content.config.ts`, export only:

```ts
export const collections = { entries, projects };
```

Then remove the four files under `src/content/blog/` listed in the File Structure section.

- [ ] **Step 7: Re-run all verification**

Run:

```bash
npm test
npm run build
```

Expected: 4 Node tests pass and Astro builds without a `blog` collection.

- [ ] **Step 8: Commit the public-route safety migration**

```bash
git add src/content.config.ts src/content/blog src/pages src/content/entries
git commit -m "fix: exclude draft entries from public routes"
```

---

### Task 5: Functional New Information Architecture

**Files:**
- Create: `src/components/EntryList.astro`
- Create: `src/pages/investment/index.astro`
- Create: `src/pages/ai/index.astro`
- Create: `src/pages/beyond/index.astro`
- Create: `src/pages/research-log/index.astro`
- Create: `src/pages/archive/index.astro`
- Create: `src/pages/about/index.astro`
- Modify: `src/layouts/Base.astro`

**Interfaces:**
- Consumes: published entry arrays from `getPublishedEntries`.
- Produces: functional routes required by the approved information architecture.

- [ ] **Step 1: Create a shared functional entry list**

Create `src/components/EntryList.astro`:

```astro
---
const { entries, emptyText = '暂时没有已发布内容。' } = Astro.props;
---

{entries.length > 0 ? (
  <ol class="entry-list">
    {entries.map(entry => (
      <li>
        <a href={`/blog/${entry.data.publish_id}`}>{entry.data.title}</a>
        <p>{entry.data.summary}</p>
        <small>
          {entry.data.published_at.toLocaleDateString('zh-CN')}
          {' · '}{entry.data.format === 'article' ? '研究文章' : '研究日志'}
        </small>
      </li>
    ))}
  </ol>
) : <p class="empty">{emptyText}</p>}

<style>
  .entry-list { list-style: none; display: grid; gap: 0; }
  li { padding: 28px 0; border-bottom: 1px solid var(--line); }
  a { font-size: clamp(24px, 4vw, 42px); line-height: 1.15; }
  p { max-width: 720px; margin-top: 10px; color: var(--muted); }
  small { display: block; margin-top: 12px; font-family: var(--font-mono); color: var(--muted); }
  .empty { padding: 32px 0; color: var(--muted); }
</style>
```

- [ ] **Step 2: Create the three domain pages**

Each page imports `Base`, `EntryList`, and `getPublishedEntries`, then selects its domain. Use this complete pattern for `src/pages/investment/index.astro` and change only the title, description, and domain for the other two pages:

```astro
---
import Base from '../../layouts/Base.astro';
import EntryList from '../../components/EntryList.astro';
import { getPublishedEntries } from '../../lib/entries.mjs';

const entries = await getPublishedEntries({ domain: 'investment' });
---

<Base title="投资研究 - Deep Value Research" description="大宗商品、产业、宏观、市场与交易研究">
  <header class="page-header">
    <p>INVESTMENT RESEARCH</p>
    <h1>投资研究</h1>
  </header>
  <EntryList entries={entries} />
</Base>
```

Use `domain: 'ai'` with title `AI 与技术`, and `domain: 'beyond'` with title `边界之外`.

- [ ] **Step 3: Create the research-log page**

Create `src/pages/research-log/index.astro` using:

```js
const entries = await getPublishedEntries({ format: 'log' });
```

Render it through `EntryList` with page title `研究日志` and empty text `暂时还没有已发布的研究日志。`.

- [ ] **Step 4: Create the archive page**

Create `src/pages/archive/index.astro` using:

```js
const entries = await getPublishedEntries();
```

Render it through `EntryList` with title `档案`.

- [ ] **Step 5: Update primary navigation**

Create `src/pages/about/index.astro`:

```astro
---
import Base from '../../layouts/Base.astro';
---

<Base title="关于 - Deep Value Research" description="关于 Deep Value Research">
  <header class="page-header">
    <p>ABOUT DEEP VALUE</p>
    <h1>关于</h1>
  </header>
  <article>
    <p>Deep Value 以投资、交易与大宗商品研究为核心，同时记录 AI 应用、研究工作流与边界之外的探索。</p>
  </article>
</Base>
```

Then replace `navItems` in `src/layouts/Base.astro` with:

```js
const navItems = [
  { href: '/investment/', label: '投资研究' },
  { href: '/ai/', label: 'AI 与技术' },
  { href: '/research-log/', label: '研究日志' },
  { href: '/beyond/', label: '边界之外' },
  { href: '/archive/', label: '档案' },
  { href: '/about/', label: '关于' },
];
```

- [ ] **Step 6: Build and verify all routes**

Run:

```bash
npm run build
for route in investment ai beyond research-log archive about; do test -f "dist/$route/index.html"; done
```

Expected: Astro build passes and all five files exist.

- [ ] **Step 7: Commit the functional information architecture**

```bash
git add src/components/EntryList.astro src/pages/investment src/pages/ai src/pages/beyond src/pages/research-log src/pages/archive src/pages/about src/layouts/Base.astro
git commit -m "feat: add domain and research log routes"
```

---

### Task 6: Compatibility Redirects

**Files:**
- Modify: six legacy topic page files.

**Interfaces:**
- Produces: permanent compatibility redirects from old section URLs.

- [ ] **Step 1: Replace each legacy page with an Astro redirect**

Use this exact file shape:

```astro
---
return Astro.redirect('/investment/?section=commodities&topic=fluorochemicals', 301);
---
```

Apply these mappings:

```text
/chemical-research/             -> /investment/?section=commodities&topic=fluorochemicals
/fluorochemical-research/       -> /investment/?section=commodities&topic=fluorochemicals
/energy-research/               -> /investment/?section=commodities&topic=energy
/shipping-shipbuilding-research/-> /investment/?section=commodities&topic=shipping
/ai-infrastructure-research/    -> /ai/?section=ai-industry&topic=ai-infrastructure
/ai-data-center-research/       -> /ai/?section=ai-industry&topic=ai-infrastructure
```

- [ ] **Step 2: Build and inspect redirect output**

Run:

```bash
npm run build
rg -n "investment|ai-infrastructure" \
  dist/chemical-research/index.html \
  dist/ai-infrastructure-research/index.html
```

Expected: build passes and both generated redirect documents contain their target paths.

- [ ] **Step 3: Commit compatibility routes**

```bash
git add src/pages/chemical-research src/pages/fluorochemical-research src/pages/energy-research src/pages/shipping-shipbuilding-research src/pages/ai-infrastructure-research src/pages/ai-data-center-research
git commit -m "fix: preserve legacy research section links"
```

---

### Task 7: Documentation and Release Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents: content schema, visibility rule, public routes, and verification commands.

- [ ] **Step 1: Replace the content example in README**

Document this minimal published article example:

```yaml
---
title: 文章标题
publish_id: stable-public-slug
domain: investment
section: commodities
topic: copper
format: article
status: published
published_at: 2026-07-21
summary: 列表与 SEO 摘要
source_type: original
tags: [铜]
commodities: [铜]
companies: []
tickers: []
---
```

State explicitly: only `status: published` entries appear in lists or receive `/blog/<publish_id>/` routes.

- [ ] **Step 2: Document the approved route structure**

Add:

```text
/investment/    投资研究
/ai/            AI 与技术
/research-log/  研究日志
/beyond/        边界之外
/archive/       全部已发布内容
/about/         关于 Deep Value
/blog/<id>/     文章或日志详情
```

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
npm test
npm run build
test -f 'dist/blog/滨化股份-g5-级电子级氢氟酸真业务小体量与第二曲线验证/index.html'
test ! -e 'dist/blog/ai数据中心研究占位'
test ! -e 'dist/blog/氟化工研究占位'
test ! -e 'dist/blog/能源研究占位'
for route in investment ai beyond research-log archive about; do test -f "dist/$route/index.html"; done
git diff --check
```

Expected: tests and build pass, the published article route exists, no placeholder route exists, all new information-architecture routes exist, and `git diff --check` reports nothing.

- [ ] **Step 4: Review the final diff for scope**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only content-foundation files from this plan are changed. `.DS_Store`, `.claude/settings.local.json`, and `.superpowers/` remain unstaged and unchanged by the implementation.

- [ ] **Step 5: Commit the documentation**

```bash
git add README.md
git commit -m "docs: document unified publishing model"
```

---

## Completion Gate

Project 1 is complete only when:

- all Node tests pass;
- Astro production build passes;
- no draft or archived entry receives a public route;
- the existing 滨化股份 article URL still resolves;
- the new domain, research-log, archive, and about routes build;
- legacy section URLs redirect to the new information architecture;
- unrelated local files are not staged;
- the implemented result receives code review and verification-before-completion checks.
