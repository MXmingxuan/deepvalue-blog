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
    assert.equal(result.status, 'passed');
    assert.match(result.stdout, /ok/);

    const state = await createStateStore(root).readState();
    assert.equal(state.commands[0].name, 'test-success');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('command runner records failed command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-command-'));
  try {
    const runner = createCommandRunner(root);
    const result = await runner.runCommand('test-failure', process.execPath, ['-e', 'console.error("bad"); process.exit(7)']);
    assert.equal(result.exitCode, 7);
    assert.equal(result.status, 'failed');
    assert.match(result.stderr, /bad/);

    const state = await createStateStore(root).readState();
    assert.equal(state.commands[0].name, 'test-failure');
    assert.equal(state.commands[0].exitCode, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('openExternal rejects paths outside project root before launching editor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-command-'));
  try {
    const runner = createCommandRunner(root);
    await assert.rejects(
      runner.openExternal('../outside.md'),
      /Path escapes project root/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('command runner records spawn errors once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-ops-command-'));
  try {
    const runner = createCommandRunner(root);
    const result = await runner.runCommand('missing-command', 'definitely-not-a-real-command-for-content-ops', []);
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, null);

    const state = await createStateStore(root).readState();
    assert.equal(state.commands.length, 1);
    assert.equal(state.commands[0].name, 'missing-command');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
