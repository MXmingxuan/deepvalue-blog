import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

export const SUPPORTED_IMAGE_EXTENSIONS = Object.freeze([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
]);

const SUPPORTED_IMAGE_EXTENSION_SET = new Set(SUPPORTED_IMAGE_EXTENSIONS);
const PUBLISH_ID_PATTERN = /^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u;
const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const assetIndexVaultRoots = new WeakMap();

function diagnostic(filename, field, message, code, details = {}) {
  return { filename, field, message, ...(code ? { code } : {}), ...details };
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function isInside(root, candidate, { allowRoot = true } = {}) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function caseKey(value) {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function pushMapValue(map, key, value) {
  const values = map.get(key) ?? [];
  if (!values.includes(value)) values.push(value);
  map.set(key, values);
}

function uniqueRecords(records) {
  return [...new Map(records.map((record) => [record.sourcePath, record])).values()];
}

function normalizeReference(rawReference) {
  if (typeof rawReference !== 'string' || rawReference.includes('\0')) return undefined;
  const normalizedSlashes = rawReference.trim().replaceAll('\\', '/');
  if (
    normalizedSlashes === ''
    || normalizedSlashes.startsWith('/')
    || path.win32.isAbsolute(normalizedSlashes)
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(normalizedSlashes.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function safeVaultRelativePath(value) {
  if (
    typeof value !== 'string'
    || value === ''
    || value.includes('\0')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    return undefined;
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function safeStem(filename) {
  const stem = path.posix.basename(filename, path.posix.extname(filename))
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/['’]/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return Array.from(stem || 'image').slice(0, 64).join('').replace(/-+$/g, '') || 'image';
}

function encodeUrlSegment(value) {
  return encodeURIComponent(value);
}

export class AssetPipelineError extends Error {
  constructor(diagnostics, cause) {
    super(diagnostics.map(({ filename, field, message }) => `${filename}: ${field}: ${message}`).join('\n'), {
      cause,
    });
    this.name = 'AssetPipelineError';
    this.diagnostics = diagnostics;
  }
}

async function physicalDirectory(rawPath, { filename, field, code }) {
  try {
    const resolved = await realpath(rawPath);
    const details = await stat(resolved);
    if (!details.isDirectory()) throw new Error('path is not a directory');
    return resolved;
  } catch (error) {
    throw new AssetPipelineError([
      diagnostic(filename, field, 'Configured directory must exist and be readable', code),
    ], error);
  }
}

async function listAttachmentFiles(root, vaultRoot) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      const [physicalDirectory, directoryStats] = await Promise.all([
        realpath(directory),
        lstat(directory),
      ]);
      if (
        directoryStats.isSymbolicLink()
        || !directoryStats.isDirectory()
        || !isInside(vaultRoot, physicalDirectory)
      ) {
        throw new Error('directory no longer resolves inside the Vault');
      }
      entries = await readdir(physicalDirectory, { withFileTypes: true });
      directory = physicalDirectory;
    } catch (error) {
      const relativeDirectory = toPosixPath(path.relative(vaultRoot, directory)) || '<attachment-root>';
      throw new AssetPipelineError([
        diagnostic(relativeDirectory, '<filesystem>', 'Could not read this attachment directory', 'read_error'),
      ], error);
    }

    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      // Never follow links: attachment discovery must remain physically inside the Vault.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }

  await visit(root);
  return files;
}

export async function buildAssetIndex({ vaultRoot, attachmentRoots = [] } = {}) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) {
    throw new AssetPipelineError([
      diagnostic('<vault>', 'vaultRoot', 'Vault root must be an absolute directory path', 'invalid_vault_root'),
    ]);
  }
  const physicalVaultRoot = await physicalDirectory(vaultRoot, {
    filename: '<vault>',
    field: 'vaultRoot',
    code: 'invalid_vault_root',
  });
  if (!Array.isArray(attachmentRoots) || attachmentRoots.length === 0) {
    throw new AssetPipelineError([
      diagnostic('<attachments>', 'attachmentRoots', 'At least one attachment root is required', 'invalid_attachment_roots'),
    ]);
  }

  const physicalAttachmentRoots = [];
  for (const [index, configuredRoot] of attachmentRoots.entries()) {
    if (typeof configuredRoot !== 'string' || configuredRoot.trim() === '') {
      throw new AssetPipelineError([
        diagnostic(
          `<attachment-root:${index}>`,
          `attachmentRoots[${index}]`,
          'Attachment root must be a path inside the Vault',
          'invalid_attachment_root',
        ),
      ]);
    }
    const candidate = path.isAbsolute(configuredRoot)
      ? configuredRoot
      : path.resolve(physicalVaultRoot, configuredRoot);
    const physicalRoot = await physicalDirectory(candidate, {
      filename: `<attachment-root:${index}>`,
      field: `attachmentRoots[${index}]`,
      code: 'invalid_attachment_root',
    });
    if (!isInside(physicalVaultRoot, physicalRoot)) {
      throw new AssetPipelineError([
        diagnostic(
          `<attachment-root:${index}>`,
          `attachmentRoots[${index}]`,
          'Attachment root resolves outside the configured Vault',
          'attachment_root_outside_vault',
        ),
      ]);
    }
    if (!physicalAttachmentRoots.includes(physicalRoot)) physicalAttachmentRoots.push(physicalRoot);
  }

  const recordsBySourcePath = new Map();
  for (const attachmentRoot of physicalAttachmentRoots) {
    const files = await listAttachmentFiles(attachmentRoot, physicalVaultRoot);
    for (const absolutePath of files) {
      const sourcePath = toPosixPath(path.relative(physicalVaultRoot, absolutePath));
      let record = recordsBySourcePath.get(sourcePath);
      if (!record) {
        record = {
          sourcePath,
          rootRelativePaths: [],
        };
        recordsBySourcePath.set(sourcePath, record);
      }
      const rootRelativePath = toPosixPath(path.relative(attachmentRoot, absolutePath));
      if (!record.rootRelativePaths.includes(rootRelativePath)) {
        record.rootRelativePaths.push(rootRelativePath);
      }
    }
  }

  const assets = [...recordsBySourcePath.values()]
    .sort((left, right) => comparePaths(left.sourcePath, right.sourcePath));
  const byVaultRelativePath = new Map();
  const byRootRelativePath = new Map();
  const byBasename = new Map();
  const byVaultRelativePathCaseFolded = new Map();
  const byRootRelativePathCaseFolded = new Map();
  const byBasenameCaseFolded = new Map();

  for (const asset of assets) {
    byVaultRelativePath.set(asset.sourcePath, asset);
    pushMapValue(byVaultRelativePathCaseFolded, caseKey(asset.sourcePath), asset);
    for (const rootRelativePath of asset.rootRelativePaths) {
      pushMapValue(byRootRelativePath, rootRelativePath, asset);
      pushMapValue(byRootRelativePathCaseFolded, caseKey(rootRelativePath), asset);
    }
    const basename = path.posix.basename(asset.sourcePath);
    pushMapValue(byBasename, basename, asset);
    pushMapValue(byBasenameCaseFolded, caseKey(basename), asset);
  }

  const index = {
    assets,
    byVaultRelativePath,
    byRootRelativePath,
    byBasename,
    byVaultRelativePathCaseFolded,
    byRootRelativePathCaseFolded,
    byBasenameCaseFolded,
  };
  assetIndexVaultRoots.set(index, physicalVaultRoot);
  return index;
}

function resolutionError(filename, reference, code, message, matches = []) {
  const sourcePaths = uniqueRecords(matches)
    .map(({ sourcePath }) => sourcePath)
    .sort(comparePaths);
  return new AssetPipelineError([
    diagnostic(filename, 'embed', message, code, {
      reference,
      ...(sourcePaths.length > 0 ? { sourcePaths } : {}),
    }),
  ]);
}

export function resolveAssetReference(assetIndex, rawReference, { filename = '<note>' } = {}) {
  if (!assetIndex?.byVaultRelativePath || !assetIndex?.byBasename) {
    throw new TypeError('An asset index is required to resolve image embeds');
  }
  const reference = normalizeReference(rawReference);
  if (!reference) {
    throw resolutionError(
      filename,
      rawReference,
      'unsafe_asset_reference',
      `Unsafe attachment reference "${rawReference}" must stay inside the Vault`,
    );
  }

  const extension = path.posix.extname(reference).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSION_SET.has(extension)) {
    throw resolutionError(
      filename,
      rawReference,
      'unsupported_asset_type',
      `Attachment "${rawReference}" is not a supported image (${SUPPORTED_IMAGE_EXTENSIONS.join(', ')})`,
    );
  }

  const vaultExact = assetIndex.byVaultRelativePath.get(reference);
  if (vaultExact) return vaultExact;

  const rootExact = uniqueRecords(assetIndex.byRootRelativePath.get(reference) ?? []);
  if (rootExact.length === 1) return rootExact[0];
  if (rootExact.length > 1) {
    throw resolutionError(
      filename,
      rawReference,
      'ambiguous_asset',
      `Attachment "${rawReference}" is ambiguous; use its exact Vault-relative path`,
      rootExact,
    );
  }

  const foldedReference = caseKey(reference);
  const caseMismatch = uniqueRecords([
    ...(assetIndex.byVaultRelativePathCaseFolded.get(foldedReference) ?? []),
    ...(assetIndex.byRootRelativePathCaseFolded.get(foldedReference) ?? []),
  ]);
  if (caseMismatch.length > 0) {
    throw resolutionError(
      filename,
      rawReference,
      'asset_case_mismatch',
      `Attachment "${rawReference}" differs in letter case from the file in the Vault`,
      caseMismatch,
    );
  }

  const basename = path.posix.basename(reference);
  const basenameMatches = uniqueRecords(assetIndex.byBasename.get(basename) ?? []);
  if (basenameMatches.length === 1) return basenameMatches[0];
  if (basenameMatches.length > 1) {
    throw resolutionError(
      filename,
      rawReference,
      'ambiguous_asset',
      `Attachment "${rawReference}" is ambiguous; use its exact Vault-relative path`,
      basenameMatches,
    );
  }

  const basenameCaseMismatch = uniqueRecords(
    assetIndex.byBasenameCaseFolded.get(caseKey(basename)) ?? [],
  );
  if (basenameCaseMismatch.length > 0) {
    throw resolutionError(
      filename,
      rawReference,
      'asset_case_mismatch',
      `Attachment "${rawReference}" differs in letter case from the file in the Vault`,
      basenameCaseMismatch,
    );
  }

  throw resolutionError(
    filename,
    rawReference,
    'missing_asset',
    `Attachment "${rawReference}" was not found in the configured attachment roots`,
  );
}

export async function createAssetDescriptor({
  assetIndex,
  reference,
  publishId,
  filename = '<note>',
} = {}) {
  if (typeof publishId !== 'string' || !PUBLISH_ID_PATTERN.test(publishId)) {
    throw new AssetPipelineError([
      diagnostic(filename, 'publish_id', 'A valid publish_id is required for image output', 'invalid_publish_id'),
    ]);
  }
  const physicalVaultRoot = assetIndexVaultRoots.get(assetIndex);
  if (!physicalVaultRoot) {
    throw new AssetPipelineError([
      diagnostic(filename, 'embed', 'A validated asset index is required', 'invalid_asset_index'),
    ]);
  }
  const resolved = resolveAssetReference(assetIndex, reference, { filename });
  const bytes = await readContainedAssetFile({
    vaultRoot: physicalVaultRoot,
    sourcePath: resolved.sourcePath,
    filename,
    reference,
  });
  const sourceHash = sha256(bytes);
  const extension = path.posix.extname(resolved.sourcePath).toLowerCase();
  const outputName = `${safeStem(path.posix.basename(resolved.sourcePath))}-${sourceHash.slice(0, 12)}${extension}`;

  return {
    sourcePath: resolved.sourcePath,
    sourceHash,
    outputName,
    publicUrl: `/media/${encodeUrlSegment(publishId)}/${encodeUrlSegment(outputName)}`,
  };
}

async function readContainedAssetFile({ vaultRoot, sourcePath, filename, reference }) {
  const safeRelativePath = safeVaultRelativePath(sourcePath);
  if (!safeRelativePath) {
    throw new AssetPipelineError([
      diagnostic(
        filename,
        'source',
        'Asset source must be a Vault-relative path without traversal',
        'invalid_asset_descriptor',
        { ...(reference ? { reference } : {}) },
      ),
    ]);
  }

  const lexicalPath = path.resolve(vaultRoot, ...safeRelativePath.split('/'));
  if (!isInside(vaultRoot, lexicalPath, { allowRoot: false })) {
    throw new AssetPipelineError([
      diagnostic(filename, 'source', 'Asset source must stay inside the Vault', 'invalid_asset_descriptor'),
    ]);
  }

  let handle;
  try {
    const physicalParent = await realpath(path.dirname(lexicalPath));
    if (!isInside(vaultRoot, physicalParent)) throw new Error('parent resolves outside the Vault');
    const physicalPath = path.join(physicalParent, path.basename(lexicalPath));
    handle = await open(physicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) throw new Error('source is not a regular file');

    const [resolvedPath, currentStats] = await Promise.all([
      realpath(physicalPath),
      stat(physicalPath),
    ]);
    if (
      !isInside(vaultRoot, resolvedPath, { allowRoot: false })
      || (openedStats.dev !== undefined && currentStats.dev !== openedStats.dev)
      || (openedStats.ino !== undefined && currentStats.ino !== openedStats.ino)
    ) {
      throw new Error('source identity changed during validation');
    }

    const bytes = await handle.readFile();
    const afterReadStats = await stat(physicalPath);
    if (
      (openedStats.dev !== undefined && afterReadStats.dev !== openedStats.dev)
      || (openedStats.ino !== undefined && afterReadStats.ino !== openedStats.ino)
    ) {
      throw new Error('source identity changed while reading');
    }
    return bytes;
  } catch (error) {
    throw new AssetPipelineError([
      diagnostic(
        filename,
        'source',
        `Attachment "${reference ?? sourcePath}" changed or no longer resolves safely inside the Vault`,
        'asset_source_changed',
        { ...(reference ? { reference } : {}) },
      ),
    ], error);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function validateCopyDescriptor(asset, index) {
  const filename = asset?.sourcePath ?? `<asset:${index}>`;
  if (
    !asset
    || typeof asset !== 'object'
    || !safeVaultRelativePath(asset.sourcePath)
    || typeof asset.sourceHash !== 'string'
    || !SOURCE_HASH_PATTERN.test(asset.sourceHash)
  ) {
    throw new AssetPipelineError([
      diagnostic(
        filename,
        'asset',
        'Asset descriptor requires a safe Vault-relative sourcePath and SHA-256 sourceHash',
        'invalid_asset_descriptor',
      ),
    ]);
  }
  if (
    typeof asset.outputName !== 'string'
    || asset.outputName === ''
    || asset.outputName !== path.basename(asset.outputName)
    || asset.outputName.includes('/')
    || asset.outputName.includes('\\')
  ) {
    throw new AssetPipelineError([
      diagnostic(filename, 'outputName', 'Asset output name must be a safe filename', 'unsafe_staging_target'),
    ]);
  }
  if (!SUPPORTED_IMAGE_EXTENSION_SET.has(path.extname(asset.outputName).toLowerCase())) {
    throw new AssetPipelineError([
      diagnostic(filename, 'outputName', 'Asset output must use a supported image extension', 'unsupported_asset_type'),
    ]);
  }
  return filename;
}

function sameFileIdentity(left, right) {
  return left?.isDirectory?.() === right?.isDirectory?.()
    && left?.dev === right?.dev
    && left?.ino === right?.ino;
}

export async function createStagingDirectoryGuard(stagingDir) {
  if (typeof stagingDir !== 'string' || !path.isAbsolute(stagingDir)) {
    throw new AssetPipelineError([
      diagnostic('<staging>', 'stagingDir', 'Staging directory must be an absolute path', 'unsafe_staging_directory'),
    ]);
  }

  let directoryHandle;
  try {
    const lexicalStats = await lstat(stagingDir);
    if (!lexicalStats.isDirectory() || lexicalStats.isSymbolicLink()) {
      throw new Error('staging path is not a physical directory');
    }
    const physicalPath = await realpath(stagingDir);
    const physicalStats = await lstat(physicalPath);
    if (!physicalStats.isDirectory() || physicalStats.isSymbolicLink()) {
      throw new Error('staging path is not a physical directory');
    }

    directoryHandle = await open(
      physicalPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const openedStats = await directoryHandle.stat();
    if (!openedStats.isDirectory() || !sameFileIdentity(openedStats, physicalStats)) {
      throw new Error('staging directory identity changed while opening');
    }

    let closed = false;
    return {
      path: physicalPath,
      async assertStable() {
        if (closed) {
          throw new AssetPipelineError([
            diagnostic('<staging>', 'stagingDir', 'Staging directory guard is closed', 'unsafe_staging_directory'),
          ]);
        }
        try {
          const [resolvedNow, pathStats, handleStats] = await Promise.all([
            realpath(physicalPath),
            lstat(physicalPath),
            directoryHandle.stat(),
          ]);
          if (
            resolvedNow !== physicalPath
            || pathStats.isSymbolicLink()
            || !pathStats.isDirectory()
            || !sameFileIdentity(openedStats, pathStats)
            || !sameFileIdentity(openedStats, handleStats)
          ) {
            throw new Error('staging directory identity changed');
          }
          return physicalPath;
        } catch (error) {
          if (error instanceof AssetPipelineError) throw error;
          throw new AssetPipelineError([
            diagnostic(
              '<staging>',
              'stagingDir',
              'Staging directory was replaced during asset copying',
              'unsafe_staging_directory',
            ),
          ], error);
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        await directoryHandle.close();
      },
    };
  } catch (error) {
    if (directoryHandle) await directoryHandle.close().catch(() => {});
    if (error instanceof AssetPipelineError) throw error;
    throw new AssetPipelineError([
      diagnostic(
        '<staging>',
        'stagingDir',
        'Staging directory could not be bound to a stable directory handle',
        'unsafe_staging_directory',
      ),
    ], error);
  }
}

export async function copyAssets({ assets = [], stagingDir, vaultRoot } = {}) {
  if (!Array.isArray(assets)) throw new TypeError('assets must be an array');
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) {
    throw new AssetPipelineError([
      diagnostic('<vault>', 'vaultRoot', 'A trusted absolute Vault root is required', 'invalid_vault_root'),
    ]);
  }
  const physicalVaultRoot = await physicalDirectory(vaultRoot, {
    filename: '<vault>',
    field: 'vaultRoot',
    code: 'invalid_vault_root',
  });
  if (typeof stagingDir !== 'string' || !path.isAbsolute(stagingDir)) {
    throw new AssetPipelineError([
      diagnostic('<staging>', 'stagingDir', 'Staging directory must be an absolute path', 'unsafe_staging_directory'),
    ]);
  }

  await mkdir(stagingDir, { recursive: true });
  const stagingGuard = await createStagingDirectoryGuard(stagingDir);
  const physicalStagingDir = stagingGuard.path;
  const copied = [];
  const copiedByName = new Map();

  try {
    for (const [index, asset] of assets.entries()) {
      await stagingGuard.assertStable();
      const filename = validateCopyDescriptor(asset, index);
      const existingDescriptor = copiedByName.get(asset.outputName);
      if (existingDescriptor) {
        if (
          existingDescriptor.sourcePath !== asset.sourcePath
          || existingDescriptor.sourceHash !== asset.sourceHash
        ) {
          throw new AssetPipelineError([
            diagnostic(filename, 'outputName', 'Two different assets map to the same staging filename', 'asset_name_collision'),
          ]);
        }
        continue;
      }

      const destination = path.join(physicalStagingDir, asset.outputName);
      if (!isInside(physicalStagingDir, destination, { allowRoot: false })) {
        throw new AssetPipelineError([
          diagnostic(filename, 'outputName', 'Asset staging target escapes the staging directory', 'unsafe_staging_target'),
        ]);
      }
      try {
        await lstat(destination);
        throw new AssetPipelineError([
          diagnostic(filename, 'outputName', 'Asset staging target already exists or is a symlink', 'unsafe_staging_target'),
        ]);
      } catch (error) {
        if (error instanceof AssetPipelineError) throw error;
        if (error?.code !== 'ENOENT') {
          throw new AssetPipelineError([
            diagnostic(filename, 'outputName', 'Asset staging target could not be inspected safely', 'unsafe_staging_target'),
          ], error);
        }
      }

      const bytes = await readContainedAssetFile({
        vaultRoot: physicalVaultRoot,
        sourcePath: asset.sourcePath,
        filename,
      });
      const sourceHash = sha256(bytes);
      if (sourceHash !== asset.sourceHash) {
        throw new AssetPipelineError([
          diagnostic(filename, 'source', 'Asset source changed after transformation; restart publication', 'asset_source_changed'),
        ]);
      }

      await stagingGuard.assertStable();
      let handle;
      let openedDestinationStats;
      try {
        handle = await open(destination, 'wx', 0o600);
        openedDestinationStats = await handle.stat();
        await stagingGuard.assertStable();
        const destinationStats = await stat(destination);
        if (!openedDestinationStats.isFile() || !sameFileIdentity(openedDestinationStats, destinationStats)) {
          throw new AssetPipelineError([
            diagnostic(
              filename,
              'outputName',
              'Asset staging target identity changed before writing',
              'unsafe_staging_target',
            ),
          ]);
        }

        await handle.writeFile(bytes);
        await stagingGuard.assertStable();
        const finalDestinationStats = await stat(destination);
        if (!sameFileIdentity(openedDestinationStats, finalDestinationStats)) {
          throw new AssetPipelineError([
            diagnostic(
              filename,
              'outputName',
              'Asset staging target identity changed while writing',
              'unsafe_staging_target',
            ),
          ]);
        }
        await handle.close();
        handle = undefined;
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (!(error instanceof AssetPipelineError)) {
          const code = error?.code === 'EEXIST' ? 'unsafe_staging_target' : 'asset_copy_failed';
          error = new AssetPipelineError([
            diagnostic(filename, 'outputName', 'Asset could not be copied into the staging directory', code),
          ], error);
        }
        try {
          await stagingGuard.assertStable();
          if (openedDestinationStats) await rm(destination, { force: true });
        } catch {
          // Never follow a replaced staging parent merely to clean up a failed write.
        }
        throw error;
      }

      const result = { ...asset, stagedPath: destination };
      copied.push(result);
      copiedByName.set(asset.outputName, result);
    }
  } finally {
    await stagingGuard.close();
  }

  return copied;
}
