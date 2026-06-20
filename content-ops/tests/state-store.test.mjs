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
