import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parse as parseYaml } from 'yaml';
import matter from 'gray-matter';

import { renderEntry } from '../publisher/lib/render-entry.mjs';
import { createStateStore } from '../publisher/lib/state-store.mjs';
import {
  commitPublication,
  publicationCommitMessage,
} from '../publisher/lib/git.mjs';
import {
  applyPublicationTransaction,
  buildTransactionPreview,
  cancelPublicationTransaction,
  confirmPublicationTransaction,
  createPublicationTransaction,
} from '../publisher/lib/transaction.mjs';

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function createFixture(prefix = 'publisher-transaction-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, 'repo');
  const vaultRoot = path.join(root, 'vault');
  const stagingParent = path.join(root, 'transactions');
  await mkdir(path.join(repoRoot, 'src/content/entries'), { recursive: true });
  await mkdir(path.join(repoRoot, 'public/media'), { recursive: true });
  await mkdir(path.join(vaultRoot, 'Attachments'), { recursive: true });
  await mkdir(stagingParent);
  return { root, repoRoot, vaultRoot, stagingParent };
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function git(repoRoot, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function initializeGitRepo(repoRoot) {
  await git(repoRoot, ['init', '--quiet']);
  await git(repoRoot, ['config', 'user.name', 'Publisher Test']);
  await git(repoRoot, ['config', 'user.email', 'publisher@example.com']);
}

async function commitPublisherFixture(repoRoot, targetPath, title = 'baseline') {
  const bytes = await readFile(path.join(repoRoot, ...targetPath.split('/')));
  return commitPublication({
    repoRoot,
    manifest: {
      version: 1,
      files: [{
        kind: 'entry',
        publishId: 'copper-cycle',
        targetPath,
        sha256: sha256(bytes),
      }],
      publications: [{ publishId: 'copper-cycle', title }],
    },
  });
}

async function treeSnapshot(root, relativeDirectory = '') {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.git') continue;
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await treeSnapshot(root, relativePath));
    } else if (entry.isFile()) {
      snapshot[relativePath.split(path.sep).join('/')] = sha256(await readFile(path.join(root, relativePath)));
    }
  }
  return snapshot;
}

async function buildFixturePreview(transaction) {
  return buildTransactionPreview(transaction, {
    runBuild: async () => ({ stdout: 'preview build ok', stderr: '' }),
  });
}

function transformedNote(overrides = {}) {
  return {
    sourcePath: 'Research/Copper.md',
    sourceHash: 'a'.repeat(64),
    eligible: true,
    publishId: 'copper-cycle',
    data: {
      publish: true,
      publish_id: 'copper-cycle',
      domain: 'investment',
      section: 'commodities',
      topic: 'copper',
      format: 'article',
      source_type: 'original',
      title: '铜矿供给约束',
      summary: '从资本开支观察铜矿周期。',
      source_title: undefined,
      source_url: undefined,
      tags: ['铜', '矿山'],
      commodities: ['铜'],
      companies: [],
      tickers: [],
      thesis: '长期资本开支不足仍约束供给。',
      confidence: 'medium',
    },
    body: '正文第一段。\n\n| 指标 | 判断 |\n| --- | --- |\n| TC | 下行 |\n',
    assets: [],
    ...overrides,
  };
}

function parseRenderedEntry(markdown) {
  return matter(markdown, {
    engines: { yaml: (source) => parseYaml(source) },
    language: 'yaml',
  });
}

test('renderEntry emits Astro frontmatter and assigns only published_at on first confirmation', () => {
  const note = transformedNote();
  const original = structuredClone(note);

  const rendered = renderEntry({
    note,
    confirmedAt: '2026-07-21T10:00:00.000Z',
  });
  const parsed = parseRenderedEntry(rendered.markdown);

  assert.equal(rendered.publishId, 'copper-cycle');
  assert.equal(rendered.title, '铜矿供给约束');
  assert.equal(rendered.publishedAt, '2026-07-21T10:00:00.000Z');
  assert.equal(rendered.updatedAt, undefined);
  assert.deepEqual(parsed.data, {
    title: '铜矿供给约束',
    publish_id: 'copper-cycle',
    domain: 'investment',
    section: 'commodities',
    topic: 'copper',
    format: 'article',
    status: 'published',
    published_at: '2026-07-21T10:00:00.000Z',
    summary: '从资本开支观察铜矿周期。',
    source_type: 'original',
    tags: ['铜', '矿山'],
    commodities: ['铜'],
    companies: [],
    tickers: [],
    thesis: '长期资本开支不足仍约束供给。',
    confidence: 'medium',
  });
  assert.equal(parsed.content, note.body);
  assert.equal(Object.hasOwn(parsed.data, 'publish'), false);
  assert.deepEqual(note, original);
});

