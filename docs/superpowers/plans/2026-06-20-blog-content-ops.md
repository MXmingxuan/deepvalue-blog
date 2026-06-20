# Blog Content Ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Deep Value Editorial Ops workspace that scans Astro Markdown content, edits metadata/body, validates publish readiness, and runs the existing build/sync workflow.

**Architecture:** Add a standalone `content-ops/` local app beside the Astro site. A Node local API server owns filesystem writes and command execution; a static browser UI talks to that API. The public Astro content model remains unchanged, while tool-only workflow state lives in `.content-ops/state.json`.

**Tech Stack:** Node.js ESM, built-in `node:test`, built-in `http`, `fs/promises`, `child_process`, vanilla HTML/CSS/JavaScript frontend, existing Astro `npm run build` and `npm run sync` scripts.

---

## Implementation Decisions

- Do not add React, Vite, Express, or a database for V1.
- Use a limited frontmatter parser that supports the current repo's needed value shapes: strings, dates as strings, inline string arrays, and simple quoted strings.
- Store local workflow state in `.content-ops/state.json`.
- Store recent command logs inside `.content-ops/state.json` in V1.
- Support VS Code as the first external editor command via `code <absolute-file-path>`.
- Add package scripts:
  - `npm run ops` starts the local content ops server.
  - `npm run ops:test` runs Node tests.

## File Structure

- Create: `content-ops/server.mjs`
  - Starts the local HTTP server, serves static UI, routes API requests.
- Create: `content-ops/lib/paths.mjs`
  - Resolves repo paths and prevents writes outside the project root.
- Create: `content-ops/lib/frontmatter.mjs`
  - Parses and serializes Markdown frontmatter.
- Create: `content-ops/lib/content-store.mjs`
  - Scans blog/project Markdown files, reads/writes content, merges tool state.
- Create: `content-ops/lib/validators.mjs`
  - Computes publish checks and workflow readiness.
- Create: `content-ops/lib/state-store.mjs`
  - Reads/writes `.content-ops/state.json`.
- Create: `content-ops/lib/command-runner.mjs`
  - Runs build/sync/open-external commands and records logs.
- Create: `content-ops/public/index.html`
  - Single-page UI shell.
- Create: `content-ops/public/styles.css`
  - Deep Value Ops visual styling.
- Create: `content-ops/public/app.js`
  - Browser-side API client, dashboard rendering, detail editing interactions.
- Create: `content-ops/tests/frontmatter.test.mjs`
- Create: `content-ops/tests/paths.test.mjs`
- Create: `content-ops/tests/content-store.test.mjs`
- Create: `content-ops/tests/validators.test.mjs`
- Create: `content-ops/tests/command-runner.test.mjs`
- Modify: `package.json`
  - Add `ops` and `ops:test` scripts.
- Modify: `.gitignore`
  - Ignore `.content-ops/` runtime state.

## Task 1: Package Scripts And Runtime State Boundary

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add package scripts**

Modify `package.json` so `scripts` includes:

```json
{
  "dev": "astro dev",
  "build": "astro build",
  "preview": "astro preview",
  "astro": "astro",
  "sync": "npm run build",
  "ops": "node content-ops/server.mjs",
  "ops:test": "node --test content-ops/tests/*.test.mjs"
}
```

- [ ] **Step 2: Ignore local ops state**

Add this line to `.gitignore`:

```gitignore
.content-ops/
```

- [ ] **Step 3: Verify scripts are visible**

Run:

```bash
npm run
```

Expected: output lists `ops` and `ops:test` in addition to the existing Astro scripts.

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: add content ops scripts"
```

## Task 2: Safe Path Utilities

**Files:**
- Create: `content-ops/lib/paths.mjs`
- Create: `content-ops/tests/paths.test.mjs`

- [ ] **Step 1: Write failing path tests**

Create `content-ops/tests/paths.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createPathTools } from '../lib/paths.mjs';

test('resolveInside returns absolute path for project-relative content path', () => {
  const root = path.resolve('D:/github/deepvalue-blog').replaceAll('\\', '/');
  const tools = createPathTools(root);
  const resolved = tools.resolveInside('src/content/blog/example.md').replaceAll('\\', '/');
  assert.equal(resolved, `${root}/src/content/blog/example.md`);
});

test('resolveInside rejects parent traversal', () => {
  const tools = createPathTools(path.resolve('D:/github/deepvalue-blog'));
  assert.throws(
    () => tools.resolveInside('../outside.md'),
    /Path escapes project root/
  );
});

