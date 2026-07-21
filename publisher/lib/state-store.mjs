import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
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

async function writeAtomically(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(statePath),
    `${path.basename(statePath)}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`,
  );

  try {
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, statePath);
  } catch (error) {
    await rm(tempPath, { force: true });
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

  async function assertPhysicalContainment() {
    let physicalRepoRoot;
    let physicalStatePath;
    try {
      [physicalRepoRoot, physicalStatePath] = await Promise.all([
        realpath(normalizedRepoRoot),
        realpathAllowMissing(normalizedStatePath),
      ]);
    } catch (error) {
      throw new StateValidationError([
        diagnostic(
          normalizedStatePath,
          '<root>',
          `State path could not be resolved safely: ${error.message}`,
          'path_error',
        ),
      ], error);
    }

    if (!isInside(physicalRepoRoot, physicalStatePath, { allowRoot: false })) {
      throw new StateValidationError([
        diagnostic(
          normalizedStatePath,
          '<root>',
          'State file resolves outside the repository through a symlink',
          'unsafe_path',
        ),
      ]);
    }
  }

  async function recoverCorruptState(raw, error) {
    const backupPath = `${normalizedStatePath}.corrupt-${Date.now()}-${randomUUID()}.bak`;
    await rename(normalizedStatePath, backupPath);
    const recovered = structuredClone(DEFAULT_STATE);
    await writeAtomically(normalizedStatePath, recovered);
    return { state: recovered, backupPath, error, raw };
  }

  async function readState() {
    await assertPhysicalContainment();
    let raw;
    try {
      raw = await readFile(normalizedStatePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return structuredClone(DEFAULT_STATE);
      throw error;
    }

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
      const recovery = await recoverCorruptState(raw, error);
      return recovery.state;
    }
  }

  async function writeState(state) {
    await assertPhysicalContainment();
    const safeState = sanitizeState(state, normalizedStatePath);
    await writeAtomically(normalizedStatePath, safeState);
    return safeState;
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