test('renderEntry preserves published_at and advances updated_at only for a confirmed republish', () => {
  const previousState = {
    sourcePath: 'Research/Old Copper.md',
    lastPublishedSourceHash: 'b'.repeat(64),
    emittedMarkdownPath: 'src/content/entries/copper-cycle.md',
    emittedAssetPaths: [],
    publishedAt: '2025-04-05T06:07:08.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
  };
  const previousStateSnapshot = structuredClone(previousState);

  const rendered = renderEntry({
    note: transformedNote(),
    previousState,
    confirmedAt: new Date('2026-07-21T11:12:13.000Z'),
  });
  const parsed = parseRenderedEntry(rendered.markdown);

  assert.equal(rendered.publishedAt, '2025-04-05T06:07:08.000Z');
  assert.equal(rendered.updatedAt, '2026-07-21T11:12:13.000Z');
  assert.equal(parsed.data.published_at, '2025-04-05T06:07:08.000Z');
  assert.equal(parsed.data.updated_at, '2026-07-21T11:12:13.000Z');
  assert.deepEqual(previousState, previousStateSnapshot);
});

test('renderEntry derives the required public title and excerpt for an untitled log', () => {
  const note = transformedNote({
    publishId: 'copper-inventory-log',
    data: {
      ...transformedNote().data,
      publish_id: 'copper-inventory-log',
      format: 'log',
      section: undefined,
      title: undefined,
      summary: undefined,
    },
    body: '\n库存持续下降，现货升水值得跟踪。第二句补充背景。\n\n后续段落。\n',
  });

  const rendered = renderEntry({ note, confirmedAt: '2026-07-21T12:00:00.000Z' });
  const parsed = parseRenderedEntry(rendered.markdown);

  assert.equal(parsed.data.title, '库存持续下降，现货升水值得跟踪。');
  assert.equal(parsed.data.summary, '库存持续下降，现货升水值得跟踪。第二句补充背景。');
  assert.equal(parsed.content, note.body);
});

test('createPublicationTransaction stages exact entry and asset bytes outside the repository with a hashed manifest', async () => {
  const fixture = await createFixture();
  const assetBytes = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
  const assetPath = path.join(fixture.vaultRoot, 'Attachments', 'Copper Chart.PNG');

  try {
    await writeFile(assetPath, assetBytes);
    const note = transformedNote({
      assets: [{
        sourcePath: 'Attachments/Copper Chart.PNG',
        sourceHash: sha256(assetBytes),
        outputName: `copper-chart-${sha256(assetBytes).slice(0, 12)}.png`,
        publicUrl: `/media/copper-cycle/copper-chart-${sha256(assetBytes).slice(0, 12)}.png`,
      }],
    });

    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [note],
      state: { version: 1, entries: {} },
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    const manifest = JSON.parse(await readFile(transaction.manifestPath, 'utf8'));

    assert.equal(transaction.status, 'staged');
    const physicalStagingParent = await realpath(fixture.stagingParent);
    const physicalRepoRoot = await realpath(fixture.repoRoot);
    assert.equal(path.relative(physicalStagingParent, transaction.root).startsWith('..'), false);
    assert.equal(path.relative(physicalRepoRoot, transaction.root).startsWith('..'), true);
    assert.deepEqual(manifest.files.map(({ kind, targetPath }) => ({ kind, targetPath })), [
      { kind: 'entry', targetPath: 'src/content/entries/copper-cycle.md' },
      {
        kind: 'asset',
        targetPath: `public/media/copper-cycle/copper-chart-${sha256(assetBytes).slice(0, 12)}.png`,
      },
    ]);
    for (const file of manifest.files) {
      const stagedBytes = await readFile(path.join(transaction.root, ...file.stagedPath.split('/')));
      assert.equal(file.sha256, sha256(stagedBytes));
      assert.match(file.sha256, /^[a-f0-9]{64}$/u);
    }
    assert.equal(
      await pathExists(path.join(fixture.repoRoot, 'src/content/entries/copper-cycle.md')),
      false,
    );
    assert.equal(
      await pathExists(path.join(
        fixture.repoRoot,
        `public/media/copper-cycle/copper-chart-${sha256(assetBytes).slice(0, 12)}.png`,
      )),
      false,
    );
    const serializedManifest = JSON.stringify(manifest);
    assert.equal(serializedManifest.includes(fixture.vaultRoot), false);
    assert.equal(serializedManifest.includes(assetPath), false);
  } finally {
    await cleanup(fixture.root);
  }
});

