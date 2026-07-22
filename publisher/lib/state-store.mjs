import { randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;
const DEFAULT_STATE = Object.freeze({ version: STATE_VERSION, entries: Object.freeze({}) });
const updateQueues = new Map();
const PUBLISH_ID_PATTERN = /^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u;
const SOURCE_HASH_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/iu;

function diagnostic(filename, field, message, code) {
  return { filename, field, message, ...(code ? { code } : {}) };
}

function queueKey(statePath) {
  return process.platform === 'win32' ? statePath.toLowerCase() : statePath;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInside(root, candidate, { allowRoot = true } = {}) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function realpathAllowMissing(candidate) {
  const suffix = [];
  let current = candidate;
  while (true) {
    try {
      const resolved = await realpath(current);
      return path.resolve(resolved, ...suffix);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) return null;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return null;

  const portable = value.replaceAll('\\', '/');
  const normalized = path.posix.normalize(portable);
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.startsWith('/')
  ) {
    return null;
  }
  return normalized;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function sanitizeState(state, filename) {
  const diagnostics = [];
  if (!isPlainObject(state)) {
    throw new StateValidationError([
      diagnostic(filename, '<root>', 'Publisher state must be a JSON object', 'invalid_state'),
    ]);
  }

  if (state.version !== undefined && state.version !== STATE_VERSION) {
    diagnostics.push(diagnostic(
      filename,
      'version',
      `Publisher state version must be ${STATE_VERSION}`,
      'unsupported_version',
    ));
  }

  if (state.entries !== undefined && !isPlainObject(state.entries)) {
    diagnostics.push(diagnostic(filename, 'entries', 'Publisher state entries must be an object', 'invalid_type'));
  }

  const entries = {};
  if (isPlainObject(state.entries)) {
    for (const [publishId, rawEntry] of Object.entries(state.entries)) {
      const entryField = `entries.${publishId}`;
      if (!PUBLISH_ID_PATTERN.test(publishId)) {
        diagnostics.push(diagnostic(
          filename,
          entryField,
          'State entry key must be a valid publish_id',
          'invalid_publish_id',
        ));
      }
      if (!isPlainObject(rawEntry)) {
        diagnostics.push(diagnostic(filename, entryField, 'State entry must be an object', 'invalid_type'));
        continue;
      }

      const safeEntry = {};
      for (const field of ['sourcePath', 'emittedMarkdownPath']) {
        if (rawEntry[field] === undefined || rawEntry[field] === null) continue;
        const relativePath = normalizeRelativePath(rawEntry[field]);
        if (!relativePath) {
          diagnostics.push(diagnostic(
            filename,
            `${entryField}.${field}`,
            `${field} must be a relative path without parent traversal`,
            'unsafe_path',
          ));
        } else {
          safeEntry[field] = relativePath;
        }
      }

      if (rawEntry.emittedAssetPaths !== undefined && !Array.isArray(rawEntry.emittedAssetPaths)) {
        diagnostics.push(diagnostic(
          filename,
          `${entryField}.emittedAssetPaths`,
          'emittedAssetPaths must be an array of repository-relative paths',
          'invalid_type',
        ));
      }
      safeEntry.emittedAssetPaths = [];
      if (Array.isArray(rawEntry.emittedAssetPaths)) {
        for (const [index, assetPath] of rawEntry.emittedAssetPaths.entries()) {
          const relativePath = normalizeRelativePath(assetPath);
          if (!relativePath) {
            diagnostics.push(diagnostic(
              filename,
              `${entryField}.emittedAssetPaths[${index}]`,
              'Emitted asset path must be repository-relative without parent traversal',
              'unsafe_path',
            ));
          } else {
            safeEntry.emittedAssetPaths.push(relativePath);
          }
        }
      }

      if (rawEntry.lastPublishedSourceHash !== undefined && rawEntry.lastPublishedSourceHash !== null) {
        if (
          typeof rawEntry.lastPublishedSourceHash !== 'string'
          || !SOURCE_HASH_PATTERN.test(rawEntry.lastPublishedSourceHash)
        ) {
          diagnostics.push(diagnostic(
            filename,
            `${entryField}.lastPublishedSourceHash`,
            'lastPublishedSourceHash must be a SHA-256 hex digest',
            'invalid_hash',
          ));
        } else {
          safeEntry.lastPublishedSourceHash = rawEntry.lastPublishedSourceHash;
        }
      }

      for (const field of ['publishedAt', 'updatedAt']) {
        const value = rawEntry[field];
        if (value === undefined || value === null) continue;
        if (!isCanonicalTimestamp(value)) {
          diagnostics.push(diagnostic(
            filename,
            `${entryField}.${field}`,
            `${field} must be a canonical ISO 8601 timestamp`,
            'invalid_timestamp',
          ));
        } else {
          safeEntry[field] = value;
        }
      }

      entries[publishId] = safeEntry;
    }
  }

  if (diagnostics.length > 0) throw new StateValidationError(diagnostics);
  return { version: STATE_VERSION, entries };
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function assertSafeTarget(targetPath, { allowMissing = true } = {}) {
  try {
    const details = await lstat(targetPath);
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new StateValidationError([
        diagnostic(targetPath, '<root>', 'State target must be a regular file, never a symlink', 'unsafe_path'),
      ]);
    }
    return details;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAtomically(statePath, state, guard) {
  await guard.assertStable();
  const expectedTarget = await assertSafeTarget(statePath);
  const tempPath = path.join(
    path.dirname(statePath),
    `${path.basename(statePath)}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`,
  );

  let handle;
  let tempIdentity;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const openedStats = await handle.stat();
    tempIdentity = { dev: openedStats.dev, ino: openedStats.ino };
    const [pathStats, resolvedTemp] = await Promise.all([lstat(tempPath), realpath(tempPath)]);
    if (
      !openedStats.isFile()
      || pathStats.isSymbolicLink()
      || !sameIdentity(openedStats, pathStats)
      || !isInside(guard.physicalRepoRoot, resolvedTemp, { allowRoot: false })
      || path.dirname(resolvedTemp) !== guard.physicalParent
    ) {
      throw new StateValidationError([
        diagnostic(statePath, '<root>', 'State temporary file escaped its stable repository parent', 'unsafe_path'),
      ]);
    }
    await guard.assertStable();
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await guard.assertStable();
    const currentTarget = await assertSafeTarget(statePath);
    if (
      Boolean(expectedTarget) !== Boolean(currentTarget)
      || (expectedTarget && !sameIdentity(expectedTarget, currentTarget))
    ) {
      throw new StateValidationError([
        diagnostic(statePath, '<root>', 'State target changed before atomic replacement', 'unsafe_path'),
      ]);
    }
    await rename(tempPath, statePath);
    await guard.assertStable();
    const finalTarget = await assertSafeTarget(statePath, { allowMissing: false });
    if (!sameIdentity(tempIdentity, finalTarget)) {
      throw new StateValidationError([
        diagnostic(statePath, '<root>', 'State target identity changed during atomic replacement', 'unsafe_path'),
      ]);
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    try {
      await guard.assertStable();
      const remainingTemp = await lstat(tempPath).catch((inspectionError) => {
        if (inspectionError?.code === 'ENOENT') return undefined;
        throw inspectionError;
      });
      if (remainingTemp && tempIdentity && sameIdentity(tempIdentity, remainingTemp)) {
        await rm(tempPath, { force: true });
      }
    } catch {
      // Never resolve a cleanup path through a replaced state parent.
    }
    throw error;
  }
}

export class StateValidationError extends Error {
  constructor(diagnostics, cause) {
    super(diagnostics.map(({ filename, field, message }) => `${filename}: ${field}: ${message}`).join('\n'), {
      cause,
    });
    this.name = 'StateValidationError';
    this.diagnostics = diagnostics;
  }
}

export function createStateStore({ repoRoot = process.cwd(), statePath } = {}) {
  const normalizedRepoRoot = path.resolve(repoRoot);
  let initialPhysicalRepoRoot;
  let initialRepoIdentity;
  try {
    initialPhysicalRepoRoot = realpathSync(normalizedRepoRoot);
    const details = lstatSync(initialPhysicalRepoRoot);
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('repository root is not a physical directory');
    initialRepoIdentity = { dev: details.dev, ino: details.ino };
  } catch (error) {
    throw new StateValidationError([
      diagnostic(normalizedRepoRoot, '<root>', 'Repository root must be a stable physical directory', 'unsafe_path'),
    ], error);
  }
  const normalizedStatePath = path.resolve(statePath ?? path.join(normalizedRepoRoot, '.publish-state.json'));
  const relativeStatePath = path.relative(normalizedRepoRoot, normalizedStatePath);
  if (
    relativeStatePath.startsWith(`..${path.sep}`)
    || relativeStatePath === '..'
    || path.isAbsolute(relativeStatePath)
  ) {
    throw new StateValidationError([
      diagnostic(normalizedStatePath, '<root>', 'State file must stay inside the repository', 'unsafe_path'),
    ]);
  }
  const key = queueKey(normalizedStatePath);
  let boundParentIdentity;

  async function openParentGuard() {
    let physicalRepoRoot;
    let physicalParent;
    let parentHandle;
    try {
      physicalRepoRoot = await realpath(normalizedRepoRoot);
      const repoStats = await lstat(physicalRepoRoot);
      if (
        physicalRepoRoot !== initialPhysicalRepoRoot
        || repoStats.isSymbolicLink()
        || !repoStats.isDirectory()
        || !sameIdentity(initialRepoIdentity, repoStats)
      ) {
        throw new Error('repository root identity changed');
      }
      const prospectiveParent = await realpathAllowMissing(path.dirname(normalizedStatePath));
      if (!isInside(physicalRepoRoot, prospectiveParent)) throw new Error('parent resolves outside repository');
      await mkdir(path.dirname(normalizedStatePath), { recursive: true });
      physicalParent = await realpath(path.dirname(normalizedStatePath));
      if (!isInside(physicalRepoRoot, physicalParent)) throw new Error('parent resolves outside repository');
      const pathStats = await lstat(physicalParent);
      if (!pathStats.isDirectory() || pathStats.isSymbolicLink()) throw new Error('parent is not a physical directory');
      parentHandle = await open(
        physicalParent,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      const handleStats = await parentHandle.stat();
      if (!handleStats.isDirectory() || !sameIdentity(handleStats, pathStats)) {
        throw new Error('parent identity changed while opening');
      }
      if (boundParentIdentity && !sameIdentity(boundParentIdentity, handleStats)) {
        throw new Error('state parent was replaced after the store was bound');
      }
      boundParentIdentity ??= { dev: handleStats.dev, ino: handleStats.ino };
    } catch (error) {
      if (parentHandle) await parentHandle.close().catch(() => {});
      throw new StateValidationError([
        diagnostic(
          normalizedStatePath,
          '<root>',
          `State path could not be resolved safely: ${error.message}`,
          'unsafe_path',
        ),
      ], error);
    }

    let closed = false;
    return {
      physicalRepoRoot,
      physicalParent,
      async assertStable() {
        if (closed) throw new Error('state parent guard is closed');
        try {
          const [resolvedNow, pathStats, handleStats] = await Promise.all([
            realpath(path.dirname(normalizedStatePath)),
            lstat(path.dirname(normalizedStatePath)),
            parentHandle.stat(),
          ]);
          if (
            resolvedNow !== physicalParent
            || pathStats.isSymbolicLink()
            || !pathStats.isDirectory()
            || !sameIdentity(boundParentIdentity, pathStats)
            || !sameIdentity(boundParentIdentity, handleStats)
          ) {
            throw new Error('state parent identity changed');
          }
        } catch (error) {
          throw new StateValidationError([
            diagnostic(
              normalizedStatePath,
              '<root>',
              'State parent was replaced during the operation',
              'unsafe_path',
            ),
          ], error);
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        await parentHandle.close();
      },
    };
  }

  async function recoverCorruptState(raw, error, guard, expectedTarget) {
    await guard.assertStable();
    const currentTarget = await assertSafeTarget(normalizedStatePath, { allowMissing: false });
    if (!sameIdentity(expectedTarget, currentTarget)) {
      throw new StateValidationError([
        diagnostic(normalizedStatePath, '<root>', 'State target changed before corrupt-state recovery', 'unsafe_path'),
      ]);
    }
    const backupPath = `${normalizedStatePath}.corrupt-${Date.now()}-${randomUUID()}.bak`;
    await rename(normalizedStatePath, backupPath);
    await guard.assertStable();
    const recovered = structuredClone(DEFAULT_STATE);
    await writeAtomically(normalizedStatePath, recovered, guard);
    return { state: recovered, backupPath, error, raw };
  }

  async function readState() {
    const guard = await openParentGuard();
    let handle;
    try {
      await guard.assertStable();
      const targetStats = await assertSafeTarget(normalizedStatePath);
      if (!targetStats) return structuredClone(DEFAULT_STATE);
      handle = await open(normalizedStatePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const openedStats = await handle.stat();
      const pathStats = await lstat(normalizedStatePath);
      if (!openedStats.isFile() || pathStats.isSymbolicLink() || !sameIdentity(openedStats, pathStats)) {
        throw new StateValidationError([
          diagnostic(normalizedStatePath, '<root>', 'State target identity changed while opening', 'unsafe_path'),
        ]);
      }
      await guard.assertStable();
      const raw = await handle.readFile('utf8');
      await handle.close();
      handle = undefined;
      await guard.assertStable();

      try {
        return sanitizeState(JSON.parse(raw), normalizedStatePath);
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof StateValidationError)) throw error;
        if (
          error instanceof StateValidationError
          && error.diagnostics.some(({ code }) => code === 'unsupported_version')
        ) {
          throw error;
        }
        const recovery = await recoverCorruptState(raw, error, guard, openedStats);
        return recovery.state;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return structuredClone(DEFAULT_STATE);
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await guard.close().catch(() => {});
    }
  }

  async function writeState(state) {
    const safeState = sanitizeState(state, normalizedStatePath);
    const guard = await openParentGuard();
    try {
      await writeAtomically(normalizedStatePath, safeState, guard);
      return safeState;
    } finally {
      await guard.close().catch(() => {});
    }
  }

  async function updateState(updater) {
    if (typeof updater !== 'function') throw new TypeError('State updater must be a function');
    const previous = updateQueues.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      const current = await readState();
      const next = await updater(structuredClone(current));
      return writeState(next);
    });
    const settled = run.catch(() => {});
    updateQueues.set(key, settled);
    settled.finally(() => {
      if (updateQueues.get(key) === settled) updateQueues.delete(key);
    });
    return run;
  }

  return {
    statePath: normalizedStatePath,
    readState,
    writeState,
    updateState,
  };
}
