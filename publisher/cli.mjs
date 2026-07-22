import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildAssetIndex as defaultBuildAssetIndex } from './lib/assets.mjs';
import { loadPublishConfig as defaultLoadPublishConfig } from './lib/config.mjs';
import { createStateStore as defaultCreateStateStore } from './lib/state-store.mjs';
import {
  applyPublicationTransaction as defaultApplyPublicationTransaction,
  buildTransactionPreview as defaultBuildTransactionPreview,
  cancelPublicationTransaction as defaultCancelPublicationTransaction,
  confirmPublicationTransaction as defaultConfirmPublicationTransaction,
  createPublicationTransaction as defaultCreatePublicationTransaction,
} from './lib/transaction.mjs';
import { transformNote as defaultTransformNote } from './lib/transform.mjs';
import { assertValidPublicationNote as defaultAssertValidPublicationNote } from './lib/validate.mjs';
import {
  buildVaultIndex as defaultBuildVaultIndex,
  scanCurrentNote as defaultScanCurrentNote,
  scanPendingNotes as defaultScanPendingNotes,
} from './lib/vault-index.mjs';
import { startPublisherServer as defaultStartPublisherServer } from './server.mjs';

export const EXIT_CODES = Object.freeze({
  success: 0,
  internal: 1,
  validation: 2,
  build: 3,
  conflict: 4,
  git: 5,
  push: 6,
});