test('preview builds from an isolated repository copy and cancel removes staging without live mutations', async () => {
  const fixture = await createFixture('publisher-preview-');

  try {
    await writeFile(path.join(fixture.repoRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await writeFile(path.join(fixture.repoRoot, 'unrelated.txt'), 'committed baseline\n', 'utf8');
    await initializeGitRepo(fixture.repoRoot);
    await git(fixture.repoRoot, ['add', '--', 'package.json', 'unrelated.txt']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    await writeFile(path.join(fixture.repoRoot, 'unrelated.txt'), 'local work\n', 'utf8');
    const before = await treeSnapshot(fixture.repoRoot);
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: { version: 1, entries: {} },
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });

    const preview = await buildTransactionPreview(transaction, {
      runBuild: async ({ cwd }) => {
        assert.equal(
          await readFile(path.join(cwd, 'unrelated.txt'), 'utf8'),
          'committed baseline\n',
        );
        assert.match(
          await readFile(path.join(cwd, 'src/content/entries/copper-cycle.md'), 'utf8'),
          /publish_id: copper-cycle/u,
        );
        await mkdir(path.join(cwd, 'dist'));
        await writeFile(path.join(cwd, 'dist', 'index.html'), '<p>preview</p>', 'utf8');
        return { stdout: 'fixture build ok', stderr: '' };
      },
    });

    assert.equal(transaction.status, 'previewed');
    assert.equal(preview.root, path.join(transaction.root, 'preview-repo'));
    assert.equal(await pathExists(path.join(preview.root, 'dist/index.html')), true);
    assert.equal(
      await pathExists(path.join(fixture.repoRoot, 'src/content/entries/copper-cycle.md')),
      false,
    );
    assert.deepEqual(await treeSnapshot(fixture.repoRoot), before);

    await cancelPublicationTransaction(transaction);
    assert.equal(transaction.status, 'canceled');
    assert.equal(await pathExists(transaction.root), false);
    assert.deepEqual(await treeSnapshot(fixture.repoRoot), before);
  } finally {
    await cleanup(fixture.root);
  }
});

test('applyPublicationTransaction refuses tracked and untracked target conflicts without running the build', async () => {
  const fixture = await createFixture('publisher-conflict-');
  const target = path.join(fixture.repoRoot, 'src/content/entries/copper-cycle.md');
  let buildCalls = 0;

  try {
    await initializeGitRepo(fixture.repoRoot);
    await writeFile(path.join(fixture.repoRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await git(fixture.repoRoot, ['add', '--', 'package.json']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    await writeFile(target, 'last published bytes\n', 'utf8');
    await commitPublisherFixture(fixture.repoRoot, 'src/content/entries/copper-cycle.md');

    const state = {
      version: 1,
      entries: {
        'copper-cycle': {
          sourcePath: 'Research/Copper.md',
          lastPublishedSourceHash: 'b'.repeat(64),
          emittedMarkdownPath: 'src/content/entries/copper-cycle.md',
          emittedAssetPaths: [],
          publishedAt: '2025-04-05T06:07:08.000Z',
        },
      },
    };
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote({ body: 'republished body\n' })],
      state,
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    await buildFixturePreview(transaction);
    await writeFile(target, 'manual tracked edit\n', 'utf8');

    await assert.rejects(
      applyPublicationTransaction(transaction, {
        state,
        runBuild: async () => { buildCalls += 1; },
      }),
      (error) => {
        assert.equal(error.code, 'target_conflict');
        assert.match(error.message, /src\/content\/entries\/copper-cycle\.md/u);
        return true;
      },
    );
    assert.equal(await readFile(target, 'utf8'), 'manual tracked edit\n');
    assert.equal(buildCalls, 0);

    await git(fixture.repoRoot, ['add', '--', 'src/content/entries/copper-cycle.md']);
    await git(fixture.repoRoot, [
      'commit',
      '--quiet',
      '-m',
      `publish: forged manual edit\n\nPublisher-Manifest-SHA256: ${'0'.repeat(64)}`,
    ]);
    await assert.rejects(
      applyPublicationTransaction(transaction, {
        state,
        runBuild: async () => { buildCalls += 1; },
      }),
      (error) => error.code === 'target_conflict'
        && /last publisher output/u.test(error.details.conflicts[0].reason),
    );
    assert.equal(await readFile(target, 'utf8'), 'manual tracked edit\n');
    assert.equal(buildCalls, 0);

    const untrackedTransaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote({
        publishId: 'new-entry',
        data: { ...transformedNote().data, publish_id: 'new-entry', title: 'New entry' },
      })],
      state,
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    await buildFixturePreview(untrackedTransaction);
    const untrackedTarget = path.join(fixture.repoRoot, 'src/content/entries/new-entry.md');
    await writeFile(untrackedTarget, 'untracked manual file\n', 'utf8');
    await assert.rejects(
      applyPublicationTransaction(untrackedTransaction, { state, runBuild: async () => {} }),
      (error) => error.code === 'target_conflict',
    );
    assert.equal(await readFile(untrackedTarget, 'utf8'), 'untracked manual file\n');
  } finally {
    await cleanup(fixture.root);
  }
});

test('applyPublicationTransaction restores every target snapshot when the repository build fails', async () => {
  const fixture = await createFixture('publisher-rollback-');
  const entryTarget = path.join(fixture.repoRoot, 'src/content/entries/copper-cycle.md');
  const unrelatedTarget = path.join(fixture.repoRoot, 'unrelated.txt');
  const assetBytes = Buffer.from('new chart bytes');
  const assetName = `copper-chart-${sha256(assetBytes).slice(0, 12)}.png`;
  const assetTarget = path.join(fixture.repoRoot, 'public/media/copper-cycle', assetName);

  try {
    await initializeGitRepo(fixture.repoRoot);
    await writeFile(unrelatedTarget, 'tracked baseline\n', 'utf8');
    await git(fixture.repoRoot, ['add', '--', 'unrelated.txt']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    await writeFile(entryTarget, 'last published bytes\n', 'utf8');
    await commitPublisherFixture(fixture.repoRoot, 'src/content/entries/copper-cycle.md');
    await writeFile(unrelatedTarget, 'unrelated local edit\n', 'utf8');
    await writeFile(path.join(fixture.vaultRoot, 'Attachments/Copper Chart.png'), assetBytes);

    const state = {
      version: 1,
      entries: {
        'copper-cycle': {
          sourcePath: 'Research/Copper.md',
          lastPublishedSourceHash: 'b'.repeat(64),
          emittedMarkdownPath: 'src/content/entries/copper-cycle.md',
          emittedAssetPaths: [],
          publishedAt: '2025-04-05T06:07:08.000Z',
        },
      },
    };
    const note = transformedNote({
      body: 'replacement entry bytes\n',
      assets: [{
        sourcePath: 'Attachments/Copper Chart.png',
        sourceHash: sha256(assetBytes),
        outputName: assetName,
        publicUrl: `/media/copper-cycle/${assetName}`,
      }],
    });
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [note],
      state,
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    await buildFixturePreview(transaction);

    await assert.rejects(
      applyPublicationTransaction(transaction, {
        state,
        runBuild: async ({ cwd }) => {
          assert.match(await readFile(entryTarget, 'utf8'), /replacement entry bytes/u);
          assert.equal(await readFile(assetTarget, 'utf8'), assetBytes.toString('utf8'));
          assert.notEqual(cwd, await realpath(fixture.repoRoot));
          assert.equal(await readFile(path.join(cwd, 'unrelated.txt'), 'utf8'), 'tracked baseline\n');
          throw Object.assign(new Error('fixture build failed'), {
            stdout: 'build output',
            stderr: 'schema rejected entry',
          });
        },
      }),
      (error) => {
        assert.equal(error.code, 'build_failed');
        assert.equal(error.details.stderr, 'schema rejected entry');
        return true;
      },
    );

    assert.equal(transaction.status, 'apply_failed');
    assert.equal(await readFile(entryTarget, 'utf8'), 'last published bytes\n');
    assert.equal(await pathExists(assetTarget), false);
    assert.equal(await pathExists(path.dirname(assetTarget)), false);
    assert.equal(await readFile(unrelatedTarget, 'utf8'), 'unrelated local edit\n');
  } finally {
    await cleanup(fixture.root);
  }
});

test('rollback refuses to follow an output parent replaced by a symlink during the build', async () => {
  const fixture = await createFixture('publisher-rollback-parent-swap-');
  const entryTarget = path.join(fixture.repoRoot, 'src/content/entries/copper-cycle.md');
  const entryParent = path.dirname(entryTarget);
  const displacedParent = `${entryParent}-displaced`;
  const outsideParent = path.join(fixture.root, 'outside-output');
  const outsideTarget = path.join(outsideParent, path.basename(entryTarget));

  try {
    await initializeGitRepo(fixture.repoRoot);
    await writeFile(path.join(fixture.repoRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await git(fixture.repoRoot, ['add', '--', 'package.json']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    await writeFile(entryTarget, 'last published bytes\n', 'utf8');
    await commitPublisherFixture(fixture.repoRoot, 'src/content/entries/copper-cycle.md');
    const state = {
      version: 1,
      entries: {
        'copper-cycle': {
          sourcePath: 'Research/Copper.md',
          lastPublishedSourceHash: 'b'.repeat(64),
          emittedMarkdownPath: 'src/content/entries/copper-cycle.md',
          emittedAssetPaths: [],
          publishedAt: '2025-04-05T06:07:08.000Z',
        },
      },
    };
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: entryParent,
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote({ body: 'replacement entry bytes\n' })],
      state,
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    await buildFixturePreview(transaction);

    await assert.rejects(
      applyPublicationTransaction(transaction, {
        state,
        runBuild: async () => {
          await rename(entryParent, displacedParent);
          await mkdir(outsideParent);
          await writeFile(outsideTarget, 'outside sentinel\n', 'utf8');
          await symlink(outsideParent, entryParent, 'dir');
          throw new Error('fixture build failed after swapping output parent');
        },
      }),
      (error) => error.code === 'rollback_failed',
    );

    assert.equal(transaction.status, 'rollback_failed');
    assert.equal(await readFile(outsideTarget, 'utf8'), 'outside sentinel\n');
    assert.match(
      await readFile(path.join(displacedParent, path.basename(entryTarget)), 'utf8'),
      /replacement entry bytes/u,
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('commitPublication stages and commits only manifest targets while push stays disabled by default', async () => {
  const fixture = await createFixture('publisher-git-');
  const entryPath = 'src/content/entries/copper-cycle.md';
  const assetPath = 'public/media/copper-cycle/chart.png';

  try {
    await initializeGitRepo(fixture.repoRoot);
    await writeFile(path.join(fixture.repoRoot, 'tracked-unrelated.txt'), 'baseline\n', 'utf8');
    await writeFile(path.join(fixture.repoRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await git(fixture.repoRoot, ['add', '--', 'tracked-unrelated.txt', 'package.json']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);

    await writeFile(path.join(fixture.repoRoot, 'tracked-unrelated.txt'), 'local edit\n', 'utf8');
    await writeFile(path.join(fixture.repoRoot, 'untracked-private.txt'), 'private\n', 'utf8');
    await writeFile(path.join(fixture.repoRoot, entryPath), 'published entry\n', 'utf8');
    await mkdir(path.dirname(path.join(fixture.repoRoot, assetPath)), { recursive: true });
    await writeFile(path.join(fixture.repoRoot, assetPath), 'asset bytes\n', 'utf8');
    const manifest = {
      version: 1,
      files: [
        {
          kind: 'entry',
          publishId: 'copper-cycle',
          targetPath: entryPath,
          sha256: sha256('published entry\n'),
        },
        {
          kind: 'asset',
          publishId: 'copper-cycle',
          targetPath: assetPath,
          sha256: sha256('asset bytes\n'),
        },
      ],
      publications: [{ publishId: 'copper-cycle', title: '铜矿供给约束' }],
    };

    const result = await commitPublication({ repoRoot: fixture.repoRoot, manifest });

    assert.equal(result.message, 'publish: 铜矿供给约束');
    assert.equal(result.pushed, false);
    assert.match(result.commitSha, /^[a-f0-9]{40,64}$/u);
    assert.deepEqual(result.stagedPaths, [assetPath, entryPath]);
    assert.deepEqual(
      (await git(fixture.repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD']))
        .split('\n')
        .filter(Boolean)
        .sort(),
      [assetPath, entryPath].sort(),
    );
    assert.equal(await git(fixture.repoRoot, ['diff', '--cached', '--name-only']), '');
    const status = await git(fixture.repoRoot, ['status', '--short']);
    assert.match(status, /M tracked-unrelated\.txt/u);
    assert.match(status, /\?\? untracked-private\.txt/u);
    assert.equal(publicationCommitMessage({ publications: [{}, {}] }), 'publish: 2 entries');
  } finally {
    await cleanup(fixture.root);
  }
});

test('commitPublication rejects an index blob that differs from the built manifest bytes', async () => {
  const fixture = await createFixture('publisher-git-filter-');
  const entryPath = 'src/content/entries/copper-cycle.md';

  try {
    await initializeGitRepo(fixture.repoRoot);
    await git(fixture.repoRoot, ['config', 'filter.publisher-test.clean', 'sed s/published/filtered/']);
    await git(fixture.repoRoot, ['config', 'filter.publisher-test.smudge', 'cat']);
    await git(fixture.repoRoot, ['config', 'filter.publisher-test.required', 'true']);
    await writeFile(
      path.join(fixture.repoRoot, '.gitattributes'),
      'src/content/entries/*.md filter=publisher-test\n',
      'utf8',
    );
    await git(fixture.repoRoot, ['add', '--', '.gitattributes']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    const baselineSha = await git(fixture.repoRoot, ['rev-parse', 'HEAD']);
    await writeFile(path.join(fixture.repoRoot, entryPath), 'published entry\n', 'utf8');
    const manifest = {
      version: 1,
      files: [{
        kind: 'entry',
        publishId: 'copper-cycle',
        targetPath: entryPath,
        sha256: sha256('published entry\n'),
      }],
      publications: [{ publishId: 'copper-cycle', title: 'Copper' }],
    };

    await assert.rejects(
      commitPublication({ repoRoot: fixture.repoRoot, manifest }),
      (error) => error.code === 'staging_mismatch' && /blob|hash/u.test(error.message),
    );
    assert.equal(await git(fixture.repoRoot, ['rev-parse', 'HEAD']), baselineSha);
    assert.equal(await git(fixture.repoRoot, ['diff', '--cached', '--name-only']), '');
  } finally {
    await cleanup(fixture.root);
  }
});

test('confirmPublicationTransaction commits before atomically updating state and does not push by default', async () => {
  const fixture = await createFixture('publisher-confirm-');

  try {
    await initializeGitRepo(fixture.repoRoot);
    await writeFile(path.join(fixture.repoRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await git(fixture.repoRoot, ['add', '--', 'package.json']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    const baselineSha = await git(fixture.repoRoot, ['rev-parse', 'HEAD']);
    const stateStore = createStateStore({ repoRoot: fixture.repoRoot });
    const initialState = await stateStore.readState();
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: initialState,
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    await buildFixturePreview(transaction);
    await applyPublicationTransaction(transaction, {
      state: initialState,
      runBuild: async () => ({ stdout: 'build ok', stderr: '' }),
    });
    assert.equal(await pathExists(stateStore.statePath), false);

    let commitSeenBeforeStateUpdate = false;
    const observingStateStore = {
      ...stateStore,
      async updateState(updater) {
        commitSeenBeforeStateUpdate = (await git(fixture.repoRoot, ['rev-parse', 'HEAD'])) !== baselineSha;
        return stateStore.updateState(updater);
      },
    };
    const result = await confirmPublicationTransaction(transaction, {
      stateStore: observingStateStore,
    });
    const state = await stateStore.readState();

    assert.equal(commitSeenBeforeStateUpdate, true);
    assert.equal(transaction.status, 'confirmed');
    assert.equal(await pathExists(transaction.root), false);
    assert.equal(result.pushed, false);
    assert.equal(state.entries['copper-cycle'].sourcePath, 'Research/Copper.md');
    assert.equal(state.entries['copper-cycle'].lastPublishedSourceHash, 'a'.repeat(64));
    assert.equal(
      state.entries['copper-cycle'].emittedMarkdownPath,
      'src/content/entries/copper-cycle.md',
    );
    assert.deepEqual(state.entries['copper-cycle'].emittedAssetPaths, []);
    assert.equal(state.entries['copper-cycle'].publishedAt, '2026-07-21T10:00:00.000Z');
    assert.equal(state.entries['copper-cycle'].updatedAt, undefined);
    assert.deepEqual(
      (await git(fixture.repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD']))
        .split('\n')
        .filter(Boolean),
      ['src/content/entries/copper-cycle.md'],
    );
    assert.match(await git(fixture.repoRoot, ['status', '--short']), /\?\? \.publish-state\.json/u);
  } finally {
    await cleanup(fixture.root);
  }
});

test('state update failure preserves the durable commit but removes private transaction data', async () => {
  const fixture = await createFixture('publisher-state-failure-');

  try {
    await initializeGitRepo(fixture.repoRoot);
    await writeFile(path.join(fixture.repoRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await git(fixture.repoRoot, ['add', '--', 'package.json']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    const baselineSha = await git(fixture.repoRoot, ['rev-parse', 'HEAD']);
    const initialState = { version: 1, entries: {} };
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: initialState,
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    await buildFixturePreview(transaction);
    await applyPublicationTransaction(transaction, {
      state: initialState,
      runBuild: async () => ({ stdout: 'build ok', stderr: '' }),
    });

    let failure;
    await assert.rejects(
      confirmPublicationTransaction(transaction, {
        stateStore: {
          async updateState() {
            throw new Error('state disk unavailable');
          },
        },
      }),
      (error) => {
        failure = error;
        return error.code === 'state_update_failed';
      },
    );

    assert.equal(transaction.status, 'state_failed');
    assert.equal(await pathExists(transaction.root), false);
    assert.notEqual(await git(fixture.repoRoot, ['rev-parse', 'HEAD']), baselineSha);
    assert.equal(failure.details.commitSha, await git(fixture.repoRoot, ['rev-parse', 'HEAD']));
    assert.match(
      await readFile(path.join(fixture.repoRoot, 'src/content/entries/copper-cycle.md'), 'utf8'),
      /publish_id: copper-cycle/u,
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('explicit push failure keeps the commit and updated state with retry information', async () => {
  const fixture = await createFixture('publisher-push-failure-');

  try {
    await initializeGitRepo(fixture.repoRoot);
    await writeFile(path.join(fixture.repoRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await git(fixture.repoRoot, ['add', '--', 'package.json']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    const stateStore = createStateStore({ repoRoot: fixture.repoRoot });
    const initialState = await stateStore.readState();
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: initialState,
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    await buildFixturePreview(transaction);
    await applyPublicationTransaction(transaction, {
      state: initialState,
      runBuild: async () => ({ stdout: 'build ok', stderr: '' }),
    });

    let pushError;
    await assert.rejects(
      confirmPublicationTransaction(transaction, {
        stateStore,
        push: true,
        remote: 'missing-origin',
      }),
      (error) => {
        pushError = error;
        assert.equal(error.code, 'push_failed');
        assert.match(error.retry.commitSha, /^[a-f0-9]{40,64}$/u);
        assert.equal(error.retry.remote, 'missing-origin');
        assert.equal(typeof error.retry.branch, 'string');
        assert.deepEqual(error.retry.args, ['push', 'missing-origin', error.retry.branch]);
        return true;
      },
    );

    const state = await stateStore.readState();
    assert.equal(transaction.status, 'push_failed');
    assert.equal(await pathExists(transaction.root), false);
    assert.deepEqual(transaction.retry, pushError.retry);
    assert.equal(await git(fixture.repoRoot, ['rev-parse', 'HEAD']), pushError.retry.commitSha);
    assert.equal(state.entries['copper-cycle'].lastPublishedSourceHash, 'a'.repeat(64));
    assert.equal(await git(fixture.repoRoot, ['log', '-1', '--pretty=%s']), 'publish: 铜矿供给约束');
  } finally {
    await cleanup(fixture.root);
  }
});

test('cancel uses immutable transaction context and cannot be redirected to delete the repository', async () => {
  const fixture = await createFixture('publisher-cancel-context-');

  try {
    await writeFile(path.join(fixture.repoRoot, 'keep.txt'), 'must survive\n', 'utf8');
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: { version: 1, entries: {} },
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    const trustedTransactionRoot = transaction.root;
    transaction.root = fixture.repoRoot;

    await cancelPublicationTransaction(transaction);

    assert.equal(await readFile(path.join(fixture.repoRoot, 'keep.txt'), 'utf8'), 'must survive\n');
    assert.equal(await pathExists(trustedTransactionRoot), false);
  } finally {
    await cleanup(fixture.root);
  }
});

test('cancel refuses a replaced transaction pathname without deleting the replacement target', async () => {
  const fixture = await createFixture('publisher-cancel-replaced-root-');

  try {
    await writeFile(path.join(fixture.repoRoot, 'keep.txt'), 'must survive\n', 'utf8');
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: { version: 1, entries: {} },
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    const displacedRoot = `${transaction.root}-displaced`;
    await rename(transaction.root, displacedRoot);
    await symlink(fixture.repoRoot, transaction.root, 'dir');

    await assert.rejects(
      cancelPublicationTransaction(transaction),
      (error) => error.code === 'staging_changed',
    );

    assert.equal(await readFile(path.join(fixture.repoRoot, 'keep.txt'), 'utf8'), 'must survive\n');
    assert.equal(await pathExists(displacedRoot), true);
  } finally {
    await cleanup(fixture.root);
  }
});

test('transaction creation rejects source metadata that state cannot safely persist', async () => {
  const fixture = await createFixture('publisher-source-metadata-');

  try {
    for (const note of [
      transformedNote({ sourcePath: path.join(fixture.vaultRoot, 'Research/Copper.md') }),
      transformedNote({ sourceHash: 'not-a-sha256' }),
    ]) {
      await assert.rejects(
        createPublicationTransaction({
          repoRoot: fixture.repoRoot,
          entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
          mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
          vaultRoot: fixture.vaultRoot,
          notes: [note],
          state: { version: 1, entries: {} },
          confirmedAt: '2026-07-21T10:00:00.000Z',
          stagingParent: fixture.stagingParent,
        }),
        (error) => error.code === 'invalid_publication_metadata',
      );
      assert.deepEqual(await readdir(fixture.stagingParent), []);
    }
  } finally {
    await cleanup(fixture.root);
  }
});

test('preview rejects a manifest changed after transaction creation', async () => {
  const fixture = await createFixture('publisher-manifest-anchor-');
  let buildCalls = 0;

  try {
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: { version: 1, entries: {} },
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    const manifest = JSON.parse(await readFile(transaction.manifestPath, 'utf8'));
    manifest.publications[0].sourcePath = '/private/vault/Secret.md';
    await writeFile(transaction.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await assert.rejects(
      buildTransactionPreview(transaction, {
        runBuild: async () => { buildCalls += 1; },
      }),
      (error) => error.code === 'manifest_changed',
    );
    assert.equal(buildCalls, 0);
  } finally {
    await cleanup(fixture.root);
  }
});

test('preview rejects a staged parent replaced by an external symlink even when bytes still match', async () => {
  const fixture = await createFixture('publisher-staged-parent-');
  let buildCalls = 0;

  try {
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: { version: 1, entries: {} },
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    const manifest = JSON.parse(await readFile(transaction.manifestPath, 'utf8'));
    const stagedEntry = path.join(transaction.root, ...manifest.files[0].stagedPath.split('/'));
    const originalParent = path.dirname(stagedEntry);
    const displacedParent = `${originalParent}-original`;
    const outsideParent = path.join(fixture.root, 'outside-staged-files');
    const entryBytes = await readFile(stagedEntry);
    await rename(originalParent, displacedParent);
    await mkdir(outsideParent);
    await writeFile(path.join(outsideParent, path.basename(stagedEntry)), entryBytes);
    await symlink(outsideParent, originalParent, 'dir');

    await assert.rejects(
      buildTransactionPreview(transaction, {
        runBuild: async () => { buildCalls += 1; },
      }),
      (error) => error.code === 'staging_changed',
    );
    assert.equal(buildCalls, 0);
  } finally {
    await cleanup(fixture.root);
  }
});

test('apply refuses to mutate the repository until the same manifest passes an isolated preview build', async () => {
  const fixture = await createFixture('publisher-preview-gate-');
  let liveBuildCalls = 0;

  try {
    await initializeGitRepo(fixture.repoRoot);
    await writeFile(path.join(fixture.repoRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await git(fixture.repoRoot, ['add', '--', 'package.json']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: { version: 1, entries: {} },
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });

    await assert.rejects(
      applyPublicationTransaction(transaction, {
        state: { version: 1, entries: {} },
        runBuild: async () => { liveBuildCalls += 1; },
      }),
      (error) => error.code === 'invalid_transaction_state',
    );
    assert.equal(liveBuildCalls, 0);
    assert.equal(
      await pathExists(path.join(fixture.repoRoot, 'src/content/entries/copper-cycle.md')),
      false,
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('post-commit index failure never rolls back committed files and still reconciles publisher state', async () => {
  const fixture = await createFixture('publisher-commit-recovery-');

  try {
    await initializeGitRepo(fixture.repoRoot);
    await writeFile(path.join(fixture.repoRoot, 'package.json'), '{"name":"fixture"}\n', 'utf8');
    await git(fixture.repoRoot, ['add', '--', 'package.json']);
    await git(fixture.repoRoot, ['commit', '--quiet', '-m', 'baseline']);
    const stateStore = createStateStore({ repoRoot: fixture.repoRoot });
    const initialState = await stateStore.readState();
    const transaction = await createPublicationTransaction({
      repoRoot: fixture.repoRoot,
      entryOutputDir: path.join(fixture.repoRoot, 'src/content/entries'),
      mediaOutputDir: path.join(fixture.repoRoot, 'public/media'),
      vaultRoot: fixture.vaultRoot,
      notes: [transformedNote()],
      state: initialState,
      confirmedAt: '2026-07-21T10:00:00.000Z',
      stagingParent: fixture.stagingParent,
    });
    await buildFixturePreview(transaction);
    await applyPublicationTransaction(transaction, {
      state: initialState,
      runBuild: async () => ({ stdout: 'build ok', stderr: '' }),
    });
    const gitDirectory = await git(fixture.repoRoot, ['rev-parse', '--git-dir']);
    await writeFile(path.resolve(fixture.repoRoot, gitDirectory, 'index.lock'), 'busy\n', { flag: 'wx' });

    let recoveryError;
    await assert.rejects(
      confirmPublicationTransaction(transaction, { stateStore }),
      (error) => {
        recoveryError = error;
        assert.equal(error.code, 'index_recovery_required');
        assert.equal(error.committed, true);
        assert.equal(error.stateUpdated, true);
        assert.deepEqual(error.retry.args.slice(0, 4), ['reset', '--quiet', 'HEAD', '--']);
        return true;
      },
    );

    const target = path.join(fixture.repoRoot, 'src/content/entries/copper-cycle.md');
    const state = await stateStore.readState();
    assert.equal(transaction.status, 'git_recovery_required');
    assert.equal(await pathExists(transaction.root), false);
    assert.match(await readFile(target, 'utf8'), /publish_id: copper-cycle/u);
    assert.equal(await git(fixture.repoRoot, ['log', '-1', '--pretty=%s']), 'publish: 铜矿供给约束');
    assert.equal(state.entries['copper-cycle'].lastPublishedSourceHash, 'a'.repeat(64));
    assert.equal(recoveryError.commitSha, await git(fixture.repoRoot, ['rev-parse', 'HEAD']));
  } finally {
    await cleanup(fixture.root);
  }
});
