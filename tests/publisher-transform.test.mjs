import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AssetPipelineError,
  buildAssetIndex,
  copyAssets,
  createStagingDirectoryGuard,
} from '../publisher/lib/assets.mjs';
import { buildVaultIndex } from '../publisher/lib/vault-index.mjs';
import {
  TransformError,
  transformNote,
} from '../publisher/lib/transform.mjs';

function noteSource({
  publish = true,
  publishId,
  title = '测试笔记',
  tags = [],
  body = '正文。',
} = {}) {
  return `---\npublish: ${JSON.stringify(publish)}\n${publishId ? `publish_id: ${publishId}\n` : ''}domain: investment\nformat: log\ntitle: ${title}\ntags: [${tags.join(', ')}]\n---\n${body}`;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publisher-transform-'));
  const vaultRoot = path.join(root, 'vault');
  const attachmentRoot = path.join(vaultRoot, 'Attachments');
  const stagingRoot = path.join(root, 'staging');
  await mkdir(attachmentRoot, { recursive: true });
  await mkdir(stagingRoot);
  return { root, vaultRoot, attachmentRoot, stagingRoot };
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

async function writeNote(vaultRoot, relativePath, options) {
  const absolutePath = path.join(vaultRoot, ...relativePath.split('/'));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, noteSource(options), 'utf8');
  return absolutePath;
}

async function buildIndexes(fixture) {
  const [vaultIndex, assetIndex] = await Promise.all([
    buildVaultIndex({ vaultRoot: fixture.vaultRoot }),
    buildAssetIndex({
      vaultRoot: fixture.vaultRoot,
      attachmentRoots: [fixture.attachmentRoot],
    }),
  ]);
  return { vaultIndex, assetIndex };
}

test('transformNote emits links only for confirmed state or current-transaction publish IDs', async () => {
  const fixture = await createFixture();

  try {
    await writeNote(fixture.vaultRoot, 'Research/Current.md', {
      publishId: 'current-note',
      body: [
        'Published: [[Research/Copper|铜研究]]。',
        'Private: [[Private/Meeting Notes]]。',
        'Missing: [[Plans/Hidden Strategy]]。',
      ].join('\n'),
    });
    await writeNote(fixture.vaultRoot, 'Research/Copper.md', {
      publishId: 'copper-cycle',
    });
    await writeNote(fixture.vaultRoot, 'Research/Unconfirmed.md', {
      publishId: 'unconfirmed-note',
    });
    await writeNote(fixture.vaultRoot, 'Private/Meeting Notes.md', {
      publish: false,
      publishId: 'must-never-be-linked',
    });

    const { vaultIndex, assetIndex } = await buildIndexes(fixture);
    const original = vaultIndex.byRelativePath.get('Research/Current.md');
    original.body += '\nUnconfirmed: [[Research/Unconfirmed|未发布研究]]。';
    const transformed = await transformNote({
      note: original,
      vaultIndex,
      assetIndex,
      publicPublishIds: new Set(['current-note', 'copper-cycle']),
    });

    assert.match(transformed.body, /\[铜研究\]\(\/blog\/copper-cycle\/\)/);
    assert.match(transformed.body, /Private: Meeting Notes。/);
    assert.match(transformed.body, /Missing: Hidden Strategy。/);
    assert.match(transformed.body, /Unconfirmed: 未发布研究。/);
    assert.equal(transformed.body.includes('/blog/unconfirmed-note/'), false);
    assert.equal(transformed.body.includes('Private/'), false);
    assert.equal(transformed.body.includes('Plans/'), false);
    assert.equal(transformed.body.includes('must-never-be-linked'), false);
    assert.deepEqual(transformed.assets, []);
  } finally {
    await cleanup(fixture.root);
  }
});