test('toRelativeContentPath normalizes separators', () => {
  const root = path.resolve('D:/github/deepvalue-blog');
  const tools = createPathTools(root);
  const absolute = path.join(root, 'src', 'content', 'blog', '例子.md');
  assert.equal(tools.toRelativeContentPath(absolute), 'src/content/blog/例子.md');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test content-ops/tests/paths.test.mjs
```

Expected: FAIL because `content-ops/lib/paths.mjs` does not exist.

- [ ] **Step 3: Implement path utilities**

Create `content-ops/lib/paths.mjs`:

```js
import path from 'node:path';

export function createPathTools(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);

  function assertInside(absolutePath) {
    const resolved = path.resolve(absolutePath);
    const relative = path.relative(root, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return resolved;
    }
    throw new Error(`Path escapes project root: ${absolutePath}`);
  }

  function resolveInside(relativePath) {
    return assertInside(path.join(root, relativePath));
  }

  function toRelativeContentPath(absolutePath) {
    const inside = assertInside(absolutePath);
    return path.relative(root, inside).split(path.sep).join('/');
  }

  function contentIdFromRelative(relativePath) {
    return relativePath.split(path.sep).join('/');
  }

  return { root, assertInside, resolveInside, toRelativeContentPath, contentIdFromRelative };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
node --test content-ops/tests/paths.test.mjs
```

Expected: PASS for all path tests.

- [ ] **Step 5: Commit**

```bash
git add content-ops/lib/paths.mjs content-ops/tests/paths.test.mjs
git commit -m "feat: add content ops path safety"
```

## Task 3: Frontmatter Parser And Serializer

**Files:**
- Create: `content-ops/lib/frontmatter.mjs`
- Create: `content-ops/tests/frontmatter.test.mjs`

- [ ] **Step 1: Write failing frontmatter tests**

Create `content-ops/tests/frontmatter.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, serializeMarkdown } from '../lib/frontmatter.mjs';

test('parseMarkdown parses frontmatter and body', () => {
  const source = `---\ntitle: 事件点评：轮胎涨价\ndate: 2026-06-16\ntags: [事件点评, 化工, 轮胎]\ncategories: [产业研究]\n---\n\n# 正文\n`;
  const parsed = parseMarkdown(source);
  assert.deepEqual(parsed.data, {
    title: '事件点评：轮胎涨价',
    date: '2026-06-16',
    tags: ['事件点评', '化工', '轮胎'],
    categories: ['产业研究']
  });
  assert.equal(parsed.body.trim(), '# 正文');
});

test('parseMarkdown handles markdown without frontmatter', () => {
  const parsed = parseMarkdown('# Untitled\n');
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.body, '# Untitled\n');
});

test('serializeMarkdown writes arrays and preserves body', () => {
  const output = serializeMarkdown({
    title: '公司分析：中国重汽000951',
    date: '2026-06-20',
    tags: ['公司分析', '重卡']
  }, '# 正文\n');
  assert.match(output, /^---\n/);
  assert.match(output, /title: 公司分析：中国重汽000951\n/);
  assert.match(output, /tags: \[公司分析, 重卡\]\n/);
  assert.match(output, /\n---\n\n# 正文\n$/);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test content-ops/tests/frontmatter.test.mjs
```

Expected: FAIL because `content-ops/lib/frontmatter.mjs` does not exist.

- [ ] **Step 3: Implement parser and serializer**

Create `content-ops/lib/frontmatter.mjs`:

```js
function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => stripQuotes(item.trim())).filter(Boolean);
  }
  return stripQuotes(value);
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function serializeValue(value) {
  if (Array.isArray(value)) {
    return `[${value.join(', ')}]`;
  }
  return String(value ?? '');
}

export function parseFrontmatter(block) {
  const data = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1);
    data[key] = parseValue(value);
  }
  return data;
}

export function parseMarkdown(source) {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { data: {}, body: source };
  }
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error('Malformed frontmatter: missing closing delimiter');
  }
  const body = source.slice(match[0].length);
  return { data: parseFrontmatter(match[1]), body };
}

