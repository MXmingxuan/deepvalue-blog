import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { buildAssetIndex } from '../publisher/lib/assets.mjs';
import { createStateStore } from '../publisher/lib/state-store.mjs';
import {
  applyPublicationTransaction,
  buildTransactionPreview,
  cancelPublicationTransaction,
  confirmPublicationTransaction,
  createPublicationTransaction,
} from '../publisher/lib/transaction.mjs';
import { transformNote } from '../publisher/lib/transform.mjs';
import { assertValidPublicationNote } from '../publisher/lib/validate.mjs';
import { buildVaultIndex, scanPendingNotes } from '../publisher/lib/vault-index.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function command(executable, args, cwd) {
  return execFileAsync(executable, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function exists(candidate) {
  try { await access(candidate); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function snapshot(root) {
  const result = {};
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), next);
      else if (entry.isFile()) result[next.split(path.sep).join('/')] = await readFile(path.join(directory, entry.name), 'hex');
    }
  }
  await visit(root);
  return result;
}

async function linkDependencies(repoRoot) {
  const source = path.join(projectRoot, 'node_modules');
  const destination = path.join(repoRoot, 'node_modules');
  await mkdir(destination);
  for (const entry of await readdir(source)) {
    await symlink(path.join(source, entry), path.join(destination, entry), 'junction');
  }
}

async function actualBuild({ cwd }) {
  return command('npm', ['run', 'build'], cwd);
}

function articleMarkdown() {
  return `---
publish: true
publish_id: copper-cycle
title: 铜周期观察
domain: investment
section: commodities
topic: copper
format: article
summary: 铜库存与供给约束的阶段性观察。
source_type: original
tags: [铜]
commodities: [铜]
---

关联日志：[[Logs/库存跟踪|库存跟踪]]。

> [!warning] 风险
> 需求可能低于预期。

![[Attachments/copper.png|库存图]]
`;
}

function longLogMarkdown(extra = '') {
  const longBody = Array.from({ length: 180 }, (_, index) => `第 ${index + 1} 条观察：库存、升贴水与期限结构需要联合跟踪。`).join('\n\n');
  return `---
publish: true
publish_id: copper-inventory-log
domain: investment
format: log
source_type: original
tags: [库存]
commodities: [铜]
---

${longBody}

#交易日志 ${extra}
`;
}

async function transformedPending(vaultRoot, state) {
  const index = await buildVaultIndex({ vaultRoot, ignoreFolders: ['.obsidian'] });
  const assetIndex = await buildAssetIndex({ vaultRoot, attachmentRoots: [path.join(vaultRoot, 'Attachments')] });
  const pending = await scanPendingNotes({ vaultRoot, ignoreFolders: ['.obsidian'], state });
  for (const note of pending) assertValidPublicationNote({ filename: note.sourcePath, data: note.data, body: note.body });
  return Promise.all(pending.map((note) => transformNote({ note, vaultIndex: index, assetIndex })));
}

test('legacy prepare-publish command never edits or moves its input', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publisher-legacy-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const note = path.join(root, 'note.md');
  const image = path.join(root, 'private.png');
  await writeFile(note, '![[private.png]]\n');
  await writeFile(image, Buffer.from([1, 2, 3, 4]));
  const before = await snapshot(root);

  const result = await command('node', [path.join(projectRoot, 'scripts/prepare-publish.mjs'), note], projectRoot)
    .then(({ stdout, stderr }) => ({ code: 0, output: `${stdout}${stderr}` }))
    .catch((error) => ({ code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }));

  assert.notEqual(result.code, 0);
  assert.match(result.output, /deprecated|publish:current|迁移/iu);
  assert.deepEqual(await snapshot(root), before);
});