test('transformNote aborts ambiguous basename links but exact Vault-relative links win', async () => {
  const fixture = await createFixture();

  try {
    await writeNote(fixture.vaultRoot, 'Current.md', {
      publishId: 'current',
      body: 'Exact [[Research/Copper]] then ambiguous [[Copper]].\n',
    });
    await writeNote(fixture.vaultRoot, 'Research/Copper.md', { publishId: 'research-copper' });
    await writeNote(fixture.vaultRoot, 'Archive/Copper.md', { publishId: 'archive-copper' });
    const { vaultIndex, assetIndex } = await buildIndexes(fixture);

    await assert.rejects(
      transformNote({
        note: vaultIndex.byRelativePath.get('Current.md'),
        vaultIndex,
        assetIndex,
      }),
      (error) => {
        assert.equal(error instanceof TransformError, true);
        assert.equal(error.diagnostics[0].filename, 'Current.md');
        assert.equal(error.diagnostics[0].code, 'ambiguous_note_link');
        assert.deepEqual(error.diagnostics[0].sourcePaths, [
          'Archive/Copper.md',
          'Research/Copper.md',
        ]);
        return true;
      },
    );

    const exactOnly = {
      ...vaultIndex.byRelativePath.get('Current.md'),
      body: 'Exact [[Research/Copper]].\n',
    };
    const transformed = await transformNote({ note: exactOnly, vaultIndex, assetIndex });
    assert.equal(transformed.body, 'Exact Copper.\n');

    const confirmed = await transformNote({
      note: exactOnly,
      vaultIndex,
      assetIndex,
      publicPublishIds: ['research-copper'],
    });
    assert.equal(confirmed.body, 'Exact [Copper](/blog/research-copper/).\n');
  } finally {
    await cleanup(fixture.root);
  }
});

test('callouts become stable blockquote labels while ordinary Markdown and code remain intact', async () => {
  const fixture = await createFixture();
  const body = [
    '| 指标 | 结论 |',
    '| --- | --- |',
    '| TC | 下行 |',
    '',
    '> [!WARNING]- 风险',
    '> 库存数据可能修订。',
    '>',
    '> - 保留列表',
    '',
    '> [!NOTE]',
    '> 普通说明。',
    '',
    '- 列表 [[Target]]',
    '- `[[Target]] #inline-code`',
    '',
    '```md',
    '[[Target]] #fenced-code',
    '> [!TIP] 不应转换',
    '```',
    '',
    '脚注[^1]。',
    '',
    '[^1]: 脚注正文。',
    '',
  ].join('\n');

  try {
    await writeNote(fixture.vaultRoot, 'Current.md', { publishId: 'current', body });
    await writeNote(fixture.vaultRoot, 'Target.md', { publishId: 'target' });
    const { vaultIndex, assetIndex } = await buildIndexes(fixture);
    const transformed = await transformNote({
      note: vaultIndex.byRelativePath.get('Current.md'),
      vaultIndex,
      assetIndex,
      publicPublishIds: new Set(['target']),
    });

    assert.match(transformed.body, /^\| 指标 \| 结论 \|\n\| --- \| --- \|\n\| TC \| 下行 \|/);
    assert.match(transformed.body, /> \*\*Warning: 风险\*\*\n> 库存数据可能修订。/);
    assert.match(transformed.body, /> \*\*Note:\*\*\n> 普通说明。/);
    assert.match(transformed.body, /- 列表 \[Target\]\(\/blog\/target\/\)/);
    assert.match(transformed.body, /- `\[\[Target\]\] #inline-code`/);
    assert.match(transformed.body, /```md\n\[\[Target\]\] #fenced-code\n> \[!TIP\] 不应转换\n```/);
    assert.match(transformed.body, /脚注\[\^1\]。\n\n\[\^1\]: 脚注正文。/);
  } finally {
    await cleanup(fixture.root);
  }
});

test('inline hashtags merge deterministically without reading headings, code, or URL fragments as tags', async () => {
  const fixture = await createFixture();
  const body = [
    '# 标题',
    '',
    '观察 #供给 #铜 #铜/库存。',
    'URL https://example.com/research#private-tag 与 [链接](https://example.com/#markdown-url)。',
    'Inline `#inline-code`。',
    '',
    '~~~text',
    '#fenced-code',
    '~~~',
    '',
  ].join('\n');

  try {
    await writeNote(fixture.vaultRoot, 'Current.md', {
      publishId: 'current',
      tags: ['铜', '已有'],
      body,
    });
    const { vaultIndex, assetIndex } = await buildIndexes(fixture);
    const note = vaultIndex.byRelativePath.get('Current.md');

    const included = await transformNote({
      note,
      vaultIndex,
      assetIndex,
      includeInlineHashtags: true,
    });
    assert.deepEqual(included.data.tags, ['铜', '已有', '供给', '铜/库存']);

    const excluded = await transformNote({
      note,
      vaultIndex,
      assetIndex,
      includeInlineHashtags: false,
    });
    assert.deepEqual(excluded.data.tags, ['铜', '已有']);
    assert.equal(included.body, body);
  } finally {
    await cleanup(fixture.root);
  }
});