export function serializeMarkdown(data, body) {
  const lines = Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${serializeValue(value)}`);
  const normalizedBody = body.startsWith('\n') ? body.slice(1) : body;
  return `---\n${lines.join('\n')}\n---\n\n${normalizedBody}`;
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
node --test content-ops/tests/frontmatter.test.mjs
```

Expected: PASS for all frontmatter tests.

- [ ] **Step 5: Commit**

```bash
git add content-ops/lib/frontmatter.mjs content-ops/tests/frontmatter.test.mjs
git commit -m "feat: parse content frontmatter"
```

## Task 4: State Store

**Files:**
- Create: `content-ops/lib/state-store.mjs`
- Create: `content-ops/tests/state-store.test.mjs`

- [ ] **Step 1: Write failing state tests**

Create `content-ops/tests/state-store.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../lib/state-store.mjs';

test('state store creates default state when file is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  try {
    const store = createStateStore(root);
    assert.deepEqual(await store.readState(), { items: {}, commands: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('state store persists items and commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  try {
    const store = createStateStore(root);
    await store.writeState({
      items: { 'src/content/blog/a.md': { workflowStatus: 'draft' } },
      commands: [{ command: 'npm run build', exitCode: 0 }]
    });
    assert.equal((await store.readState()).items['src/content/blog/a.md'].workflowStatus, 'draft');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test content-ops/tests/state-store.test.mjs
```

Expected: FAIL because `content-ops/lib/state-store.mjs` does not exist.

- [ ] **Step 3: Implement state store**

Create `content-ops/lib/state-store.mjs`:

```js
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE = { items: {}, commands: [] };

export function createStateStore(projectRoot = process.cwd()) {
  const stateDir = path.join(projectRoot, '.content-ops');
  const statePath = path.join(stateDir, 'state.json');

  async function readState() {
    try {
      const raw = await readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
        commands: Array.isArray(parsed.commands) ? parsed.commands : []
      };
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(DEFAULT_STATE);
      throw error;
    }
  }

  async function writeState(state) {
    await mkdir(stateDir, { recursive: true });
    const normalized = {
      items: state.items ?? {},
      commands: Array.isArray(state.commands) ? state.commands.slice(0, 20) : []
    };
    await writeFile(statePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  }

  async function updateState(updater) {
    const state = await readState();
    const next = await updater(state);
    await writeState(next);
    return next;
  }

  return { statePath, readState, writeState, updateState };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
node --test content-ops/tests/state-store.test.mjs
```

Expected: PASS for all state tests.

- [ ] **Step 5: Commit**

```bash
git add content-ops/lib/state-store.mjs content-ops/tests/state-store.test.mjs
git commit -m "feat: store content ops state"
```

## Task 5: Validators

**Files:**
- Create: `content-ops/lib/validators.mjs`
- Create: `content-ops/tests/validators.test.mjs`

- [ ] **Step 1: Write failing validator tests**

Create `content-ops/tests/validators.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateItem, inferWorkflowStatus } from '../lib/validators.mjs';

test('validateItem accepts complete blog metadata', () => {
  const checks = validateItem({
    contentType: 'blog',
    data: { title: '赛道研究：氢能', date: '2026-06-18', tags: ['氢能'], categories: ['产业研究'], description: '氢能产业研究' },
    body: '# 正文\n'
  });
  assert.equal(checks.every((check) => check.status === 'ok'), true);
});

test('validateItem reports missing description as warning for blog', () => {
  const checks = validateItem({
    contentType: 'blog',
    data: { title: '事件点评：轮胎涨价', date: '2026-06-16', tags: ['事件点评'] },
    body: '# 正文\n'
  });
  assert.deepEqual(checks.find((check) => check.id === 'description'), {
    id: 'description',
    label: '描述',
    status: 'warn',
    message: '建议补充 description，方便列表和 SEO 展示'
  });
});

test('inferWorkflowStatus uses stored status before validation-derived status', () => {
  assert.equal(inferWorkflowStatus({ storedStatus: 'draft', checks: [] }), 'draft');
});

test('inferWorkflowStatus returns needs-check when required check fails', () => {
  assert.equal(inferWorkflowStatus({
    storedStatus: undefined,
    checks: [{ id: 'title', status: 'error' }]
  }), 'needs-check');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test content-ops/tests/validators.test.mjs
```

Expected: FAIL because `content-ops/lib/validators.mjs` does not exist.

- [ ] **Step 3: Implement validators**

Create `content-ops/lib/validators.mjs`:

```js
function ok(id, label, message = '通过') {
  return { id, label, status: 'ok', message };
}

function warn(id, label, message) {
  return { id, label, status: 'warn', message };
}

function error(id, label, message) {
  return { id, label, status: 'error', message };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDate(value) {
  if (!isNonEmptyString(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

export function validateItem(item) {
  const data = item.data ?? {};
  const body = item.body ?? '';
  const checks = [];

  checks.push(isNonEmptyString(data.title)
    ? ok('title', '标题')
    : error('title', '标题', '缺少 title'));

  if (item.contentType === 'blog') {
    checks.push(isValidDate(data.date)
      ? ok('date', '日期')
      : error('date', '日期', '缺少有效 date'));

    checks.push(isNonEmptyString(data.description)
      ? ok('description', '描述')
      : warn('description', '描述', '建议补充 description，方便列表和 SEO 展示'));

    checks.push(Array.isArray(data.tags)
      ? ok('tags', '标签')
      : warn('tags', '标签', '建议使用 tags 数组'));

    checks.push(Array.isArray(data.categories)
      ? ok('categories', '分类')
      : warn('categories', '分类', '建议使用 categories 数组'));
  }

  if (item.contentType === 'project') {
    checks.push(isNonEmptyString(data.description)
      ? ok('description', '描述')
      : error('description', '描述', '项目缺少 description'));
  }

  checks.push(isNonEmptyString(body)
    ? ok('body', '正文')
    : error('body', '正文', '正文为空'));

  return checks;
}

export function inferWorkflowStatus({ storedStatus, checks }) {
  if (storedStatus) return storedStatus;
  if (checks.some((check) => check.status === 'error')) return 'needs-check';
  if (checks.some((check) => check.status === 'warn')) return 'needs-check';
  return 'ready';
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
node --test content-ops/tests/validators.test.mjs
```

Expected: PASS for all validator tests.

- [ ] **Step 5: Commit**

```bash
git add content-ops/lib/validators.mjs content-ops/tests/validators.test.mjs
git commit -m "feat: validate content readiness"
```

## Task 6: Content Store

**Files:**
- Create: `content-ops/lib/content-store.mjs`
- Create: `content-ops/tests/content-store.test.mjs`

- [ ] **Step 1: Write failing content store tests**

Create `content-ops/tests/content-store.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContentStore } from '../lib/content-store.mjs';

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-store-'));
  await mkdir(path.join(root, 'src/content/blog'), { recursive: true });
  await mkdir(path.join(root, 'src/content/projects'), { recursive: true });
  await writeFile(path.join(root, 'src/content/blog/事件点评：轮胎涨价.md'), `---\ntitle: 事件点评：轮胎涨价\ndate: 2026-06-16\ntags: [事件点评, 化工]\n---\n\n# 正文\n`, 'utf8');
  await writeFile(path.join(root, 'src/content/projects/期货分析系统.md'), `---\ntitle: 期货分析系统\ndescription: 本地研究工具\n---\n\n# 项目\n`, 'utf8');
  return root;
}

