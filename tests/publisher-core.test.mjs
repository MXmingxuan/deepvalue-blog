import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ConfigValidationError,
  loadPublishConfig,
  validatePublishConfig,
} from '../publisher/lib/config.mjs';
import {
  FrontmatterParseError,
  isPublishEligible,
  normalizeFrontmatter,
  parseNoteMarkdown,
} from '../publisher/lib/frontmatter.mjs';
import { resolvePublishIdentity } from '../publisher/lib/identity.mjs';
import {
  INVESTMENT_SECTIONS,
  PublicationValidationError,
  assertValidPublicationNote,
  validatePublicationNote,
} from '../publisher/lib/validate.mjs';
import {
  StateValidationError,
  createStateStore,
} from '../publisher/lib/state-store.mjs';

async function createFixture(prefix = 'publisher-core-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(root, 'repo');
  const vaultRoot = path.join(root, 'vault');
  await mkdir(path.join(repoRoot, 'src/content/entries'), { recursive: true });
  await mkdir(path.join(repoRoot, 'public/media'), { recursive: true });
  await mkdir(path.join(vaultRoot, 'Attachments'), { recursive: true });
  return { root, repoRoot, vaultRoot };
}

async function removeFixture(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function validConfig(vaultRoot) {
  return {
    vaultRoot,
    entryOutputDir: 'src/content/entries',
    mediaOutputDir: 'public/media',
    attachmentRoots: ['Attachments'],
    ignoreFolders: ['.obsidian', '.trash'],
    includeInlineHashtags: true,
  };
}

const VALID_SOURCE_HASH = 'a'.repeat(64);

test('loadPublishConfig reports malformed JSON with filename and field diagnostics', async () => {
  const fixture = await createFixture();
  const configPath = path.join(fixture.repoRoot, 'publish.config.local.json');

  try {
    await writeFile(configPath, '{ invalid json', 'utf8');

    await assert.rejects(
      loadPublishConfig({ configPath, repoRoot: fixture.repoRoot }),
      (error) => {
        assert.equal(error instanceof ConfigValidationError, true);
        assert.equal(error.diagnostics.length, 1);
        assert.equal(error.diagnostics[0].filename, configPath);
        assert.equal(error.diagnostics[0].field, '<root>');
        assert.match(error.diagnostics[0].message, /valid JSON/i);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('validatePublishConfig resolves only contained Vault and repository paths', async () => {
  const fixture = await createFixture();

  try {
    const config = await validatePublishConfig(validConfig(fixture.vaultRoot), {
      filename: 'publish.config.local.json',
      repoRoot: fixture.repoRoot,
    });

    const physicalRepoRoot = await realpath(fixture.repoRoot);
    const physicalVaultRoot = await realpath(fixture.vaultRoot);
    assert.equal(config.repoRoot, physicalRepoRoot);
    assert.equal(config.vaultRoot, physicalVaultRoot);
    assert.equal(config.entryOutputDir, path.join(physicalRepoRoot, 'src/content/entries'));
    assert.equal(config.mediaOutputDir, path.join(physicalRepoRoot, 'public/media'));
    assert.deepEqual(config.attachmentRoots, [path.join(physicalVaultRoot, 'Attachments')]);
    assert.deepEqual(config.ignoreFolders, ['.obsidian', '.trash']);
    assert.equal(config.includeInlineHashtags, true);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('validatePublishConfig rejects relative or missing Vault roots', async () => {
  const fixture = await createFixture();

  try {
    await assert.rejects(
      validatePublishConfig(validConfig('relative/vault'), {
        filename: 'publish.config.local.json',
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.equal(error instanceof ConfigValidationError, true);
        assert.deepEqual(error.diagnostics.map(({ field }) => field), ['vaultRoot']);
        assert.match(error.diagnostics[0].message, /absolute/i);
        return true;
      },
    );

    const missingRoot = path.join(fixture.root, 'missing-vault');
    await assert.rejects(
      validatePublishConfig(validConfig(missingRoot), {
        filename: 'publish.config.local.json',
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.equal(error.diagnostics[0].field, 'vaultRoot');
        assert.match(error.diagnostics[0].message, /exist/i);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('validatePublishConfig reports every repository and Vault path escape', async () => {
  const fixture = await createFixture();

  try {
    await assert.rejects(
      validatePublishConfig({
        ...validConfig(fixture.vaultRoot),
        entryOutputDir: '../private-output',
        mediaOutputDir: path.join(fixture.root, 'absolute-output'),
        attachmentRoots: ['../Private Attachments'],
      }, {
        filename: 'publish.config.local.json',
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.equal(error instanceof ConfigValidationError, true);
        assert.deepEqual(
          error.diagnostics.map(({ filename, field }) => ({ filename, field })),
          [
            { filename: 'publish.config.local.json', field: 'entryOutputDir' },
            { filename: 'publish.config.local.json', field: 'mediaOutputDir' },
            { filename: 'publish.config.local.json', field: 'attachmentRoots[0]' },
          ],
        );
        return true;
      },
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('validatePublishConfig rejects output and attachment symlinks that escape their roots', async () => {
  const fixture = await createFixture();
  const outsideRepo = path.join(fixture.root, 'outside-repo');
  const outsideVault = path.join(fixture.root, 'outside-vault');

  try {
    await mkdir(outsideRepo);
    await mkdir(outsideVault);
    await symlink(outsideRepo, path.join(fixture.repoRoot, 'escaped-output'));
    await symlink(outsideVault, path.join(fixture.vaultRoot, 'Escaped Attachments'));

    await assert.rejects(
      validatePublishConfig({
        ...validConfig(fixture.vaultRoot),
        entryOutputDir: 'escaped-output/entries',
        attachmentRoots: ['Escaped Attachments'],
      }, {
        filename: 'publish.config.local.json',
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.deepEqual(
          error.diagnostics.map(({ field }) => field),
          ['entryOutputDir', 'attachmentRoots[0]'],
        );
        assert.equal(error.diagnostics.every(({ message }) => /outside/i.test(message)), true);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('validatePublishConfig rejects a Vault nested in the repository or a repository nested in the Vault', async () => {
  const fixture = await createFixture();
  try {
    const nestedVault = path.join(fixture.repoRoot, 'private-vault');
    await mkdir(path.join(nestedVault, 'Attachments'), { recursive: true });
    await assert.rejects(
      validatePublishConfig(validConfig(nestedVault), {
        filename: 'publish.config.local.json',
        repoRoot: fixture.repoRoot,
      }),
      (error) => {
        assert.deepEqual(error.diagnostics.map(({ field }) => field), ['vaultRoot']);
        assert.match(error.diagnostics[0].message, /must not contain|nested/i);
        return true;
      },
    );

    const nestedRepo = path.join(fixture.vaultRoot, 'blog-repository');
    await mkdir(path.join(nestedRepo, 'src/content/entries'), { recursive: true });
    await mkdir(path.join(nestedRepo, 'public/media'), { recursive: true });
    await assert.rejects(
      validatePublishConfig(validConfig(fixture.vaultRoot), {
        filename: 'publish.config.local.json',
        repoRoot: nestedRepo,
      }),
      (error) => {
        assert.deepEqual(error.diagnostics.map(({ field }) => field), ['vaultRoot']);
        assert.match(error.diagnostics[0].message, /must not contain|nested/i);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('parseNoteMarkdown parses YAML, normalizes public fields, and preserves the Markdown body exactly', () => {
  const source = `---
publish: true
publish_id: copper-supply-cycle
domain: investment
section: commodities
topic: null
format: article
title: 铜矿供给约束
summary: 从资本开支观察铜矿周期。
tags: 铜
commodities: [铜, 精矿]
companies: null
tickers: []
confidence: medium
---

# 正文

| 指标 | 结论 |
| --- | --- |
| TC | 下行 |
`;
  const expectedBody = `
# 正文

| 指标 | 结论 |
| --- | --- |
| TC | 下行 |
`;

  const parsed = parseNoteMarkdown(source, { filename: '研究/铜.md' });

  assert.equal(parsed.body, expectedBody);
  assert.equal(parsed.eligible, true);
  assert.deepEqual(parsed.data, {
    publish: true,
    publish_id: 'copper-supply-cycle',
    domain: 'investment',
    section: 'commodities',
    topic: undefined,
    format: 'article',
    source_type: 'original',
    title: '铜矿供给约束',
    summary: '从资本开支观察铜矿周期。',
    source_title: undefined,
    source_url: undefined,
    tags: ['铜'],
    commodities: ['铜', '精矿'],
    companies: [],
    tickers: [],
    thesis: undefined,
    confidence: 'medium',
  });
});

test('isPublishEligible accepts only the YAML boolean true', () => {
  assert.equal(isPublishEligible({ publish: true }), true);
  assert.equal(isPublishEligible({ publish: false }), false);
  assert.equal(isPublishEligible({ publish: 'true' }), false);
  assert.equal(isPublishEligible({ publish: 1 }), false);

  const quoted = parseNoteMarkdown('---\npublish: "true"\n---\nprivate body');
  assert.equal(quoted.eligible, false);
});

test('normalizeFrontmatter does not mutate input and keeps invalid array members visible to validation', () => {
  const input = {
    publish: true,
    domain: 'investment',
    format: 'log',
    tags: [' 铜 ', 7, ''],
    commodities: undefined,
  };
  const snapshot = structuredClone(input);

  const normalized = normalizeFrontmatter(input);

  assert.deepEqual(input, snapshot);
  assert.deepEqual(normalized.tags, ['铜', 7]);
  assert.deepEqual(normalized.commodities, []);
  assert.deepEqual(normalized.companies, []);
  assert.deepEqual(normalized.tickers, []);
  assert.equal(normalized.source_type, 'original');
});

test('parseNoteMarkdown reports malformed YAML with filename and frontmatter field', () => {
  assert.throws(
    () => parseNoteMarkdown('---\ntitle: [unterminated\n---\nbody', { filename: '研究/坏文件.md' }),
    (error) => {
      assert.equal(error instanceof FrontmatterParseError, true);
      assert.equal(error.diagnostics[0].filename, '研究/坏文件.md');
      assert.equal(error.diagnostics[0].field, '<frontmatter>');
      assert.match(error.diagnostics[0].message, /YAML/i);
      return true;
    },
  );
});

test('parseNoteMarkdown leaves Markdown without frontmatter untouched', () => {
  const source = '# 工作日志\n\n正文\n';
  const parsed = parseNoteMarkdown(source, { filename: '日志.md' });

  assert.equal(parsed.body, source);
  assert.equal(parsed.eligible, false);
  assert.deepEqual(parsed.data.tags, []);
});

test('resolvePublishIdentity generates a deterministic readable suggestion without mutating metadata', () => {
  const data = { title: 'Copper Supply Cycle', format: 'article' };
  const snapshot = structuredClone(data);
  const input = {
    data,
    body: '# Evidence\nFirst draft.\n',
    sourcePath: 'Research/Commodities/Copper.md',
  };

  const first = resolvePublishIdentity(input);
  const afterBodyEdit = resolvePublishIdentity({
    ...input,
    body: '# Evidence\nA materially revised draft.\n',
  });

  assert.deepEqual(data, snapshot);
  assert.match(first.publishId, /^copper-supply-cycle-[a-f0-9]{8}$/);
  assert.equal(first.publishId, afterBodyEdit.publishId);
  assert.equal(first.generated, true);
  assert.equal(first.suggestedField, `publish_id: ${first.publishId}`);
});

test('resolvePublishIdentity keeps a supplied publish_id permanent across source moves', () => {
  const original = resolvePublishIdentity({
    data: { publish_id: 'copper-supply-cycle', title: 'Old title' },
    body: 'Old body',
    sourcePath: 'Research/Old.md',
  });
  const moved = resolvePublishIdentity({
    data: { publish_id: 'copper-supply-cycle', title: 'New title' },
    body: 'New body',
    sourcePath: 'Archive/New.md',
  });

  assert.deepEqual(original, {
    publishId: 'copper-supply-cycle',
    generated: false,
    suggestedField: undefined,
  });
  assert.deepEqual(moved, original);
});

test('resolvePublishIdentity falls back to a readable source filename for untitled logs', () => {
  const identity = resolvePublishIdentity({
    data: { format: 'log' },
    body: '铜库存继续下降。',
    sourcePath: '日志/2026-07-21 铜库存观察.md',
  });

  assert.match(identity.publishId, /^2026-07-21-铜库存观察-[a-f0-9]{8}$/u);
});

function validArticleData(overrides = {}) {
  return {
    publish: true,
    publish_id: 'copper-supply-cycle',
    domain: 'investment',
    section: 'commodities',
    format: 'article',
    source_type: 'original',
    title: '铜矿供给约束',
    summary: '从资本开支、精矿供给和加工费观察铜矿周期。',
    tags: ['铜'],
    commodities: ['铜'],
    companies: [],
    tickers: [],
    confidence: 'medium',
    ...overrides,
  };
}

test('validatePublicationNote accepts an article that matches the public schema', () => {
  assert.deepEqual(
    validatePublicationNote({
      filename: '研究/铜矿.md',
      data: validArticleData(),
      body: '# 结论\n\n供给响应受限。\n',
    }),
    [],
  );
});

test('validatePublicationNote reports every article requirement with filename and field', () => {
  const diagnostics = validatePublicationNote({
    filename: '研究/缺字段.md',
    data: validArticleData({ title: undefined, summary: ' ', section: undefined }),
    body: '# 正文\n',
  });

  assert.deepEqual(
    diagnostics.map(({ filename, field }) => ({ filename, field })),
    [
      { filename: '研究/缺字段.md', field: 'title' },
      { filename: '研究/缺字段.md', field: 'summary' },
      { filename: '研究/缺字段.md', field: 'section' },
    ],
  );
});

test('validatePublicationNote allows logs to omit title, summary, and section', () => {
  const diagnostics = validatePublicationNote({
    filename: '日志/盘中观察.md',
    data: {
      publish: true,
      domain: 'investment',
      format: 'log',
      source_type: 'news',
      tags: [],
      commodities: [],
      companies: [],
      tickers: [],
    },
    body: '铜库存继续下降。\n',
  });

  assert.deepEqual(diagnostics, []);
});

test('validatePublicationNote rejects non-boolean eligibility and invalid enums', () => {
  const diagnostics = validatePublicationNote({
    filename: '研究/枚举错误.md',
    data: validArticleData({
      publish: 'true',
      domain: 'markets',
      format: 'essay',
      source_type: 'video',
      confidence: 'certain',
    }),
    body: '# 正文\n',
  });

  assert.deepEqual(
    diagnostics.map(({ field }) => field),
    ['publish', 'domain', 'format', 'source_type', 'confidence'],
  );
  assert.equal(diagnostics.every(({ filename }) => filename === '研究/枚举错误.md'), true);
});

test('validatePublicationNote enforces investment section taxonomy and domain combinations', () => {
  assert.deepEqual(INVESTMENT_SECTIONS, [
    'commodities',
    'industries-companies',
    'macro-cycles',
    'markets-trading',
  ]);

  const invalidInvestment = validatePublicationNote({
    filename: '研究/AI行业.md',
    data: validArticleData({ section: 'ai-industry' }),
    body: '# 正文\n',
  });
  assert.deepEqual(invalidInvestment.map(({ field }) => field), ['section']);
  assert.match(invalidInvestment[0].message, /investment/i);

  const invalidAi = validatePublicationNote({
    filename: '研究/AI行业.md',
    data: validArticleData({ domain: 'ai', section: 'commodities', confidence: undefined }),
    body: '# 正文\n',
  });
  assert.deepEqual(invalidAi.map(({ field }) => field), ['section']);
  assert.match(invalidAi[0].message, /domain/i);
});

test('validatePublicationNote checks publish_id, body, optional strings, and string arrays', () => {
  const diagnostics = validatePublicationNote({
    filename: '研究/格式错误.md',
    data: validArticleData({
      publish_id: '../private note',
      topic: 42,
      source_url: 'not a URL',
      tags: ['铜', 7],
    }),
    body: '  \n',
  });

  assert.deepEqual(
    diagnostics.map(({ field }) => field),
    ['publish_id', 'topic', 'source_url', 'tags[1]', 'body'],
  );
});

test('assertValidPublicationNote throws structured diagnostics', () => {
  assert.throws(
    () => assertValidPublicationNote({
      filename: '日志/空.md',
      data: { publish: true, domain: 'beyond', format: 'log', source_type: 'original' },
      body: '',
    }),
    (error) => {
      assert.equal(error instanceof PublicationValidationError, true);
      assert.equal(error.diagnostics[0].filename, '日志/空.md');
      assert.equal(error.diagnostics[0].field, 'body');
      return true;
    },
  );
});

test('state store returns an empty versioned state when no state file exists', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const store = createStateStore({ repoRoot: fixture.repoRoot });
    assert.equal(store.statePath, path.join(fixture.repoRoot, '.publish-state.json'));
    assert.deepEqual(await store.readState(), { version: 1, entries: {} });
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store writes only safe publication metadata and repository-relative emitted paths', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const store = createStateStore({ repoRoot: fixture.repoRoot });
    await store.writeState({
      version: 1,
      entries: {
        'copper-supply-cycle': {
          sourcePath: 'Research/Copper.md',
          lastPublishedSourceHash: VALID_SOURCE_HASH,
          emittedMarkdownPath: 'src/content/entries/copper-supply-cycle.md',
          emittedAssetPaths: ['public/media/copper-supply-cycle/chart.png'],
          publishedAt: '2026-07-21T08:00:00.000Z',
          updatedAt: '2026-07-21T09:00:00.000Z',
          body: 'PRIVATE NOTE BODY MUST NEVER BE STORED',
          arbitraryPrivateData: { secret: true },
        },
      },
    });

    const expected = {
      version: 1,
      entries: {
        'copper-supply-cycle': {
          sourcePath: 'Research/Copper.md',
          lastPublishedSourceHash: VALID_SOURCE_HASH,
          emittedMarkdownPath: 'src/content/entries/copper-supply-cycle.md',
          emittedAssetPaths: ['public/media/copper-supply-cycle/chart.png'],
          publishedAt: '2026-07-21T08:00:00.000Z',
          updatedAt: '2026-07-21T09:00:00.000Z',
        },
      },
    };
    assert.deepEqual(await store.readState(), expected);

    const raw = await readFile(store.statePath, 'utf8');
    assert.equal(raw.includes('PRIVATE NOTE BODY'), false);
    assert.equal(raw.includes('arbitraryPrivateData'), false);
    assert.deepEqual(JSON.parse(raw), expected);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store rejects absolute and escaping source or emitted paths', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const store = createStateStore({ repoRoot: fixture.repoRoot });
    await assert.rejects(
      store.writeState({
        version: 1,
        entries: {
          unsafe: {
            sourcePath: '/Users/private/Vault/unsafe.md',
            emittedMarkdownPath: '../outside.md',
            emittedAssetPaths: ['C:\\private\\chart.png'],
          },
        },
      }),
      (error) => {
        assert.equal(error instanceof StateValidationError, true);
        assert.deepEqual(error.diagnostics.map(({ field }) => field), [
          'entries.unsafe.sourcePath',
          'entries.unsafe.emittedMarkdownPath',
          'entries.unsafe.emittedAssetPaths[0]',
        ]);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store rejects invalid hash and timestamp metadata instead of silently dropping it', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const store = createStateStore({ repoRoot: fixture.repoRoot });
    await assert.rejects(
      store.writeState({
        version: 1,
        entries: {
          copper: {
            sourcePath: 'Research/Copper.md',
            lastPublishedSourceHash: 123,
            publishedAt: false,
          },
        },
      }),
      (error) => {
        assert.equal(error instanceof StateValidationError, true);
        assert.deepEqual(error.diagnostics.map(({ field }) => field), [
          'entries.copper.lastPublishedSourceHash',
          'entries.copper.publishedAt',
        ]);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store never coerces structured private data into a source hash', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const store = createStateStore({ repoRoot: fixture.repoRoot });
    await assert.rejects(
      store.writeState({
        version: 1,
        entries: {
          copper: {
            sourcePath: 'Research/Copper.md',
            lastPublishedSourceHash: [VALID_SOURCE_HASH],
          },
        },
      }),
      (error) => {
        assert.equal(error instanceof StateValidationError, true);
        assert.deepEqual(error.diagnostics.map(({ field }) => field), [
          'entries.copper.lastPublishedSourceHash',
        ]);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store rejects unsafe publish identities and private text disguised as hash or timestamps', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const store = createStateStore({ repoRoot: fixture.repoRoot });
    await assert.rejects(
      store.writeState({
        version: 1,
        entries: {
          'private/body': {
            sourcePath: 'Research/Copper.md',
            lastPublishedSourceHash: '/Users/private/Obsidian/Vault/Copper.md',
            publishedAt: 'PRIVATE NOTE BODY',
            updatedAt: '/Users/private/Obsidian/Vault',
          },
        },
      }),
      (error) => {
        assert.equal(error instanceof StateValidationError, true);
        assert.deepEqual(error.diagnostics.map(({ field }) => field), [
          'entries.private/body',
          'entries.private/body.lastPublishedSourceHash',
          'entries.private/body.publishedAt',
          'entries.private/body.updatedAt',
        ]);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store rejects a custom state path that escapes through a repository symlink', async () => {
  const fixture = await createFixture('publisher-state-');
  const outside = path.join(fixture.root, 'outside-state');
  try {
    await mkdir(outside);
    await symlink(outside, path.join(fixture.repoRoot, 'state-link'));
    const store = createStateStore({
      repoRoot: fixture.repoRoot,
      statePath: path.join(fixture.repoRoot, 'state-link/.publish-state.json'),
    });

    await assert.rejects(
      store.writeState({ version: 1, entries: {} }),
      (error) => {
        assert.equal(error instanceof StateValidationError, true);
        assert.equal(error.diagnostics[0].field, '<root>');
        assert.match(error.diagnostics[0].message, /symlink|outside/i);
        return true;
      },
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store atomically replaces state without leaving temporary files', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const store = createStateStore({ repoRoot: fixture.repoRoot });
    await store.writeState({ version: 1, entries: { first: { sourcePath: 'first.md' } } });
    await store.writeState({ version: 1, entries: { second: { sourcePath: 'second.md' } } });

    const files = await readdir(fixture.repoRoot);
    assert.deepEqual(files.filter((name) => name.startsWith('.publish-state.json.tmp-')), []);
    assert.deepEqual(await store.readState(), {
      version: 1,
      entries: { second: { sourcePath: 'second.md', emittedAssetPaths: [] } },
    });
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store backs up corrupt state and atomically recovers an empty state', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const store = createStateStore({ repoRoot: fixture.repoRoot });
    const corrupt = '{ "version": 1, broken';
    await writeFile(store.statePath, corrupt, 'utf8');

    assert.deepEqual(await store.readState(), { version: 1, entries: {} });
    assert.deepEqual(JSON.parse(await readFile(store.statePath, 'utf8')), { version: 1, entries: {} });

    const files = await readdir(fixture.repoRoot);
    const backups = files.filter((name) => /^\.publish-state\.json\.corrupt-.+\.bak$/.test(name));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(fixture.repoRoot, backups[0]), 'utf8'), corrupt);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store refuses an unsupported version without replacing or backing up the file', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const store = createStateStore({ repoRoot: fixture.repoRoot });
    const futureState = '{\n  "version": 2,\n  "entries": {}\n}\n';
    await writeFile(store.statePath, futureState, 'utf8');

    await assert.rejects(
      store.readState(),
      (error) => {
        assert.equal(error instanceof StateValidationError, true);
        assert.equal(error.diagnostics[0].code, 'unsupported_version');
        return true;
      },
    );
    assert.equal(await readFile(store.statePath, 'utf8'), futureState);
    const files = await readdir(fixture.repoRoot);
    assert.deepEqual(files.filter((name) => name.includes('.corrupt-')), []);
  } finally {
    await removeFixture(fixture.root);
  }
});

test('state store serializes concurrent updates for one state path', async () => {
  const fixture = await createFixture('publisher-state-');
  try {
    const storeA = createStateStore({ repoRoot: fixture.repoRoot });
    const storeB = createStateStore({ repoRoot: fixture.repoRoot });

    await Promise.all([
      storeA.updateState((state) => ({
        ...state,
        entries: { ...state.entries, first: { sourcePath: 'first.md' } },
      })),
      storeB.updateState((state) => ({
        ...state,
        entries: { ...state.entries, second: { sourcePath: 'second.md' } },
      })),
    ]);

    assert.deepEqual(await storeA.readState(), {
      version: 1,
      entries: {
        first: { sourcePath: 'first.md', emittedAssetPaths: [] },
        second: { sourcePath: 'second.md', emittedAssetPaths: [] },
      },
    });
  } finally {
    await removeFixture(fixture.root);
  }
});

test('publisher package, ignore rules, and example config keep local publishing data out of Git', async () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.dependencies['gray-matter'], '4.0.3');
  assert.equal(packageJson.dependencies.yaml, '2.9.0');

  const ignoreRules = (await readFile(path.join(repoRoot, '.gitignore'), 'utf8')).split(/\r?\n/);
  for (const rule of [
    'publish.config.local.json',
    '.publish-state.json',
    '.publish-state.json.*',
    '.publish-staging/',
    '.publish-preview/',
  ]) {
    assert.equal(ignoreRules.includes(rule), true, `missing Git ignore rule: ${rule}`);
  }

  const example = JSON.parse(await readFile(path.join(repoRoot, 'publish.config.example.json'), 'utf8'));
  assert.deepEqual(example, {
    vaultRoot: '/absolute/path/to/your/Obsidian/Vault',
    entryOutputDir: 'src/content/entries',
    mediaOutputDir: 'public/media',
    attachmentRoots: ['Attachments'],
    ignoreFolders: ['.obsidian', '.trash', 'Templates'],
    includeInlineHashtags: true,
  });
  assert.equal(JSON.stringify(example).includes('/Users/'), false);
});
