import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  VaultIndexError,
  buildVaultIndex,
  resolveNoteLink,
  scanCurrentNote,
  scanPendingNotes,
} from '../publisher/lib/vault-index.mjs';

function noteSource({
  publish = true,
  publishId,
  title = '测试笔记',
  body = '正文。',
} = {}) {
  return `---\npublish: ${JSON.stringify(publish)}\n${publishId ? `publish_id: ${publishId}\n` : ''}domain: investment\nformat: log\ntitle: ${title}\n---\n${body}\n`;
}

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publisher-scanner-'));
  const vaultRoot = path.join(root, 'vault');
  await mkdir(vaultRoot);
  return { root, vaultRoot };
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test('scanCurrentNote accepts one eligible Markdown note and rejects lexical or symlink Vault escapes', async () => {
  const fixture = await createFixture();
  const outside = path.join(fixture.root, 'outside.md');
  const inside = path.join(fixture.vaultRoot, 'Research', 'Copper.md');
  const linkedOutside = path.join(fixture.vaultRoot, 'linked-outside.md');

  try {
    await mkdir(path.dirname(inside), { recursive: true });
    await writeFile(inside, noteSource({ publishId: 'copper-log' }), 'utf8');
    await writeFile(outside, noteSource({ publishId: 'private-note' }), 'utf8');
    await symlink(outside, linkedOutside);

    const selected = await scanCurrentNote({
      vaultRoot: fixture.vaultRoot,
      sourcePath: inside,
      ignoreFolders: ['Templates'],
    });

    assert.equal(selected.sourcePath, 'Research/Copper.md');
    assert.equal(selected.publishId, 'copper-log');
    assert.equal(selected.eligible, true);
    assert.match(selected.sourceHash, /^[a-f0-9]{64}$/);

    for (const sourcePath of [outside, linkedOutside]) {
      await assert.rejects(
        scanCurrentNote({ vaultRoot: fixture.vaultRoot, sourcePath }),
        (error) => {
          assert.equal(error instanceof VaultIndexError, true);
          assert.equal(error.diagnostics[0].field, 'source');
          assert.match(error.diagnostics[0].message, /outside|symlink|Vault/i);
          assert.equal(error.message.includes(fixture.vaultRoot), false);
          return true;
        },
      );
    }
  } finally {
    await cleanup(fixture.root);
  }
});