test('listContent scans blog and project markdown', async () => {
  const root = await createFixture();
  try {
    const store = createContentStore(root);
    const items = await store.listContent();
    assert.equal(items.length, 2);
    assert.equal(items[0].relativePath.startsWith('src/content/'), true);
    assert.equal(items.some((item) => item.contentType === 'blog'), true);
    assert.equal(items.some((item) => item.contentType === 'project'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveContent updates metadata and preserves body', async () => {
  const root = await createFixture();
  try {
    const store = createContentStore(root);
    await store.saveContent('src/content/blog/事件点评：轮胎涨价.md', {
      data: { title: '事件点评：轮胎涨价', date: '2026-06-16', description: '轮胎涨价观察', tags: ['事件点评'] },
      body: '# 正文\n'
    });
    const raw = await readFile(path.join(root, 'src/content/blog/事件点评：轮胎涨价.md'), 'utf8');
    assert.match(raw, /description: 轮胎涨价观察/);
    assert.match(raw, /# 正文/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test content-ops/tests/content-store.test.mjs
```

Expected: FAIL because `content-ops/lib/content-store.mjs` does not exist.

- [ ] **Step 3: Implement content store**

Create `content-ops/lib/content-store.mjs`:

```js
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPathTools } from './paths.mjs';
import { parseMarkdown, serializeMarkdown } from './frontmatter.mjs';
import { createStateStore } from './state-store.mjs';
import { inferWorkflowStatus, validateItem } from './validators.mjs';

const CONTENT_DIRS = [
  { contentType: 'blog', relativeDir: 'src/content/blog' },
  { contentType: 'project', relativeDir: 'src/content/projects' }
];

async function listMarkdownFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(absolute);
    }
  }
  return files;
}

export function createContentStore(projectRoot = process.cwd()) {
  const paths = createPathTools(projectRoot);
  const stateStore = createStateStore(projectRoot);

  async function readContent(relativePath) {
    const absolutePath = paths.resolveInside(relativePath);
    const raw = await readFile(absolutePath, 'utf8');
    const parsed = parseMarkdown(raw);
    const contentType = relativePath.includes('/projects/') ? 'project' : 'blog';
    const state = await stateStore.readState();
    const checks = validateItem({ contentType, data: parsed.data, body: parsed.body });
    const itemState = state.items[relativePath] ?? {};
    return {
      id: relativePath,
      relativePath,
      contentType,
      data: parsed.data,
      body: parsed.body,
      checks,
      workflowStatus: inferWorkflowStatus({ storedStatus: itemState.workflowStatus, checks }),
      ops: itemState
    };
  }

  async function listContent() {
    const state = await stateStore.readState();
    const items = [];
    for (const dir of CONTENT_DIRS) {
      const absoluteDir = paths.resolveInside(dir.relativeDir);
      await mkdir(absoluteDir, { recursive: true });
      const files = await listMarkdownFiles(absoluteDir);
      for (const absoluteFile of files) {
        const relativePath = paths.toRelativeContentPath(absoluteFile);
        const raw = await readFile(absoluteFile, 'utf8');
        const parsed = parseMarkdown(raw);
        const checks = validateItem({ contentType: dir.contentType, data: parsed.data, body: parsed.body });
        const itemState = state.items[relativePath] ?? {};
        items.push({
          id: relativePath,
          relativePath,
          contentType: dir.contentType,
          data: parsed.data,
          checks,
          workflowStatus: inferWorkflowStatus({ storedStatus: itemState.workflowStatus, checks }),
          ops: itemState
        });
      }
    }
    return items.sort((a, b) => String(b.data.date ?? '').localeCompare(String(a.data.date ?? '')));
  }

  async function saveContent(relativePath, { data, body, ops }) {
    const absolutePath = paths.resolveInside(relativePath);
    await writeFile(absolutePath, serializeMarkdown(data, body), 'utf8');
    if (ops) {
      await stateStore.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          [relativePath]: {
            ...(state.items[relativePath] ?? {}),
            ...ops,
            lastCheckedAt: new Date().toISOString()
          }
        }
      }));
    }
    return readContent(relativePath);
  }

  return { listContent, readContent, saveContent };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