const VALIDATION_ERROR_NAMES = new Set([
  'AssetPipelineError',
  'ConfigValidationError',
  'FrontmatterParseError',
  'PublicationValidationError',
  'StateValidationError',
  'TransformError',
  'VaultIndexError',
]);
const BUILD_ERROR_CODES = new Set(['preview_build_failed', 'build_failed', 'rollback_failed']);
const CONFLICT_ERROR_CODES = new Set([
  'repository_changed',
  'staged_conflict',
  'target_changed',
  'target_conflict',
]);
const GIT_ERROR_CODES = new Set(['git_inspection_failed']);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function realpathAllowMissing(candidate) {
  const suffix = [];
  let current = candidate;
  while (true) {
    try {
      return path.resolve(await realpath(current), ...suffix);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function safeManifestTarget(value) {
  if (
    typeof value !== 'string'
    || value === ''
    || value.includes('\0')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    throw new TypeError('Manifest target must be a safe repository-relative path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError('Manifest target must stay inside the repository');
  }
  return normalized;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function defaultOpenBrowser(url) {
  const command = process.platform === 'darwin'
    ? { executable: 'open', args: [url] }
    : process.platform === 'win32'
      ? { executable: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] }
      : { executable: 'xdg-open', args: [url] };

  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export class CliUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function exitCodeForError(error) {
  if (error instanceof CliUsageError || VALIDATION_ERROR_NAMES.has(error?.name)) {
    return EXIT_CODES.validation;
  }
  if (error?.code === 'push_failed') return EXIT_CODES.push;
  if (BUILD_ERROR_CODES.has(error?.code)) return EXIT_CODES.build;
  if (CONFLICT_ERROR_CODES.has(error?.code)) return EXIT_CODES.conflict;
  if (error?.name === 'GitPublicationError' || GIT_ERROR_CODES.has(error?.code)) return EXIT_CODES.git;
  return EXIT_CODES.internal;
}

export async function buildDisplayManifest(manifest, { repoRoot } = {}) {
  if (!manifest || !Array.isArray(manifest.files) || !Array.isArray(manifest.publications)) {
    throw new TypeError('A publication transaction manifest is required');
  }
  const physicalRepoRoot = await realpath(repoRoot);
  const display = structuredClone(manifest);

  display.files = await Promise.all(display.files.map(async (file) => {
    const targetPath = safeManifestTarget(file.targetPath);
    const destination = path.join(physicalRepoRoot, ...targetPath.split('/'));
    const physicalDestination = await realpathAllowMissing(destination);
    if (!isInside(physicalRepoRoot, physicalDestination)) {
      return { ...file, operation: 'conflict' };
    }

    try {
      const details = await lstat(destination);
      if (!details.isFile() || details.isSymbolicLink()) {
        return { ...file, operation: 'conflict' };
      }
      const beforeSha256 = sha256(await readFile(destination));
      return {
        ...file,
        operation: beforeSha256 === file.sha256 ? 'unchanged' : 'update',
        beforeSha256,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...file, operation: 'create' };
      throw error;
    }
  }));
  return display;
}

function formatDisplayManifest(manifest) {
  const lines = ['Publication manifest (exact targets):', '  Notes:'];
  for (const publication of manifest.publications) {
    lines.push(`    - ${publication.title || publication.publishId} [${publication.publishId}]`);
    lines.push(`      source: ${publication.sourcePath}`);
  }
  lines.push('  Files:');
  for (const file of manifest.files) {
    lines.push(`    - ${(file.operation || file.kind).toUpperCase()} ${file.targetPath}`);
    if (file.beforeSha256) lines.push(`      before sha256:${file.beforeSha256}`);
    lines.push(`      after sha256:${file.sha256}`);
  }
  return lines.join('\n');
}

function publicationRoute(notes) {
  return `/blog/${encodeURIComponent(notes[0].publishId)}/`;
}

export async function runPublishingWorkflow(options, overrides = {}) {
  const dependencies = {
    repoRoot: DEFAULT_REPO_ROOT,
    write: (message) => process.stdout.write(`${message}\n`),
    loadConfig: defaultLoadPublishConfig,
    createStateStore: defaultCreateStateStore,
    buildVaultIndex: defaultBuildVaultIndex,
    scanCurrentNote: defaultScanCurrentNote,
    scanPendingNotes: defaultScanPendingNotes,
    assertValidPublicationNote: defaultAssertValidPublicationNote,
    buildAssetIndex: defaultBuildAssetIndex,
    transformNote: defaultTransformNote,
    createPublicationTransaction: defaultCreatePublicationTransaction,
    buildTransactionPreview: defaultBuildTransactionPreview,
    buildDisplayManifest,
    applyPublicationTransaction: defaultApplyPublicationTransaction,
    confirmPublicationTransaction: defaultConfirmPublicationTransaction,
    cancelPublicationTransaction: defaultCancelPublicationTransaction,
    startPublisherServer: defaultStartPublisherServer,
    openBrowser: defaultOpenBrowser,
    ...overrides,
  };

  const config = await dependencies.loadConfig({ repoRoot: dependencies.repoRoot });
  const stateStore = dependencies.createStateStore({ repoRoot: config.repoRoot });
  const state = await stateStore.readState();
  const vaultIndex = await dependencies.buildVaultIndex({
    vaultRoot: config.vaultRoot,
    ignoreFolders: config.ignoreFolders,
  });
  const selectedNotes = options.command === 'current'
    ? [await dependencies.scanCurrentNote({
        vaultRoot: config.vaultRoot,
        sourcePath: options.source,
        ignoreFolders: config.ignoreFolders,
      })].filter(Boolean)
    : await dependencies.scanPendingNotes({
        vaultRoot: config.vaultRoot,
        ignoreFolders: config.ignoreFolders,
        state,
      });

  if (selectedNotes.length === 0) {
    if (options.command === 'current') {
      throw new CliUsageError('The current note is not eligible; add the YAML boolean publish: true');
    }
    dependencies.write('No eligible new or changed notes were found.');
    return { action: 'none', publications: 0 };
  }

  for (const note of selectedNotes) {
    dependencies.assertValidPublicationNote({
      filename: note.sourcePath,
      data: note.data,
      body: note.body,
    });
    if (note.suggestedField) dependencies.write(`Suggested stable identity for ${note.sourcePath}: ${note.suggestedField}`);
  }

  const assetIndex = await dependencies.buildAssetIndex({
    vaultRoot: config.vaultRoot,
    attachmentRoots: config.attachmentRoots,
  });
  const publicPublishIds = new Set([
    ...Object.keys(state.entries ?? {}),
    ...selectedNotes.map((note) => note.publishId),
  ]);
  const transformedNotes = [];
  for (const note of selectedNotes) {
    transformedNotes.push(await dependencies.transformNote({
      note,
      vaultIndex,
      assetIndex,
      includeInlineHashtags: config.includeInlineHashtags,
      publicPublishIds,
    }));
  }

  const transaction = await dependencies.createPublicationTransaction({
    repoRoot: config.repoRoot,
    entryOutputDir: config.entryOutputDir,
    mediaOutputDir: config.mediaOutputDir,
    vaultRoot: config.vaultRoot,
    notes: transformedNotes,
    state,
  });
  try {
    const preview = await dependencies.buildTransactionPreview(transaction);
    const displayManifest = await dependencies.buildDisplayManifest(transaction.manifest, {
      repoRoot: config.repoRoot,
    });
    dependencies.write(formatDisplayManifest(displayManifest));

    if (options.yes) {
      dependencies.write(`Explicit --yes received; applying the exact manifest${options.push ? ' and pushing' : ' without push'}.`);
      const currentState = await stateStore.readState();
      await dependencies.applyPublicationTransaction(transaction, { state: currentState });
      const result = await dependencies.confirmPublicationTransaction(transaction, {
        stateStore,
        push: options.push,
      });
      return { action: 'confirm', push: options.push, result };
    }

    const route = publicationRoute(transformedNotes);
    const publisher = await dependencies.startPublisherServer({
      previewRoot: path.join(preview.root, 'dist'),
      route,
      manifest: displayManifest,
      allowPush: options.push,
      onConfirm: async ({ push }) => {
        const currentState = await stateStore.readState();
        await dependencies.applyPublicationTransaction(transaction, { state: currentState });
        return dependencies.confirmPublicationTransaction(transaction, {
          stateStore,
          push,
        });
      },
      onCancel: () => dependencies.cancelPublicationTransaction(transaction),
    });

    dependencies.write(`Preview URL: ${publisher.url}`);
    dependencies.write('No publication files have been applied; the repository remains unchanged until confirmation.');
    dependencies.write('Recovery: choose Cancel in the browser. If interrupted, rerun after resolving any reported issue; staging remains outside the repository.');
    if (options.open) {
      try {
        await dependencies.openBrowser(publisher.url);
      } catch (error) {
        dependencies.write(`Browser could not be opened automatically: ${error.message}`);
        dependencies.write(`Open this URL manually: ${publisher.url}`);
      }
    }

    try {
      return await publisher.waitForResult();
    } finally {
      await publisher.close();
    }
  } catch (error) {
    if (['staged', 'previewed', 'preview_failed', 'apply_failed', 'rolled_back'].includes(transaction.status)) {
      try {
        await dependencies.cancelPublicationTransaction(transaction);
      } catch (cleanupError) {
        dependencies.write(`Temporary transaction cleanup failed: ${cleanupError.message}`);
      }
    }
    throw error;
  }
}

function formatCliError(error) {
  const lines = [`Publisher failed: ${error?.message ?? String(error)}`];
  if (Array.isArray(error?.diagnostics)) {
    for (const item of error.diagnostics) {
      lines.push(`  - ${item.filename}: ${item.field}: ${item.message}`);
    }
  }
  for (const field of ['stdout', 'stderr']) {
    const value = error?.details?.[field];
    if (typeof value === 'string' && value.trim() !== '') lines.push(value.trim());
  }
  const code = exitCodeForError(error);
  const recovery = error?.code === 'rollback_failed'
    ? 'Recovery: rollback did not complete. Manually inspect every manifest target before retrying; repository publication state may be partial.'
    : error?.code === 'state_update_failed' && error?.details?.commitSha
      ? `Recovery: local publication commit ${error.details.commitSha} is retained; reconcile .publish-state.json with that commit before retrying.`
      : error?.committed === true && error?.commitSha
        ? `Recovery: local publication commit ${error.commitSha} is retained; inspect the Git index and working tree before retrying.`
        : code === EXIT_CODES.validation
    ? 'Recovery: correct the reported configuration or note fields, then rerun the command.'
    : code === EXIT_CODES.build
      ? 'Recovery: resolve the build error; staged preview data was not published, then rerun the command.'
      : code === EXIT_CODES.conflict
        ? 'Recovery: resolve the overlapping repository target without overwriting unrelated work, then rerun.'
        : code === EXIT_CODES.git
          ? 'Recovery: inspect the Git index and working tree; no automatic broad staging is performed.'
          : code === EXIT_CODES.push
            ? 'Recovery: the local publication commit is retained; fix remote access and retry the push.'
            : 'Recovery: inspect the error above and rerun only after the cause is resolved.';
  lines.push(recovery);
  return lines.join('\n');
}

export async function runCli(argv = process.argv.slice(2), {
  runPublishingWorkflow: workflow = runPublishingWorkflow,
  writeError = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  try {
    const options = parseCliArguments(argv);
    await workflow(options);
    return EXIT_CODES.success;
  } catch (error) {
    writeError(formatCliError(error));
    return exitCodeForError(error);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  process.exitCode = await runCli();
}

export function parseCliArguments(argv = []) {
  const [command, ...args] = argv;
  if (!['current', 'pending'].includes(command)) {
    throw new CliUsageError('Publisher command must be current or pending');
  }
  const options = {
    command,
    source: undefined,
    open: true,
    yes: false,
    push: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--source') {
      const value = args[index + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        throw new CliUsageError('--source requires a value');
      }
      options.source = value;
      index += 1;
    } else if (argument === '--no-open') {
      options.open = false;
    } else if (argument === '--yes') {
      options.yes = true;
    } else if (argument === '--no-push') {
      options.push = false;
    } else {
      throw new CliUsageError(`Unknown option: ${argument}`);
    }
  }

  if (command === 'current') {
    if (typeof options.source !== 'string' || options.source === '') {
      throw new CliUsageError('publish:current requires --source <absolute-note-path>');
    }
    if (!path.isAbsolute(options.source)) {
      throw new CliUsageError('--source must be an absolute Markdown note path');
    }
    options.source = path.resolve(options.source);
  } else if (command === 'pending' && options.source !== undefined) {
    throw new CliUsageError('--source is only valid with the current command');
  }
  return options;
}
