import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from '../lib/state-store.mjs';

async function removeFixture(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test('state store creates default state when file is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  try {
    const store = createStateStore(root);
    assert.deepEqual(await store.readState(), { items: {}, commands: [] });
  } finally {
    await removeFixture(root);
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
    await removeFixture(root);
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
    await removeFixture(root);
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
    await removeFixture(root);
  }
});

test('state store serializes concurrent updates on one store instance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  try {
    const store = createStateStore(root);

    await Promise.all([
      store.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          a: { workflowStatus: 'draft' }
        }
      })),
      store.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          b: { workflowStatus: 'review' }
        }
      }))
    ]);

    assert.deepEqual(await store.readState(), {
      items: {
        a: { workflowStatus: 'draft' },
        b: { workflowStatus: 'review' }
      },
      commands: []
    });
  } finally {
    await removeFixture(root);
  }
});

test('state store serializes concurrent updates across store instances for the same root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  try {
    const storeA = createStateStore(root);
    const storeB = createStateStore(root);

    await Promise.all([
      storeA.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          a: { workflowStatus: 'draft' }
        }
      })),
      storeB.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          b: { workflowStatus: 'review' }
        }
      }))
    ]);

    assert.deepEqual(await storeA.readState(), {
      items: {
        a: { workflowStatus: 'draft' },
        b: { workflowStatus: 'review' }
      },
      commands: []
    });
  } finally {
    await removeFixture(root);
  }
});

test('state store serializes concurrent updates across relative and absolute root paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  const cwd = process.cwd();
  try {
    process.chdir(root);
    const storeRel = createStateStore('.');
    const storeAbs = createStateStore(root);

    await Promise.all([
      storeRel.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          rel: { workflowStatus: 'draft' }
        }
      })),
      storeAbs.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          abs: { workflowStatus: 'review' }
        }
      }))
    ]);

    const state = await storeAbs.readState();
    assert.deepEqual(state.items, {
      rel: { workflowStatus: 'draft' },
      abs: { workflowStatus: 'review' }
    });
  } finally {
    process.chdir(cwd);
    await removeFixture(root);
  }
});

test('state store serializes concurrent updates across windows path casing aliases', async () => {
  if (process.platform !== 'win32') return;

  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  try {
    const storeLower = createStateStore(root.toLowerCase());
    const storeUpper = createStateStore(root.toUpperCase());

    await Promise.all([
      storeLower.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          lower: { workflowStatus: 'draft' }
        }
      })),
      storeUpper.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          upper: { workflowStatus: 'review' }
        }
      }))
    ]);

    const state = await createStateStore(root).readState();
    assert.deepEqual(state.items, {
      lower: { workflowStatus: 'draft' },
      upper: { workflowStatus: 'review' }
    });
  } finally {
    await removeFixture(root);
  }
});

test('state store update queue recovers after a failed update', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-state-'));
  try {
    const store = createStateStore(root);

    await assert.rejects(
      store.updateState(() => {
        throw new Error('boom');
      }),
      /boom/
    );

    await store.updateState((state) => ({
      ...state,
      items: {
        ...state.items,
        ok: { workflowStatus: 'done' }
      }
    }));

    assert.deepEqual(await store.readState(), {
      items: {
        ok: { workflowStatus: 'done' }
      },
      commands: []
    });
  } finally {
    await removeFixture(root);
  }
});