node --test content-ops/tests/content-store.test.mjs
```

Expected: PASS for all content store tests.

- [ ] **Step 5: Commit**

```bash
git add content-ops/lib/content-store.mjs content-ops/tests/content-store.test.mjs
git commit -m "feat: scan and save markdown content"
```

## Task 7: Command Runner

**Files:**
- Create: `content-ops/lib/command-runner.mjs`
- Create: `content-ops/tests/command-runner.test.mjs`

- [ ] **Step 1: Write failing command runner tests**

Create `content-ops/tests/command-runner.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCommandRunner } from '../lib/command-runner.mjs';
import { createStateStore } from '../lib/state-store.mjs';

test('command runner records successful command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-command-'));
  try {
    const runner = createCommandRunner(root);
    const result = await runner.runCommand('test-success', process.execPath, ['-e', 'console.log("ok")']);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /ok/);
    const state = await createStateStore(root).readState();
    assert.equal(state.commands[0].name, 'test-success');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test content-ops/tests/command-runner.test.mjs
```

Expected: FAIL because `content-ops/lib/command-runner.mjs` does not exist.

- [ ] **Step 3: Implement command runner**

Create `content-ops/lib/command-runner.mjs`:

```js
import { spawn } from 'node:child_process';
import { createStateStore } from './state-store.mjs';
import { createPathTools } from './paths.mjs';

export function createCommandRunner(projectRoot = process.cwd()) {
  const paths = createPathTools(projectRoot);
  const stateStore = createStateStore(projectRoot);

  async function record(commandRecord) {
    await stateStore.updateState((state) => ({
      ...state,
      commands: [commandRecord, ...state.commands].slice(0, 20)
    }));
  }

  function runCommand(name, command, args = []) {
    const startedAt = new Date().toISOString();
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: paths.root,
        shell: process.platform === 'win32'
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('close', async (exitCode) => {
        const recordValue = {
          name,
          command: [command, ...args].join(' '),
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode,
          status: exitCode === 0 ? 'passed' : 'failed',
          stdout,
          stderr
        };
        await record(recordValue);
        resolve(recordValue);
      });
    });
  }

  function runBuild() {
    return runCommand('build', 'npm', ['run', 'build']);
  }

  function runSync() {
    return runCommand('sync', 'npm', ['run', 'sync']);
  }

  function openExternal(relativePath) {
    const absolute = paths.resolveInside(relativePath);
    return runCommand('open-external', 'code', [absolute]);
  }

  async function listCommands() {
    return (await stateStore.readState()).commands;
  }

  return { runCommand, runBuild, runSync, openExternal, listCommands };
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
node --test content-ops/tests/command-runner.test.mjs
```

Expected: PASS for all command runner tests.

- [ ] **Step 5: Commit**

```bash
git add content-ops/lib/command-runner.mjs content-ops/tests/command-runner.test.mjs
git commit -m "feat: run content ops commands"
```

## Task 8: Local API Server

**Files:**
- Create: `content-ops/server.mjs`

- [ ] **Step 1: Create local API and static server**

Create `content-ops/server.mjs`:

```js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentStore } from './lib/content-store.mjs';
import { createCommandRunner } from './lib/command-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();
const publicDir = path.join(__dirname, 'public');
const store = createContentStore(projectRoot);
const commands = createCommandRunner(projectRoot);

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function sendStatic(response, urlPath) {
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const absolute = path.join(publicDir, safePath);
  const ext = path.extname(absolute);
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
  };
  const content = await readFile(absolute);
  response.writeHead(200, { 'content-type': contentTypes[ext] ?? 'application/octet-stream' });
  response.end(content);
}

