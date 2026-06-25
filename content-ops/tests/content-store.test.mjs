import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContentStore } from '../lib/content-store.mjs';
import { createStateStore } from '../lib/state-store.mjs';

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-store-'));
  await mkdir(path.join(root, 'src/content/blog'), { recursive: true });
  await mkdir(path.join(root, 'src/content/projects'), { recursive: true });
  await writeFile(
    path.join(root, 'src/content/blog/事件点评：轮胎涨价.md'),
    `---\ntitle: 事件点评：轮胎涨价\ndate: 2026-06-16\ntags: [事件点评, 化工]\n---\n\n# 正文\n`,
    'utf8'
  );
  await writeFile(
    path.join(root, 'src/content/projects/期货分析系统.md'),
    `---\ntitle: 期货分析系统\ndescription: 本地研究工具\n---\n\n# 项目\n`,
    'utf8'
  );
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

test('readContent returns checks and derived workflow status', async () => {
  const root = await createFixture();
  try {
    const store = createContentStore(root);
    const item = await store.readContent('src/content/blog/事件点评：轮胎涨价.md');
    assert.equal(item.contentType, 'blog');
    assert.equal(item.data.title, '事件点评：轮胎涨价');
    assert.equal(item.workflowStatus, 'needs-check');
    assert.equal(item.checks.some((check) => check.id === 'description' && check.status === 'warn'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveContent updates metadata and preserves body', async () => {
  const root = await createFixture();
  try {
    const store = createContentStore(root);
    await store.saveContent('src/content/blog/事件点评：轮胎涨价.md', {
      data: {
        title: '事件点评：轮胎涨价',
        date: '2026-06-16',
        description: '轮胎涨价观察',
        tags: ['事件点评']
      },
      body: '# 正文\n'
    });
    const raw = await readFile(path.join(root, 'src/content/blog/事件点评：轮胎涨价.md'), 'utf8');
    assert.match(raw, /description: 轮胎涨价观察/);
    assert.match(raw, /# 正文/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saveContent persists ops state when provided', async () => {
  const root = await createFixture();
  try {
    const store = createContentStore(root);
    await store.saveContent('src/content/blog/事件点评：轮胎涨价.md', {
      data: {
        title: '事件点评：轮胎涨价',
        date: '2026-06-16',
        description: '轮胎涨价观察',
        tags: ['事件点评']
      },
      body: '# 正文\n',
      ops: { workflowStatus: 'draft', topic: '轮胎产业链' }
    });

    const state = await createStateStore(root).readState();
    assert.equal(state.items['src/content/blog/事件点评：轮胎涨价.md'].workflowStatus, 'draft');
    assert.equal(state.items['src/content/blog/事件点评：轮胎涨价.md'].topic, '轮胎产业链');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