test('image embeds receive deterministic public names and copy byte-for-byte without mutating Vault sources', async () => {
  const fixture = await createFixture();
  const imagePath = path.join(fixture.attachmentRoot, 'Charts', 'TC Chart.PNG');
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x10, 0xff]);

  try {
    await mkdir(path.dirname(imagePath), { recursive: true });
    await writeFile(imagePath, imageBytes);
    const currentPath = await writeNote(fixture.vaultRoot, 'Current.md', {
      publishId: 'copper-log',
      body: '图表：![[Charts/TC Chart.PNG|加工费]]\n',
    });

    const { vaultIndex, assetIndex } = await buildIndexes(fixture);
    const note = vaultIndex.byRelativePath.get('Current.md');
    const noteBefore = await readFile(currentPath);
    const imageBefore = await readFile(imagePath);
    const imageStatBefore = await lstat(imagePath);

    const first = await transformNote({ note, vaultIndex, assetIndex });
    const second = await transformNote({ note, vaultIndex, assetIndex });

    assert.equal(first.body, second.body);
    assert.deepEqual(
      first.assets.map(({ outputName, publicUrl, sourcePath, sourceHash }) => ({
        outputName,
        publicUrl,
        sourcePath,
        sourceHash,
      })),
      second.assets.map(({ outputName, publicUrl, sourcePath, sourceHash }) => ({
        outputName,
        publicUrl,
        sourcePath,
        sourceHash,
      })),
    );
    assert.match(first.body, /!\[加工费\]\(\/media\/copper-log\/tc-chart-[a-f0-9]{12}\.png\)/);
    assert.equal(first.assets.length, 1);
    assert.match(first.assets[0].outputName, /^tc-chart-[a-f0-9]{12}\.png$/);
    assert.equal(first.assets[0].sourcePath, 'Attachments/Charts/TC Chart.PNG');
    assert.deepEqual(Object.keys(first.assets[0]).sort(), [
      'outputName',
      'publicUrl',
      'sourceHash',
      'sourcePath',
    ]);
    assert.equal(JSON.stringify(first).includes(fixture.vaultRoot), false);
    assert.equal(JSON.stringify(assetIndex).includes(fixture.vaultRoot), false);

    const copies = await copyAssets({
      assets: first.assets,
      stagingDir: path.join(fixture.stagingRoot, 'copper-log'),
      vaultRoot: fixture.vaultRoot,
    });
    assert.equal(copies.length, 1);
    assert.deepEqual(await readFile(copies[0].stagedPath), imageBytes);
    assert.deepEqual(await readFile(imagePath), imageBefore);
    assert.deepEqual(await readFile(currentPath), noteBefore);
    const imageStatAfter = await lstat(imagePath);
    assert.equal(imageStatAfter.mtimeMs, imageStatBefore.mtimeMs);
    assert.equal(imageStatAfter.size, imageStatBefore.size);
  } finally {
    await cleanup(fixture.root);
  }
});