async function route(request, response) {
  const url = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/api/content') {
    return sendJson(response, 200, { items: await store.listContent() });
  }

  if (request.method === 'GET' && url.pathname === '/api/content/item') {
    return sendJson(response, 200, { item: await store.readContent(url.searchParams.get('path')) });
  }

  if (request.method === 'PUT' && url.pathname === '/api/content/item') {
    const payload = await readJson(request);
    return sendJson(response, 200, { item: await store.saveContent(payload.relativePath, payload) });
  }

  if (request.method === 'POST' && url.pathname === '/api/commands/build') {
    return sendJson(response, 200, { command: await commands.runBuild() });
  }

  if (request.method === 'POST' && url.pathname === '/api/commands/sync') {
    return sendJson(response, 200, { command: await commands.runSync() });
  }

  if (request.method === 'POST' && url.pathname === '/api/commands/open-external') {
    const payload = await readJson(request);
    return sendJson(response, 200, { command: await commands.openExternal(payload.relativePath) });
  }

  if (request.method === 'GET' && url.pathname === '/api/commands') {
    return sendJson(response, 200, { commands: await commands.listCommands() });
  }

  return sendStatic(response, url.pathname);
}

const server = http.createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    sendJson(response, 500, { error: error.message });
  }
});

const port = Number(process.env.CONTENT_OPS_PORT ?? 4399);
server.listen(port, '127.0.0.1', () => {
  console.log(`Deep Value Ops running at http://localhost:${port}`);
});
```

- [ ] **Step 2: Run server and verify it starts**

Run:

```bash
npm run ops
```

Expected: terminal prints `Deep Value Ops running at http://localhost:4399`.

- [ ] **Step 3: Verify API returns content**

In a second terminal, run:

```bash
node -e "fetch('http://localhost:4399/api/content').then(r=>r.json()).then(j=>console.log(Array.isArray(j.items), j.items.length > 0))"
```

Expected: `true true`.

- [ ] **Step 4: Stop server**

Stop the `npm run ops` terminal with `Ctrl+C`.

- [ ] **Step 5: Commit**

```bash
git add content-ops/server.mjs
git commit -m "feat: serve content ops api"
```

## Task 9: Static UI Shell And Dashboard

**Files:**
- Create: `content-ops/public/index.html`
- Create: `content-ops/public/styles.css`
- Create: `content-ops/public/app.js`

- [ ] **Step 1: Create HTML shell**

Create `content-ops/public/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Deep Value Ops</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <div class="app">
      <header class="topbar">
        <div class="brand">DEEP VALUE OPS</div>
        <input id="search" class="search" aria-label="搜索标题、标签、代码、主题">
        <div class="actions">
          <button id="buildBtn">构建</button>
          <button id="syncBtn">同步</button>
        </div>
      </header>
      <div class="layout">
        <aside class="sidebar" id="pipeline"></aside>
        <main class="main">
          <section id="dashboard"></section>
          <section id="detail" class="hidden"></section>
        </main>
        <aside class="inspector" id="inspector"></aside>
      </div>
    </div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create Deep Value Ops CSS**

Create `content-ops/public/styles.css`:

```css
:root {
  --bg: #050505;
  --text: #f4f4f4;
  --muted: #9b9b9b;
  --line: rgba(190, 190, 190, 0.25);
  --line-strong: rgba(255, 255, 255, 0.5);
  --green: #22c55e;
  --amber: #d6a23b;
  --red: #ef4444;
  --mono: "Space Mono", Consolas, monospace;
  --sans: Inter, "PingFang SC", "Microsoft YaHei", sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); }