test('temporary Vault publishes, updates, cancels, builds, and commits only exact targets', { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publisher-full-e2e-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const vaultRoot = path.join(root, 'Private Vault');
  await command('git', ['clone', '--quiet', '--no-local', projectRoot, repoRoot], root);
  await command('git', ['config', 'user.name', 'Publisher E2E'], repoRoot);
  await command('git', ['config', 'user.email', 'publisher-e2e@example.com'], repoRoot);
  await linkDependencies(repoRoot);
  await mkdir(path.join(repoRoot, 'public', 'media'), { recursive: true });
  await mkdir(path.join(vaultRoot, 'Research'), { recursive: true });
  await mkdir(path.join(vaultRoot, 'Logs'), { recursive: true });
  await mkdir(path.join(vaultRoot, 'Attachments'), { recursive: true });
  await writeFile(path.join(vaultRoot, 'Research', '铜周期.md'), articleMarkdown());
  await writeFile(path.join(vaultRoot, 'Logs', '库存跟踪.md'), longLogMarkdown());
  await writeFile(path.join(vaultRoot, 'Private.md'), '---\npublish: false\n---\n绝不公开。\n');
  await writeFile(path.join(vaultRoot, 'Attachments', 'copper.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const vaultBefore = await snapshot(vaultRoot);
  const stateStore = createStateStore({ repoRoot });
  const emptyState = await stateStore.readState();
  const firstNotes = await transformedPending(vaultRoot, emptyState);

  assert.deepEqual(firstNotes.map(({ publishId }) => publishId).sort(), ['copper-cycle', 'copper-inventory-log']);
  const article = firstNotes.find(({ publishId }) => publishId === 'copper-cycle');
  assert.match(article.body, /\/blog\/copper-inventory-log\//u);
  assert.match(article.body, /> \*\*Warning: 风险\*\*/u);
  assert.match(article.body, /\/media\/copper-cycle\//u);
  assert.ok(firstNotes.find(({ publishId }) => publishId === 'copper-inventory-log').body.length > 5_000);

  const transactionOptions = {
    repoRoot,
    entryOutputDir: path.join(repoRoot, 'src/content/entries'),
    mediaOutputDir: path.join(repoRoot, 'public/media'),
    vaultRoot,
    notes: firstNotes,
    state: emptyState,
    stagingParent: root,
  };
  const cancelTransaction = await createPublicationTransaction(transactionOptions);
  const repoBeforeCancel = await command('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoRoot);
  await buildTransactionPreview(cancelTransaction, { runBuild: async () => ({ stdout: 'preview ok', stderr: '' }) });
  await cancelPublicationTransaction(cancelTransaction);
  assert.equal((await command('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoRoot)).stdout, repoBeforeCancel.stdout);
  assert.deepEqual(await snapshot(vaultRoot), vaultBefore);

  await writeFile(path.join(repoRoot, 'UNRELATED.local'), 'preserve me');
  const firstTransaction = await createPublicationTransaction(transactionOptions);
  await buildTransactionPreview(firstTransaction, { runBuild: actualBuild });
  await applyPublicationTransaction(firstTransaction, { state: emptyState, runBuild: actualBuild });
  const firstResult = await confirmPublicationTransaction(firstTransaction, { stateStore, push: false });
  assert.equal(firstResult.pushed, false);
  assert.ok(await exists(path.join(repoRoot, 'dist', 'blog', 'copper-cycle', 'index.html')) === false, 'isolated builds must not write dist into the live repository');
  const committed = (await command('git', ['show', '--pretty=', '--name-only', firstResult.commitSha], repoRoot)).stdout.trim().split('\n').sort();
  assert.deepEqual(committed, [
    `public/media/copper-cycle/${article.assets[0].outputName}`,
    'src/content/entries/copper-cycle.md',
    'src/content/entries/copper-inventory-log.md',
  ]);
  assert.equal(await readFile(path.join(repoRoot, 'UNRELATED.local'), 'utf8'), 'preserve me');
  const emitted = await readFile(path.join(repoRoot, 'src/content/entries/copper-cycle.md'), 'utf8');
  const emittedLog = await readFile(path.join(repoRoot, 'src/content/entries/copper-inventory-log.md'), 'utf8');
  const persistedState = await readFile(path.join(repoRoot, '.publish-state.json'), 'utf8');
  assert.doesNotMatch(emitted, new RegExp(vaultRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.doesNotMatch(`${emitted}\n${emittedLog}\n${persistedState}`, new RegExp(vaultRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.doesNotMatch(emitted, /绝不公开/u);
  assert.deepEqual(await snapshot(vaultRoot), vaultBefore);

  await writeFile(path.join(vaultRoot, 'Logs', '库存跟踪.md'), longLogMarkdown('更新：现货升水扩大。'));
  const updatedVault = await snapshot(vaultRoot);
  const priorState = await stateStore.readState();
  const updateNotes = await transformedPending(vaultRoot, priorState);
  assert.deepEqual(updateNotes.map(({ publishId }) => publishId), ['copper-inventory-log']);
  const updateTransaction = await createPublicationTransaction({ ...transactionOptions, notes: updateNotes, state: priorState });
  await buildTransactionPreview(updateTransaction, { runBuild: async () => ({ stdout: 'preview ok', stderr: '' }) });
  await applyPublicationTransaction(updateTransaction, { state: priorState, runBuild: async () => ({ stdout: 'build ok', stderr: '' }) });
  const updateResult = await confirmPublicationTransaction(updateTransaction, { stateStore, push: false });
  const updatedEntry = await readFile(path.join(repoRoot, 'src/content/entries/copper-inventory-log.md'), 'utf8');
  assert.match(updatedEntry, /updated_at:/u);
  assert.deepEqual((await command('git', ['show', '--pretty=', '--name-only', updateResult.commitSha], repoRoot)).stdout.trim().split('\n'), ['src/content/entries/copper-inventory-log.md']);
  assert.deepEqual(await snapshot(vaultRoot), updatedVault);
  assert.equal((await command('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoRoot)).stdout.trim(), '?? UNRELATED.local');
});