test('missing, case-mismatched, ambiguous, and unsupported embeds abort with actionable diagnostics', async () => {
  const fixture = await createFixture();

  try {
    await mkdir(path.join(fixture.attachmentRoot, 'One'));
    await mkdir(path.join(fixture.attachmentRoot, 'Two'));
    await writeFile(path.join(fixture.attachmentRoot, 'Chart.png'), Buffer.from('chart'));
    await writeFile(path.join(fixture.attachmentRoot, 'One', 'Duplicate.png'), Buffer.from('one'));
    await writeFile(path.join(fixture.attachmentRoot, 'Two', 'Duplicate.png'), Buffer.from('two'));
    await writeFile(path.join(fixture.attachmentRoot, 'Report.pdf'), Buffer.from('%PDF'));
    await writeFile(path.join(fixture.attachmentRoot, 'Vector.svg'), Buffer.from('<svg><script>alert(1)</script></svg>'));
    await writeNote(fixture.vaultRoot, 'Current.md', { publishId: 'current' });

    const { vaultIndex, assetIndex } = await buildIndexes(fixture);
    const baseNote = vaultIndex.byRelativePath.get('Current.md');
    const cases = [
      { reference: 'Missing.png', code: 'missing_asset' },
      { reference: 'chart.png', code: 'asset_case_mismatch' },
      { reference: 'Duplicate.png', code: 'ambiguous_asset' },
      { reference: 'Report.pdf', code: 'unsupported_asset_type' },
      { reference: 'Vector.svg', code: 'unsupported_asset_type' },
      { reference: 'recording.mp3', code: 'unsupported_asset_type' },
      { reference: 'Board.canvas', code: 'unsupported_asset_type' },
    ];

    for (const { reference, code } of cases) {
      await assert.rejects(
        transformNote({
          note: { ...baseNote, body: `![[${reference}]]\n` },
          vaultIndex,
          assetIndex,
        }),
        (error) => {
          assert.equal(error instanceof TransformError, true);
          assert.equal(error.diagnostics[0].filename, 'Current.md');
          assert.equal(error.diagnostics[0].field, 'embed');
          assert.equal(error.diagnostics[0].code, code);
          assert.equal(error.diagnostics[0].reference, reference);
          assert.match(error.diagnostics[0].message, new RegExp(reference.replace('.', '\\.').split('/').at(-1), 'i'));
          return true;
        },
      );
    }
  } finally {
    await cleanup(fixture.root);
  }
});