button, input, textarea { font: inherit; }
.app { max-width: 1440px; margin: 0 auto; padding: 28px; }
.topbar { display: grid; grid-template-columns: 220px 1fr auto; gap: 20px; align-items: center; border-bottom: 1px solid var(--line); padding-bottom: 18px; }
.brand, .label, .status, .path, th { font-family: var(--mono); letter-spacing: .12em; }
.brand { font-size: 13px; letter-spacing: .18em; }
.search { height: 38px; background: #080808; color: var(--text); border: 1px solid var(--line); padding: 0 12px; }
.actions { display: flex; gap: 10px; }
button { height: 36px; border: 1px solid var(--line-strong); background: transparent; color: var(--text); padding: 0 12px; cursor: pointer; }
button.primary { background: var(--text); color: var(--bg); }
.layout { display: grid; grid-template-columns: 220px minmax(0, 1fr) 300px; gap: 20px; padding-top: 22px; }
.sidebar { border-right: 1px solid var(--line); padding-right: 18px; }
.inspector { border-left: 1px solid var(--line); padding-left: 18px; }
.navitem { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid rgba(190,190,190,.14); color: var(--muted); cursor: pointer; }
.navitem.active { color: var(--text); }
.pagehead { display: flex; justify-content: space-between; align-items: end; border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 16px; }
h1 { margin: 0; font-size: 42px; line-height: 1; }
table { width: 100%; border-collapse: collapse; }
th { color: var(--muted); font-size: 10px; text-align: left; padding: 10px 0; border-bottom: 1px solid var(--line); }
td { padding: 15px 10px 15px 0; border-bottom: 1px solid rgba(190,190,190,.16); vertical-align: top; }
.title { font-size: 18px; font-weight: 650; }
.path, .small { color: var(--muted); font-size: 11px; }
.chip { display: inline-block; border: 1px solid var(--line); color: var(--muted); padding: 4px 7px; margin: 2px; font-family: var(--mono); font-size: 10px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 8px; }
.dot.ready, .dot.published { background: var(--green); }
.dot.needs-check, .dot.draft { background: var(--amber); }
.dot.error { background: var(--red); }
.panel { border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 16px; }
.hidden { display: none; }
.editorgrid { display: grid; grid-template-columns: 1fr 1fr 300px; gap: 14px; }
textarea { width: 100%; min-height: 560px; background: #080808; color: var(--text); border: 1px solid var(--line); padding: 14px; line-height: 1.65; font-family: var(--mono); }
.preview { border: 1px solid var(--line); padding: 14px; min-height: 560px; line-height: 1.8; }
@media (max-width: 980px) {
  .topbar, .layout, .editorgrid { grid-template-columns: 1fr; }
  .sidebar, .inspector { border: 0; padding: 0; }
}
```

- [ ] **Step 3: Create dashboard JavaScript**

Create `content-ops/public/app.js`:

```js
const state = { items: [], filter: 'all', selected: null };

const labels = {
  all: '全部内容',
  inbox: '收件箱',
  draft: '草稿',
  'needs-check': '待检查',
  ready: '可发布',
  published: '已发布',
  archived: '归档'
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? '请求失败');
  return payload;
}

function statusLabel(status) {
  return labels[status] ?? status;
}

function renderPipeline() {
  const counts = Object.fromEntries(Object.keys(labels).map((key) => [key, 0]));
  counts.all = state.items.length;
  for (const item of state.items) counts[item.workflowStatus] = (counts[item.workflowStatus] ?? 0) + 1;
  document.querySelector('#pipeline').innerHTML = Object.entries(labels).map(([key, label]) => `
    <div class="navitem ${state.filter === key ? 'active' : ''}" data-filter="${key}">
      <span>${label}</span><span>${counts[key] ?? 0}</span>
    </div>
  `).join('');
  document.querySelectorAll('[data-filter]').forEach((node) => {
    node.addEventListener('click', () => {
      state.filter = node.dataset.filter;
      render();
    });
  });
}

function renderDashboard() {
  const query = document.querySelector('#search').value.trim().toLowerCase();
  const items = state.items.filter((item) => {
    const matchesFilter = state.filter === 'all' || item.workflowStatus === state.filter;
    const text = `${item.data.title ?? ''} ${item.relativePath} ${(item.data.tags ?? []).join(' ')}`.toLowerCase();
    return matchesFilter && (!query || text.includes(query));
  });
  document.querySelector('#dashboard').innerHTML = `
    <div class="pagehead"><div><p class="label">发布中心</p><h1>文章工作台</h1></div></div>
    <table>
      <thead><tr><th>标题</th><th>状态</th><th>日期</th><th>标签</th><th>检查</th></tr></thead>
      <tbody>
        ${items.map((item) => `
          <tr data-open="${item.relativePath}">
            <td><div class="title">${item.data.title ?? '未命名'}</div><div class="path">${item.relativePath}</div></td>
            <td><span class="dot ${item.workflowStatus}"></span>${statusLabel(item.workflowStatus)}</td>
            <td class="small">${item.data.date ?? item.contentType}</td>
            <td>${(item.data.tags ?? item.data.tech ?? []).slice(0, 3).map((tag) => `<span class="chip">${tag}</span>`).join('')}</td>
            <td class="small">${item.checks.filter((check) => check.status !== 'ok').map((check) => check.label).join('、') || 'OK'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  document.querySelectorAll('[data-open]').forEach((row) => row.addEventListener('click', () => openDetail(row.dataset.open)));
}

function renderInspector() {
  const missing = state.items.filter((item) => item.checks.some((check) => check.status !== 'ok')).length;
  document.querySelector('#inspector').innerHTML = `
    <div class="panel"><p class="label">站点健康</p><p>Markdown 文件：${state.items.length}</p><p>待处理：${missing}</p></div>
    <div class="panel"><p class="label">发布检查</p><p>检查 frontmatter</p><p>打开本地预览</p><p>构建并同步</p></div>
  `;
}

async function openDetail(relativePath) {
  const { item } = await api(`/api/content/item?path=${encodeURIComponent(relativePath)}`);
  state.selected = item;
  document.querySelector('#dashboard').classList.add('hidden');
  document.querySelector('#detail').classList.remove('hidden');
  renderDetail(item);
}

function renderDetail(item) {
  document.querySelector('#detail').innerHTML = `
    <div class="pagehead">
      <div><p class="label">文章详情</p><h1>${item.data.title ?? '未命名'}</h1><div class="path">${item.relativePath}</div></div>
      <div class="actions">
        <button id="backBtn">返回</button>
        <button id="openExternalBtn">外部编辑器打开</button>
        <button id="saveBtn" class="primary">保存</button>
      </div>
    </div>
    <div class="editorgrid">
      <textarea id="bodyInput">${item.body.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</textarea>
      <div class="preview">${item.body.split('\n').map((line) => `<p>${line || '&nbsp;'}</p>`).join('')}</div>
      <aside>
        <label>标题<input id="titleInput" class="search" value="${item.data.title ?? ''}"></label>
        <label>描述<input id="descriptionInput" class="search" value="${item.data.description ?? ''}"></label>
        <div class="panel"><p class="label">检查结果</p>${item.checks.map((check) => `<p>${check.label}: ${check.message}</p>`).join('')}</div>
      </aside>
    </div>
  `;
  document.querySelector('#backBtn').addEventListener('click', () => {
    document.querySelector('#detail').classList.add('hidden');
    document.querySelector('#dashboard').classList.remove('hidden');
  });
  document.querySelector('#openExternalBtn').addEventListener('click', () => api('/api/commands/open-external', {
    method: 'POST',
    body: JSON.stringify({ relativePath: item.relativePath })
  }));
  document.querySelector('#saveBtn').addEventListener('click', saveSelected);
}

async function saveSelected() {
  const item = state.selected;
  const nextData = {
    ...item.data,
    title: document.querySelector('#titleInput').value,
    description: document.querySelector('#descriptionInput').value
  };
  await api('/api/content/item', {
    method: 'PUT',
    body: JSON.stringify({ relativePath: item.relativePath, data: nextData, body: document.querySelector('#bodyInput').value })
  });
  await load();
}

async function load() {
  const payload = await api('/api/content');
  state.items = payload.items;
  render();
}

function render() {
  renderPipeline();
  renderDashboard();
  renderInspector();
}

document.querySelector('#search').addEventListener('input', render);
document.querySelector('#buildBtn').addEventListener('click', () => api('/api/commands/build', { method: 'POST' }).then(load));
document.querySelector('#syncBtn').addEventListener('click', () => api('/api/commands/sync', { method: 'POST' }).then(load));
load().catch((error) => { document.body.innerHTML = `<pre>${error.stack}</pre>`; });
```

- [ ] **Step 4: Run server and verify UI loads**

Run:

```bash
npm run ops
```

Open:

```text
http://localhost:4399
```

Expected: dashboard displays existing blog/project Markdown items with Chinese labels.

- [ ] **Step 5: Commit**

```bash
git add content-ops/public/index.html content-ops/public/styles.css content-ops/public/app.js
git commit -m "feat: add content ops dashboard ui"
```

## Task 10: Manual Validation And Documentation

**Files:**
- Create: `content-ops/README.md`

- [ ] **Step 1: Create usage documentation**

Create `content-ops/README.md`:

```md
# Deep Value Content Ops

Local editorial operations tool for `D:\github\deepvalue-blog`.

## Run

```bash
npm run ops
```

Then open:

```text
http://localhost:4399
```

## Test

```bash
npm run ops:test
```

## Runtime State

The tool writes local workflow state to:

```text
.content-ops/state.json
```

This directory is ignored by git.

## V1 Scope

- Scan blog and project Markdown.
- Edit frontmatter and body.
- Show publish-readiness checks.
- Run build and sync commands.
- Open long-form Markdown files in VS Code.
```

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm run ops:test
```

Expected: all `content-ops/tests/*.test.mjs` tests pass.

- [ ] **Step 3: Run Astro build**

Run:

```bash
npm run build
```

Expected: Astro build completes successfully.

- [ ] **Step 4: Run local ops server smoke test**

Run:

```bash
npm run ops
```

Open:

```text
http://localhost:4399
```

Expected:

- dashboard loads existing Markdown files
- search filters rows
- clicking a row opens detail view
- title and description can be saved on a test article
- build button records a command result

- [ ] **Step 5: Commit**

```bash
git add content-ops/README.md
git commit -m "docs: document content ops tool"
```

## Self-Review Checklist

Spec coverage:

- Local workstation app: Task 8 and Task 9.
- Mixed editing mode: Task 9, with embedded textarea and VS Code open action.
- Publishing center first: Task 9 dashboard and pipeline.
- Blog/projects scanning: Task 6.
- Frontmatter parsing and writing: Task 3 and Task 6.
- Publish checks: Task 5.
- Build/sync command execution: Task 7 and Task 8.
- Tool-only state: Task 4.
- Chinese workflow labels: Task 9.
- Deep Value visual style: Task 9 CSS.
- Testing and manual validation: Tasks 2 through 7 and Task 10.

Known V1 limits:

- The embedded Markdown preview is simple paragraph rendering. Astro-accurate preview remains available through build/preview workflow.
- The external editor action supports VS Code first.
- Research-library concepts are stored as tool-state fields rather than full graph entities.

