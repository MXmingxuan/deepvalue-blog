import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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

test('state store retains newest 20 command records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  try {
    const store = createStateStore(root);
    await store.writeState({
      items: {},
      commands: Array.from({ length: 25 }, (_, index) => ({ command: `cmd-${index}` }))
    });

    const state = await store.readState();
    assert.equal(state.commands.length, 20);
    assert.equal(state.commands[0].command, 'cmd-5');
    assert.equal(state.commands.at(-1).command, 'cmd-24');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('state store removes temporary files after normal writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  try {
    const store = createStateStore(root);
    await store.writeState({ items: {}, commands: [] });

    const entries = await readdir(path.join(root, '.content-ops'));
    assert.deepEqual(entries.filter((entry) => entry.startsWith('state.json.tmp-')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