test('asset indexing rejects roots outside the Vault and never follows attachment symlinks', async () => {
  const fixture = await createFixture();
  const outsideRoot = path.join(fixture.root, 'outside-assets');

  try {
    await mkdir(outsideRoot);
    await writeFile(path.join(outsideRoot, 'Secret.png'), Buffer.from('secret'));

    await assert.rejects(
      buildAssetIndex({
        vaultRoot: fixture.vaultRoot,
        attachmentRoots: [outsideRoot],
      }),
      (error) => {
        assert.equal(error instanceof AssetPipelineError, true);
        assert.equal(error.diagnostics[0].code, 'attachment_root_outside_vault');
        assert.equal(error.message.includes(outsideRoot), false);
        return true;
      },
    );

    await symlink(outsideRoot, path.join(fixture.attachmentRoot, 'Linked'));
    await writeNote(fixture.vaultRoot, 'Current.md', {
      publishId: 'current',
      body: '![[Secret.png]]\n',
    });
    const { vaultIndex, assetIndex } = await buildIndexes(fixture);
    await assert.rejects(
      transformNote({
        note: vaultIndex.byRelativePath.get('Current.md'),
        vaultIndex,
        assetIndex,
      }),
      (error) => {
        assert.equal(error.diagnostics[0].code, 'missing_asset');
        return true;
      },
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('copyAssets detects source changes and staging symlink escapes before writing', async () => {
  const fixture = await createFixture();
  const imagePath = path.join(fixture.attachmentRoot, 'Chart.png');
  const escapedStaging = path.join(fixture.root, 'escaped-staging');

  try {
    await writeFile(imagePath, Buffer.from('original'));
    await writeNote(fixture.vaultRoot, 'Current.md', {
      publishId: 'current',
      body: '![[Chart.png]]\n',
    });
    const { vaultIndex, assetIndex } = await buildIndexes(fixture);
    const transformed = await transformNote({
      note: vaultIndex.byRelativePath.get('Current.md'),
      vaultIndex,
      assetIndex,
    });

    await writeFile(imagePath, Buffer.from('changed-after-transform'));
    await assert.rejects(
      copyAssets({
        assets: transformed.assets,
        stagingDir: fixture.stagingRoot,
        vaultRoot: fixture.vaultRoot,
      }),
      (error) => {
        assert.equal(error instanceof AssetPipelineError, true);
        assert.equal(error.diagnostics[0].code, 'asset_source_changed');
        return true;
      },
    );

    await mkdir(escapedStaging);
    await symlink(escapedStaging, path.join(fixture.stagingRoot, transformed.assets[0].outputName));
    await assert.rejects(
      copyAssets({
        assets: transformed.assets,
        stagingDir: fixture.stagingRoot,
        vaultRoot: fixture.vaultRoot,
      }),
      (error) => {
        assert.equal(error instanceof AssetPipelineError, true);
        assert.equal(error.diagnostics[0].code, 'unsafe_staging_target');
        return true;
      },
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('copyAssets requires a trusted Vault root, a relative source, and a SHA-256 descriptor', async () => {
  const fixture = await createFixture();
  const imagePath = path.join(fixture.attachmentRoot, 'Chart.png');

  try {
    await writeFile(imagePath, Buffer.from('chart'));
    await writeNote(fixture.vaultRoot, 'Current.md', {
      publishId: 'current',
      body: '![[Chart.png]]\n',
    });
    const { vaultIndex, assetIndex } = await buildIndexes(fixture);
    const transformed = await transformNote({
      note: vaultIndex.byRelativePath.get('Current.md'),
      vaultIndex,
      assetIndex,
    });
    const [asset] = transformed.assets;

    await assert.rejects(
      copyAssets({ assets: [asset], stagingDir: path.join(fixture.stagingRoot, 'missing-root') }),
      (error) => {
        assert.equal(error instanceof AssetPipelineError, true);
        assert.equal(error.diagnostics[0].code, 'invalid_vault_root');
        return true;
      },
    );

    for (const unsafeAsset of [
      { ...asset, sourceHash: undefined },
      { ...asset, sourcePath: '../outside.png' },
      { ...asset, sourcePath: path.join(fixture.root, 'outside.png') },
    ]) {
      await assert.rejects(
        copyAssets({
          assets: [unsafeAsset],
          stagingDir: path.join(fixture.stagingRoot, `unsafe-${Math.random()}`),
          vaultRoot: fixture.vaultRoot,
        }),
        (error) => {
          assert.equal(error instanceof AssetPipelineError, true);
          assert.equal(error.diagnostics[0].code, 'invalid_asset_descriptor');
          return true;
        },
      );
    }
  } finally {
    await cleanup(fixture.root);
  }
});

test('asset reads refuse a file replaced by an outside symlink after indexing', async () => {
  const fixture = await createFixture();
  const imagePath = path.join(fixture.attachmentRoot, 'Chart.png');
  const outsidePath = path.join(fixture.root, 'outside.png');

  try {
    await writeFile(imagePath, Buffer.from('inside'));
    await writeFile(outsidePath, Buffer.from('PRIVATE OUTSIDE BYTES'));
    await writeNote(fixture.vaultRoot, 'Current.md', {
      publishId: 'current',
      body: '![[Chart.png]]\n',
    });
    const { vaultIndex, assetIndex } = await buildIndexes(fixture);
    await rm(imagePath);
    await symlink(outsidePath, imagePath);

    await assert.rejects(
      transformNote({
        note: vaultIndex.byRelativePath.get('Current.md'),
        vaultIndex,
        assetIndex,
      }),
      (error) => {
        assert.equal(error instanceof TransformError, true);
        assert.equal(error.diagnostics[0].code, 'asset_source_changed');
        assert.equal(error.message.includes(outsidePath), false);
        return true;
      },
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('staging directory guard detects parent replacement before asset bytes are written', async () => {
  const fixture = await createFixture();
  const guardedPath = path.join(fixture.stagingRoot, 'guarded');
  const movedPath = path.join(fixture.stagingRoot, 'guarded-original');
  const outsidePath = path.join(fixture.root, 'outside-staging');
  let guard;

  try {
    await mkdir(guardedPath);
    await mkdir(outsidePath);
    guard = await createStagingDirectoryGuard(guardedPath);
    await rename(guardedPath, movedPath);
    await symlink(outsidePath, guardedPath);

    await assert.rejects(
      guard.assertStable(),
      (error) => {
        assert.equal(error instanceof AssetPipelineError, true);
        assert.equal(error.diagnostics[0].code, 'unsafe_staging_directory');
        return true;
      },
    );
  } finally {
    if (guard) await guard.close();
    await cleanup(fixture.root);
  }
});
