import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildDisplayManifest,
  CliUsageError,
  EXIT_CODES,
  exitCodeForError,
  parseCliArguments,
  runCli,
  runPublishingWorkflow,
} from '../publisher/cli.mjs';
import { ConfigValidationError } from '../publisher/lib/config.mjs';
import { GitPublicationError } from '../publisher/lib/git.mjs';
import { PublicationTransactionError } from '../publisher/lib/transaction.mjs';
import { startPublisherServer } from '../publisher/server.mjs';

async function previewFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'publisher-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previewRoot = path.join(root, 'dist');
  await mkdir(path.join(previewRoot, 'blog', 'alpha'), { recursive: true });
  await writeFile(
    path.join(previewRoot, 'blog', 'alpha', 'index.html'),
    '<!doctype html><link rel="stylesheet" href="/_astro/site.css"><title>Alpha preview</title><main>REAL PREVIEW</main>',
  );
  await mkdir(path.join(previewRoot, '_astro'), { recursive: true });
  await writeFile(path.join(previewRoot, '_astro', 'site.css'), 'main { color: black; }');
  return previewRoot;
}

function previewManifest() {
  return {
    version: 1,
    transactionId: 'transaction-alpha',
    publications: [{
      publishId: 'alpha',
      title: 'Alpha note',
      sourcePath: 'Research/Alpha.md',
      entryTargetPath: 'src/content/entries/alpha.md',
      assetTargetPaths: ['public/media/alpha/chart.png'],
    }],
    files: [
      {
        kind: 'entry',
        publishId: 'alpha',
        targetPath: 'src/content/entries/alpha.md',
        operation: 'update',
        beforeSha256: '0'.repeat(64),
        sha256: 'a'.repeat(64),
      },
      {
        kind: 'asset',
        publishId: 'alpha',
        targetPath: 'public/media/alpha/chart.png',
        operation: 'create',
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('CLI argument parsing keeps browser confirmation as the safe default', () => {
  const source = path.resolve('/tmp', 'active-note.md');

  assert.deepEqual(parseCliArguments(['current', '--source', source]), {
    command: 'current',
    source,
    open: true,
    yes: false,
    push: true,
  });
  assert.deepEqual(parseCliArguments(['pending', '--no-open', '--yes', '--no-push']), {
    command: 'pending',
    source: undefined,
    open: false,
    yes: true,
    push: false,
  });
});

test('CLI rejects missing, relative, or misplaced current-note sources', () => {
  assert.throws(
    () => parseCliArguments(['current']),
    (error) => error instanceof CliUsageError && /--source/u.test(error.message),
  );
  assert.throws(
    () => parseCliArguments(['current', '--source', 'relative-note.md']),
    (error) => error instanceof CliUsageError && /absolute/u.test(error.message),
  );
  assert.throws(
    () => parseCliArguments(['pending', '--source', path.resolve('/tmp', 'note.md')]),
    (error) => error instanceof CliUsageError && /only valid.*current/iu.test(error.message),
  );
});

test('CLI fails closed for unknown commands, options, and missing option values', () => {
  assert.throws(
    () => parseCliArguments(['everything']),
    (error) => error instanceof CliUsageError && /current.*pending/iu.test(error.message),
  );
  assert.throws(
    () => parseCliArguments(['pending', '--force']),
    (error) => error instanceof CliUsageError && /unknown option/iu.test(error.message),
  );
  assert.throws(
    () => parseCliArguments(['current', '--source']),
    (error) => error instanceof CliUsageError && /requires a value/iu.test(error.message),
  );
});

test('CLI exit codes distinguish validation, build, conflict, Git, and push failures', () => {
  assert.equal(exitCodeForError(new CliUsageError('bad arguments')), EXIT_CODES.validation);
  assert.equal(
    exitCodeForError(new ConfigValidationError([{ filename: 'config', field: 'vaultRoot', message: 'bad' }])),
    EXIT_CODES.validation,
  );
  assert.equal(
    exitCodeForError(new PublicationTransactionError('preview failed', { code: 'preview_build_failed' })),
    EXIT_CODES.build,
  );
  assert.equal(
    exitCodeForError(new PublicationTransactionError('target changed', { code: 'target_conflict' })),
    EXIT_CODES.conflict,
  );
  assert.equal(
    exitCodeForError(new PublicationTransactionError('target changed concurrently', { code: 'target_changed' })),
    EXIT_CODES.conflict,
  );
  assert.equal(
    exitCodeForError(new GitPublicationError('target already staged', { code: 'staged_conflict' })),
    EXIT_CODES.conflict,
  );
  assert.equal(
    exitCodeForError(new GitPublicationError('commit failed', { code: 'git_failed' })),
    EXIT_CODES.git,
  );
  assert.equal(
    exitCodeForError(new PublicationTransactionError('inspection failed', { code: 'git_inspection_failed' })),
    EXIT_CODES.git,
  );
  assert.equal(
    exitCodeForError(new GitPublicationError('push failed', { code: 'push_failed' })),
    EXIT_CODES.push,
  );
  assert.equal(exitCodeForError(new Error('unexpected')), EXIT_CODES.internal);
});

test('display manifest labels exact create and update targets without mutating the transaction manifest', async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'publisher-manifest-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const existingPath = path.join(repoRoot, 'src', 'content', 'entries', 'alpha.md');
  await mkdir(path.dirname(existingPath), { recursive: true });
  await writeFile(existingPath, 'old entry');
  const manifest = previewManifest();
  const original = structuredClone(manifest);

  const display = await buildDisplayManifest(manifest, { repoRoot });

  assert.equal(display.files[0].operation, 'update');
  assert.equal(display.files[0].beforeSha256, sha256('old entry'));
  assert.equal(display.files[0].sha256, 'a'.repeat(64));
  assert.equal(display.files[1].operation, 'create');
  assert.equal(display.files[1].beforeSha256, undefined);
  assert.deepEqual(manifest, original);
});

test('current-note workflow stages exactly the requested note and waits for browser cancellation by default', async () => {
  const source = path.resolve('/vault', 'Research', 'Alpha.md');
  const note = {
    sourcePath: 'Research/Alpha.md',
    sourceHash: 'c'.repeat(64),
    publishId: 'alpha',
    data: { publish: true, domain: 'ai', format: 'log', source_type: 'original' },
    body: 'Alpha body',
    eligible: true,
  };
  const transaction = {
    manifest: previewManifest(),
    status: 'previewed',
  };
  const calls = [];
  const output = [];
  const result = await runPublishingWorkflow({
    command: 'current',
    source,
    open: true,
    yes: false,
    push: true,
  }, {
    repoRoot: '/repo',
    write: (message) => output.push(message),
    loadConfig: async () => ({
      repoRoot: '/repo',
      vaultRoot: '/vault',
      entryOutputDir: '/repo/src/content/entries',
      mediaOutputDir: '/repo/public/media',
      attachmentRoots: ['/vault'],
      ignoreFolders: ['.obsidian'],
      includeInlineHashtags: true,
    }),
    createStateStore: () => ({
      readState: async () => ({ version: 1, entries: {} }),
      updateState: async () => ({ version: 1, entries: {} }),
    }),
    buildVaultIndex: async () => ({ byRelativePath: new Map(), byBasename: new Map() }),
    scanCurrentNote: async (options) => {
      calls.push(['scan-current', options.sourcePath]);
      return note;
    },
    scanPendingNotes: async () => assert.fail('pending scan must not run'),
    assertValidPublicationNote: (candidate) => {
      calls.push(['validate', candidate.filename]);
      assert.equal(candidate.data.publish_id, undefined, 'validation must see authored frontmatter unchanged');
      return candidate;
    },
    buildAssetIndex: async () => ({}),
    transformNote: async ({ note: selected }) => ({ ...selected, assets: [] }),
    createPublicationTransaction: async (options) => {
      calls.push(['stage', options.notes.map(({ publishId }) => publishId)]);
      return transaction;
    },
    buildTransactionPreview: async () => ({ root: '/preview-repo' }),
    buildDisplayManifest: async (manifest) => structuredClone(manifest),
    applyPublicationTransaction: async () => assert.fail('default workflow must not apply without browser confirmation'),
    confirmPublicationTransaction: async () => assert.fail('default workflow must not confirm automatically'),
    cancelPublicationTransaction: async (candidate) => {
      calls.push(['cancel', candidate]);
      return { canceled: true };
    },
    startPublisherServer: async (options) => ({
      url: 'http://127.0.0.1:43123/blog/alpha/',
      close: async () => { calls.push(['close']); },
      waitForResult: async () => ({
        action: 'cancel',
        result: await options.onCancel(),
      }),
    }),
    openBrowser: async (url) => { calls.push(['open', url]); },
  });

  assert.deepEqual(calls[0], ['scan-current', source]);
  assert.ok(calls.some(([name, value]) => name === 'stage' && value[0] === 'alpha'));
  assert.ok(calls.some(([name]) => name === 'cancel'));
  assert.ok(calls.some(([name]) => name === 'open'));
  assert.ok(calls.some(([name]) => name === 'close'));
  assert.equal(result.action, 'cancel');
  assert.match(output.join('\n'), /http:\/\/127\.0\.0\.1:43123\/blog\/alpha\//u);
  assert.match(output.join('\n'), /repository.*unchanged|仓库.*未|No publication files/iu);
  assert.match(output.join('\n'), /before sha256:0{64}/u);
  assert.match(output.join('\n'), /after sha256:a{64}/u);
});

test('pending workflow stages every changed note and --yes applies without a server while --no-push stays local', async () => {
  const notes = ['alpha', 'beta'].map((publishId) => ({
    sourcePath: `${publishId}.md`,
    sourceHash: publishId === 'alpha' ? 'a'.repeat(64) : 'b'.repeat(64),
    publishId,
    data: { publish: true, domain: 'ai', format: 'log', source_type: 'original' },
    body: `${publishId} body`,
    eligible: true,
  }));
  const manifest = previewManifest();
  manifest.publications.push({
    publishId: 'beta',
    title: 'Beta note',
    sourcePath: 'beta.md',
    entryTargetPath: 'src/content/entries/beta.md',
    assetTargetPaths: [],
  });
  const transaction = { manifest, status: 'previewed' };
  const calls = [];
  const stateStore = {
    readState: async () => ({ version: 1, entries: {} }),
    updateState: async () => ({ version: 1, entries: {} }),
  };

  const result = await runPublishingWorkflow({
    command: 'pending',
    source: undefined,
    open: false,
    yes: true,
    push: false,
  }, {
    repoRoot: '/repo',
    write: () => {},
    loadConfig: async () => ({
      repoRoot: '/repo',
      vaultRoot: '/vault',
      entryOutputDir: '/repo/src/content/entries',
      mediaOutputDir: '/repo/public/media',
      attachmentRoots: ['/vault'],
      ignoreFolders: [],
      includeInlineHashtags: true,
    }),
    createStateStore: () => stateStore,
    buildVaultIndex: async () => ({ byRelativePath: new Map(), byBasename: new Map() }),
    scanCurrentNote: async () => assert.fail('current scan must not run'),
    scanPendingNotes: async () => notes,
    assertValidPublicationNote: (candidate) => candidate,
    buildAssetIndex: async () => ({}),
    transformNote: async ({ note }) => ({ ...note, assets: [] }),
    createPublicationTransaction: async (options) => {
      calls.push(['stage', options.notes.map(({ publishId }) => publishId)]);
      return transaction;
    },
    buildTransactionPreview: async () => ({ root: '/preview-repo' }),
    buildDisplayManifest: async (candidate) => structuredClone(candidate),
    applyPublicationTransaction: async (candidate, options) => {
      calls.push(['apply', candidate, options.state]);
      return { manifest };
    },
    confirmPublicationTransaction: async (candidate, options) => {
      calls.push(['confirm', candidate, options.push]);
      return { commitSha: 'deadbeef', pushed: options.push };
    },
    cancelPublicationTransaction: async () => assert.fail('successful automatic publish must not cancel'),
    startPublisherServer: async () => assert.fail('--yes must not start a confirmation server'),
    openBrowser: async () => assert.fail('--yes must not open a browser'),
  });

  assert.deepEqual(calls[0], ['stage', ['alpha', 'beta']]);
  assert.equal(calls[1][0], 'apply');
  assert.deepEqual(calls[2], ['confirm', transaction, false]);
  assert.deepEqual(result, {
    action: 'confirm',
    push: false,
    result: { commitSha: 'deadbeef', pushed: false },
  });
});

test('preview failure cancels temporary staging before the categorized build error escapes', async () => {
  const note = {
    sourcePath: 'alpha.md',
    sourceHash: 'a'.repeat(64),
    publishId: 'alpha',
    data: { publish: true, domain: 'ai', format: 'log', source_type: 'original' },
    body: 'Alpha body',
    eligible: true,
  };
  const transaction = { manifest: previewManifest(), status: 'staged' };
  let canceled = 0;
  const failure = new PublicationTransactionError('Preview build failed', {
    code: 'preview_build_failed',
  });

  await assert.rejects(
    runPublishingWorkflow({
      command: 'pending',
      source: undefined,
      open: false,
      yes: false,
      push: true,
    }, {
      repoRoot: '/repo',
      write: () => {},
      loadConfig: async () => ({
        repoRoot: '/repo',
        vaultRoot: '/vault',
        entryOutputDir: '/repo/src/content/entries',
        mediaOutputDir: '/repo/public/media',
        attachmentRoots: ['/vault'],
        ignoreFolders: [],
        includeInlineHashtags: true,
      }),
      createStateStore: () => ({ readState: async () => ({ version: 1, entries: {} }) }),
      buildVaultIndex: async () => ({ byRelativePath: new Map(), byBasename: new Map() }),
      scanPendingNotes: async () => [note],
      assertValidPublicationNote: (candidate) => candidate,
      buildAssetIndex: async () => ({}),
      transformNote: async ({ note: selected }) => ({ ...selected, assets: [] }),
      createPublicationTransaction: async () => transaction,
      buildTransactionPreview: async () => {
        transaction.status = 'preview_failed';
        throw failure;
      },
      cancelPublicationTransaction: async (candidate) => {
        assert.equal(candidate, transaction);
        canceled += 1;
        transaction.status = 'canceled';
      },
    }),
    (error) => error === failure,
  );
  assert.equal(canceled, 1);
});

test('CLI entrypoint never turns safe defaults into implicit confirmation and reports categorized failures', async () => {
  let received;
  const successCode = await runCli(['pending', '--no-open'], {
    runPublishingWorkflow: async (options) => {
      received = options;
      return { action: 'cancel' };
    },
    writeError: () => assert.fail('successful command must not write an error'),
  });
  assert.equal(successCode, EXIT_CODES.success);
  assert.equal(received.yes, false);
  assert.equal(received.open, false);

  const errors = [];
  const failureCode = await runCli(['pending'], {
    runPublishingWorkflow: async () => {
      throw new PublicationTransactionError('Astro preview failed', {
        code: 'preview_build_failed',
        details: { stderr: 'broken route' },
      });
    },
    writeError: (message) => errors.push(message),
  });
  assert.equal(failureCode, EXIT_CODES.build);
  assert.match(errors.join('\n'), /Astro preview failed/u);
  assert.match(errors.join('\n'), /broken route/u);
  assert.match(errors.join('\n'), /recovery|resolve.*rerun/iu);
});

test('CLI recovery text never claims a failed rollback was harmless and preserves committed recovery facts', async () => {
  const rollbackErrors = [];
  const rollbackCode = await runCli(['pending'], {
    runPublishingWorkflow: async () => {
      throw new PublicationTransactionError('Target rollback did not finish', {
        code: 'rollback_failed',
      });
    },
    writeError: (message) => rollbackErrors.push(message),
  });
  assert.equal(rollbackCode, EXIT_CODES.build);
  assert.match(rollbackErrors.join('\n'), /inspect every manifest target|manual inspection/iu);
  assert.doesNotMatch(rollbackErrors.join('\n'), /staged preview data was not published/iu);

  const stateErrors = [];
  const commitSha = 'd'.repeat(40);
  await runCli(['pending'], {
    runPublishingWorkflow: async () => {
      throw new PublicationTransactionError('State update failed', {
        code: 'state_update_failed',
        details: { commitSha },
      });
    },
    writeError: (message) => stateErrors.push(message),
  });
  assert.match(stateErrors.join('\n'), new RegExp(commitSha, 'u'));
  assert.match(stateErrors.join('\n'), /local publication commit.*retained/iu);

  const indexErrors = [];
  await runCli(['pending'], {
    runPublishingWorkflow: async () => {
      throw new GitPublicationError('Index refresh failed', {
        code: 'index_recovery_required',
        committed: true,
        commitSha,
      });
    },
    writeError: (message) => indexErrors.push(message),
  });
  assert.match(indexErrors.join('\n'), /local publication commit.*retained/iu);
});

test('package scripts expose current, pending, and publisher-only test commands', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.scripts['publish:current'], 'node publisher/cli.mjs current');
  assert.equal(packageJson.scripts['publish:pending'], 'node publisher/cli.mjs pending');
  assert.equal(packageJson.scripts['publish:test'], 'node --test tests/publisher-*.test.mjs');
});

test('preview server binds only to loopback and opens the real target route with the exact manifest', async (t) => {
  const previewRoot = await previewFixture(t);
  const publisher = await startPublisherServer({
    previewRoot,
    route: '/blog/alpha/',
    manifest: previewManifest(),
    onConfirm: async () => ({ pushed: false }),
    onCancel: async () => ({ canceled: true }),
  });
  t.after(() => publisher.close());

  const address = publisher.server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.equal(new URL(publisher.url).pathname, '/blog/alpha/');

  const response = await fetch(publisher.url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /src\/content\/entries\/alpha\.md/u);
  assert.match(html, /public\/media\/alpha\/chart\.png/u);
  assert.match(html, /_publisher\/preview\/blog\/alpha\//u);

  const previewResponse = await fetch(new URL('/_publisher/preview/blog/alpha/', publisher.url));
  assert.equal(previewResponse.status, 200);
  assert.match(await previewResponse.text(), /REAL PREVIEW/u);
  const builtAsset = await fetch(new URL('/_astro/site.css', publisher.url));
  assert.equal(builtAsset.status, 200);
  assert.match(await builtAsset.text(), /color: black/u);
});

test('preview server rejects hostile Host headers to prevent loopback DNS rebinding', async (t) => {
  const previewRoot = await previewFixture(t);
  const publisher = await startPublisherServer({
    previewRoot,
    route: '/blog/alpha/',
    manifest: previewManifest(),
    onConfirm: async () => ({ pushed: false }),
    onCancel: async () => ({ canceled: true }),
  });
  t.after(() => publisher.close());

  const target = new URL(publisher.url);
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { host: 'attacker.example' },
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({
        status: incoming.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
  assert.equal(response.status, 421);
  assert.doesNotMatch(response.body, /publisher-data|Alpha note/u);
});

test('preview server returns browser-safe MIME types for built Astro fonts', async (t) => {
  const previewRoot = await previewFixture(t);
  await writeFile(path.join(previewRoot, '_astro', 'site.woff2'), Buffer.from('font'));
  const publisher = await startPublisherServer({
    previewRoot,
    route: '/blog/alpha/',
    manifest: previewManifest(),
    onConfirm: async () => ({ pushed: false }),
    onCancel: async () => ({ canceled: true }),
  });
  t.after(() => publisher.close());

  const response = await fetch(new URL('/_astro/site.woff2', publisher.url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'font/woff2');
});

test('mutating preview actions require POST plus a random token that can be used only once', async (t) => {
  const previewRoot = await previewFixture(t);
  const confirmations = [];
  const publisher = await startPublisherServer({
    previewRoot,
    route: '/blog/alpha/',
    manifest: previewManifest(),
    onConfirm: async ({ push }) => {
      confirmations.push(push);
      return { pushed: push };
    },
    onCancel: async () => ({ canceled: true }),
  });
  t.after(() => publisher.close());
  assert.match(publisher.token, /^[A-Za-z0-9_-]{43}$/u);

  const endpoint = new URL('/_publisher/action/confirm-push', publisher.url);
  const wrongMethod = await fetch(endpoint);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.deepEqual(confirmations, []);

  const missingToken = await fetch(endpoint, { method: 'POST' });
  assert.equal(missingToken.status, 403);
  assert.deepEqual(confirmations, []);

  const confirmed = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-publisher-token': publisher.token },
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmations, [true]);
  assert.deepEqual(await publisher.waitForResult(), {
    action: 'confirm',
    push: true,
    result: { pushed: true },
  });

  const replay = await fetch(
    new URL('/_publisher/action/confirm-local', publisher.url),
    {
      method: 'POST',
      headers: { 'x-publisher-token': publisher.token },
    },
  );
  assert.equal(replay.status, 409);
  assert.deepEqual(confirmations, [true]);
});

test('cancel is a one-shot authenticated action and never confirms publication', async (t) => {
  const previewRoot = await previewFixture(t);
  let canceled = 0;
  let confirmed = 0;
  const publisher = await startPublisherServer({
    previewRoot,
    route: '/blog/alpha/',
    manifest: previewManifest(),
    onConfirm: async () => { confirmed += 1; },
    onCancel: async () => {
      canceled += 1;
      return { canceled: true };
    },
  });
  t.after(() => publisher.close());

  const response = await fetch(new URL('/_publisher/action/cancel', publisher.url), {
    method: 'POST',
    headers: { 'x-publisher-token': publisher.token },
  });
  assert.equal(response.status, 200);
  assert.equal(canceled, 1);
  assert.equal(confirmed, 0);
  assert.deepEqual(await publisher.waitForResult(), {
    action: 'cancel',
    result: { canceled: true },
  });

  const replay = await fetch(new URL('/_publisher/action/confirm-push', publisher.url), {
    method: 'POST',
    headers: { 'x-publisher-token': publisher.token },
  });
  assert.equal(replay.status, 409);
  assert.equal(confirmed, 0);
});

test('no-push mode removes the push action without consuming the confirmation token', async (t) => {
  const previewRoot = await previewFixture(t);
  const confirmations = [];
  const publisher = await startPublisherServer({
    previewRoot,
    route: '/blog/alpha/',
    manifest: previewManifest(),
    allowPush: false,
    onConfirm: async ({ push }) => {
      confirmations.push(push);
      return { pushed: push };
    },
    onCancel: async () => ({ canceled: true }),
  });
  t.after(() => publisher.close());

  const blocked = await fetch(new URL('/_publisher/action/confirm-push', publisher.url), {
    method: 'POST',
    headers: { 'x-publisher-token': publisher.token },
  });
  assert.equal(blocked.status, 403);
  assert.deepEqual(confirmations, []);

  const local = await fetch(new URL('/_publisher/action/confirm-local', publisher.url), {
    method: 'POST',
    headers: { 'x-publisher-token': publisher.token },
  });
  assert.equal(local.status, 200);
  assert.deepEqual(confirmations, [false]);
});

test('preview UI exposes explicit push, local-only, and cancel controls without putting the token in the URL', async (t) => {
  const previewRoot = await previewFixture(t);
  const publisher = await startPublisherServer({
    previewRoot,
    route: '/blog/alpha/',
    manifest: previewManifest(),
    onConfirm: async ({ push }) => ({ pushed: push }),
    onCancel: async () => ({ canceled: true }),
  });
  t.after(() => publisher.close());

  assert.equal(publisher.url.includes(publisher.token), false);
  const html = await (await fetch(publisher.url)).text();
  assert.match(html, /data-action="confirm-push"/u);
  assert.match(html, /data-action="confirm-local"/u);
  assert.match(html, /data-action="cancel"/u);
  assert.match(html, /<iframe[^>]+sandbox(?:="")?[^>]*>/u);
  assert.match(html, /\/_publisher\/ui\/styles\.css/u);
  assert.match(html, /\/_publisher\/ui\/app\.js/u);
  assert.match(html, new RegExp(publisher.token, 'u'));

  const css = await fetch(new URL('/_publisher/ui/styles.css', publisher.url));
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /^text\/css/u);
  const javascript = await fetch(new URL('/_publisher/ui/app.js', publisher.url));
  assert.equal(javascript.status, 200);
  assert.match(javascript.headers.get('content-type'), /^text\/javascript/u);
  assert.match(await javascript.text(), /beforeSha256/u);

  const preview = await fetch(new URL('/_publisher/preview/blog/alpha/', publisher.url));
  assert.match(preview.headers.get('content-security-policy'), /script-src 'none'/u);
});