test('scanCurrentNote refuses an in-Vault symlink instead of silently selecting its target', async () => {
  const fixture = await createFixture();
  const target = path.join(fixture.vaultRoot, 'Target.md');
  const linked = path.join(fixture.vaultRoot, 'Linked.md');
  try {
    await writeFile(target, noteSource({ publishId: 'target-note' }), 'utf8');
    await symlink(target, linked);

    await assert.rejects(
      scanCurrentNote({ vaultRoot: fixture.vaultRoot, sourcePath: linked }),
      (error) => {
        assert.equal(error instanceof VaultIndexError, true);
        assert.equal(error.diagnostics[0].code, 'invalid_source');
        return true;
      },
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('scanCurrentNote returns no selection unless publish is the YAML boolean true', async () => {
  const fixture = await createFixture();
  const quoted = path.join(fixture.vaultRoot, 'quoted.md');
  const disabled = path.join(fixture.vaultRoot, 'disabled.md');

  try {
    await writeFile(quoted, noteSource({ publish: 'true', publishId: 'quoted' }), 'utf8');
    await writeFile(disabled, noteSource({ publish: false, publishId: 'disabled' }), 'utf8');

    assert.equal(await scanCurrentNote({ vaultRoot: fixture.vaultRoot, sourcePath: quoted }), null);
    assert.equal(await scanCurrentNote({ vaultRoot: fixture.vaultRoot, sourcePath: disabled }), null);
  } finally {
    await cleanup(fixture.root);
  }
});

test('Vault indexing treats disabled notes as opaque link identities even when private YAML is malformed', async () => {
  const fixture = await createFixture();
  const privateSource = [
    '---',
    'publish: false',
    'title: PRIVATE METADATA MUST NOT LEAK',
    'broken: [unterminated',
    '---',
    'PRIVATE BODY MUST NOT LEAK',
  ].join('\n');

  try {
    await mkdir(path.join(fixture.vaultRoot, 'Private'));
    await writeFile(path.join(fixture.vaultRoot, 'Private', 'Opaque.md'), privateSource, 'utf8');

    const index = await buildVaultIndex({ vaultRoot: fixture.vaultRoot });
    const record = resolveNoteLink(index, 'Private/Opaque');

    assert.deepEqual(record, { sourcePath: 'Private/Opaque.md', eligible: false });
    assert.deepEqual(index.eligibleNotes, []);
    const serialized = JSON.stringify(index);
    assert.equal(serialized.includes('PRIVATE METADATA MUST NOT LEAK'), false);
    assert.equal(serialized.includes('PRIVATE BODY MUST NOT LEAK'), false);
  } finally {
    await cleanup(fixture.root);
  }
});

test('Vault eligibility fails closed when frontmatter declares publish more than once', async () => {
  const fixture = await createFixture();
  try {
    await writeFile(path.join(fixture.vaultRoot, 'Ambiguous.md'), [
      '---',
      'publish: false',
      'publish: true',
      'private: DO NOT PARSE OR RETAIN',
      '---',
      'PRIVATE BODY',
    ].join('\n'), 'utf8');

    const index = await buildVaultIndex({ vaultRoot: fixture.vaultRoot });
    assert.deepEqual(index.notes, [{ sourcePath: 'Ambiguous.md', eligible: false }]);
    assert.equal(JSON.stringify(index).includes('DO NOT PARSE OR RETAIN'), false);
  } finally {
    await cleanup(fixture.root);
  }
});

test('scanPendingNotes recursively selects only eligible new or hash-changed Markdown outside ignored folders', async () => {
  const fixture = await createFixture();
  const newSource = noteSource({ publishId: 'new-note', title: 'New' });
  const unchangedSource = noteSource({ publishId: 'unchanged-note', title: 'Unchanged' });
  const changedSource = noteSource({ publishId: 'changed-note', title: 'Changed', body: 'new body' });

  try {
    await mkdir(path.join(fixture.vaultRoot, 'Research'), { recursive: true });
    await mkdir(path.join(fixture.vaultRoot, 'Templates'), { recursive: true });
    await mkdir(path.join(fixture.vaultRoot, '.obsidian'), { recursive: true });
    await writeFile(path.join(fixture.vaultRoot, 'Research', 'New.md'), newSource, 'utf8');
    await writeFile(path.join(fixture.vaultRoot, 'Research', 'Unchanged.md'), unchangedSource, 'utf8');
    await writeFile(path.join(fixture.vaultRoot, 'Research', 'Changed.MD'), changedSource, 'utf8');
    await writeFile(path.join(fixture.vaultRoot, 'Research', 'Not Markdown.txt'), newSource, 'utf8');
    await writeFile(
      path.join(fixture.vaultRoot, 'Research', 'Quoted.md'),
      noteSource({ publish: 'true', publishId: 'quoted-note' }),
      'utf8',
    );
    await writeFile(
      path.join(fixture.vaultRoot, 'Templates', 'Private.md'),
      noteSource({ publishId: 'ignored-private' }),
      'utf8',
    );
    await writeFile(
      path.join(fixture.vaultRoot, '.obsidian', 'Plugin.md'),
      noteSource({ publishId: 'ignored-plugin' }),
      'utf8',
    );

    const selected = await scanPendingNotes({
      vaultRoot: fixture.vaultRoot,
      ignoreFolders: ['Templates', '.obsidian'],
      state: {
        version: 1,
        entries: {
          'unchanged-note': { lastPublishedSourceHash: sha256(unchangedSource) },
          'changed-note': { lastPublishedSourceHash: '0'.repeat(64) },
        },
      },
    });

    assert.deepEqual(selected.map(({ sourcePath }) => sourcePath), [
      'Research/Changed.MD',
      'Research/New.md',
    ]);
    assert.deepEqual(selected.map(({ publishId }) => publishId), ['changed-note', 'new-note']);
    assert.equal(selected[0].sourceHash, sha256(changedSource));
    assert.equal(selected[1].sourceHash, sha256(newSource));
  } finally {
    await cleanup(fixture.root);
  }
});

test('pending scanning never follows Vault symlinks', async () => {
  const fixture = await createFixture();
  const outsideDirectory = path.join(fixture.root, 'private-directory');

  try {
    await mkdir(outsideDirectory);
    await writeFile(
      path.join(outsideDirectory, 'Secret.md'),
      noteSource({ publishId: 'must-not-be-seen' }),
      'utf8',
    );
    await symlink(outsideDirectory, path.join(fixture.vaultRoot, 'Linked Private'));

    assert.deepEqual(await scanPendingNotes({ vaultRoot: fixture.vaultRoot }), []);
  } finally {
    await cleanup(fixture.root);
  }
});

test('buildVaultIndex aborts on duplicate publish_id values across all eligible notes', async () => {
  const fixture = await createFixture();

  try {
    await mkdir(path.join(fixture.vaultRoot, 'One'));
    await mkdir(path.join(fixture.vaultRoot, 'Two'));
    await writeFile(
      path.join(fixture.vaultRoot, 'One', 'Copper.md'),
      noteSource({ publishId: 'duplicate-id' }),
      'utf8',
    );
    await writeFile(
      path.join(fixture.vaultRoot, 'Two', 'Copper.md'),
      noteSource({ publishId: 'duplicate-id' }),
      'utf8',
    );

    await assert.rejects(
      buildVaultIndex({ vaultRoot: fixture.vaultRoot }),
      (error) => {
        assert.equal(error instanceof VaultIndexError, true);
        assert.equal(error.diagnostics[0].code, 'duplicate_publish_id');
        assert.deepEqual(error.diagnostics[0].sourcePaths, ['One/Copper.md', 'Two/Copper.md']);
        assert.match(error.message, /One\/Copper\.md/);
        assert.match(error.message, /Two\/Copper\.md/);
        assert.equal(error.message.includes(fixture.vaultRoot), false);
        return true;
      },
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('resolveNoteLink prefers an exact Vault-relative path and otherwise requires a unique basename', async () => {
  const fixture = await createFixture();

  try {
    await mkdir(path.join(fixture.vaultRoot, 'Research'));
    await mkdir(path.join(fixture.vaultRoot, 'Archive'));
    await mkdir(path.join(fixture.vaultRoot, 'Private'));
    await writeFile(
      path.join(fixture.vaultRoot, 'Research', 'Copper.md'),
      noteSource({ publishId: 'current-copper' }),
      'utf8',
    );
    await writeFile(
      path.join(fixture.vaultRoot, 'Archive', 'Copper.md'),
      noteSource({ publishId: 'old-copper' }),
      'utf8',
    );
    await writeFile(
      path.join(fixture.vaultRoot, 'Private', 'Freight.md'),
      noteSource({
        publish: false,
        publishId: 'must-not-be-public',
        title: 'PRIVATE METADATA MUST NOT LEAK',
        body: 'PRIVATE BODY MUST NOT LEAK',
      }),
      'utf8',
    );

    const index = await buildVaultIndex({ vaultRoot: fixture.vaultRoot });

    assert.equal(resolveNoteLink(index, 'Research/Copper').publishId, 'current-copper');
    assert.equal(resolveNoteLink(index, 'Private/Freight.md').eligible, false);
    assert.equal(resolveNoteLink(index, 'Freight').sourcePath, 'Private/Freight.md');
    assert.equal(resolveNoteLink(index, 'Missing'), undefined);

    const privateRecord = resolveNoteLink(index, 'Freight');
    assert.deepEqual(Object.keys(privateRecord).sort(), ['eligible', 'sourcePath']);
    const serializedIndex = JSON.stringify(index);
    assert.equal(serializedIndex.includes('PRIVATE BODY MUST NOT LEAK'), false);
    assert.equal(serializedIndex.includes('PRIVATE METADATA MUST NOT LEAK'), false);
    assert.equal(serializedIndex.includes(fixture.vaultRoot), false);
    assert.throws(
      () => resolveNoteLink(index, 'Copper'),
      (error) => {
        assert.equal(error instanceof VaultIndexError, true);
        assert.equal(error.diagnostics[0].code, 'ambiguous_note_link');
        assert.deepEqual(error.diagnostics[0].sourcePaths, [
          'Archive/Copper.md',
          'Research/Copper.md',
        ]);
        return true;
      },
    );
  } finally {
    await cleanup(fixture.root);
  }
});

test('extensionless exact paths win for Markdown files with an uppercase extension', async () => {
  const fixture = await createFixture();

  try {
    await mkdir(path.join(fixture.vaultRoot, 'Research'));
    await mkdir(path.join(fixture.vaultRoot, 'Archive'));
    await writeFile(
      path.join(fixture.vaultRoot, 'Research', 'Copper.MD'),
      noteSource({ publishId: 'research-copper' }),
      'utf8',
    );
    await writeFile(
      path.join(fixture.vaultRoot, 'Archive', 'Copper.md'),
      noteSource({ publishId: 'archive-copper' }),
      'utf8',
    );

    const index = await buildVaultIndex({ vaultRoot: fixture.vaultRoot });
    assert.equal(resolveNoteLink(index, 'Research/Copper').publishId, 'research-copper');
  } finally {
    await cleanup(fixture.root);
  }
});
