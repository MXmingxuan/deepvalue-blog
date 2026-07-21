import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'node:path';

import { parseNoteMarkdown } from './frontmatter.mjs';
import { resolvePublishIdentity } from './identity.mjs';

function diagnostic(filename, field, message, code, details = {}) {
  return { filename, field, message, ...(code ? { code } : {}), ...details };
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(root, candidate, { allowRoot = true } = {}) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function normalizedIgnoreRules(ignoreFolders = []) {
  if (!Array.isArray(ignoreFolders)) return [];
  return ignoreFolders
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''))
    .filter((item) => item !== '' && item !== '.' && item !== '..' && !item.startsWith('../'));
}

function isIgnoredDirectory(relativePath, ignoreRules) {
  const segments = relativePath.split('/');
  return ignoreRules.some((rule) => (
    rule.includes('/')
      ? relativePath === rule || relativePath.startsWith(`${rule}/`)
      : segments.includes(rule)
  ));
}

function noteBasename(sourcePath) {
  return path.posix.basename(sourcePath).replace(/\.md$/iu, '');
}

function normalizeLinkTarget(rawTarget) {
  if (typeof rawTarget !== 'string' || rawTarget.includes('\0')) return undefined;
  const withoutHeading = rawTarget.split('#', 1)[0].trim().replaceAll('\\', '/');
  if (withoutHeading === '' || withoutHeading.startsWith('/') || path.win32.isAbsolute(withoutHeading)) {
    return undefined;
  }
  const normalized = path.posix.normalize(withoutHeading.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

export class VaultIndexError extends Error {
  constructor(diagnostics, cause) {
    super(diagnostics.map(({ filename, field, message }) => `${filename}: ${field}: ${message}`).join('\n'), {
      cause,
    });
    this.name = 'VaultIndexError';
    this.diagnostics = diagnostics;
  }
}

async function resolveVaultRoot(vaultRoot) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot)) {
    throw new VaultIndexError([
      diagnostic('<vault>', 'vaultRoot', 'Vault root must be an absolute directory path', 'invalid_vault_root'),
    ]);
  }

  try {
    const physicalRoot = await realpath(vaultRoot);
    const rootStats = await stat(physicalRoot);
    if (!rootStats.isDirectory()) throw new Error('path is not a directory');
    return physicalRoot;
  } catch (error) {
    throw new VaultIndexError([
      diagnostic('<vault>', 'vaultRoot', 'Vault root must exist and be a readable directory', 'invalid_vault_root'),
    ], error);
  }
}

async function listMarkdownFiles(physicalVaultRoot, ignoreFolders) {
  const ignoreRules = normalizedIgnoreRules(ignoreFolders);
  const files = [];

  async function visit(directory, relativeDirectory = '') {
    let entries;
    try {
      const [physicalDirectory, directoryStats] = await Promise.all([
        realpath(directory),
        lstat(directory),
      ]);
      if (
        directoryStats.isSymbolicLink()
        || !directoryStats.isDirectory()
        || !isInside(physicalVaultRoot, physicalDirectory)
      ) {
        throw new Error('directory no longer resolves inside the Vault');
      }
      entries = await readdir(physicalDirectory, { withFileTypes: true });
      directory = physicalDirectory;
    } catch (error) {
      throw new VaultIndexError([
        diagnostic(
          relativeDirectory || '<vault>',
          '<filesystem>',
          'Could not read this Vault directory',
          'read_error',
        ),
      ], error);
    }

    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);

      // Never traverse or read symlinks. A symlink can silently cross the Vault boundary.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!isIgnoredDirectory(relativePath, ignoreRules)) {
          await visit(absolutePath, relativePath);
        }
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.md') {
        files.push({ sourcePath: relativePath });
      }
    }
  }

  await visit(physicalVaultRoot);
  return files.sort((left, right) => comparePaths(left.sourcePath, right.sourcePath));
}

async function readContainedVaultFile(vaultRoot, sourcePath) {
  const safeRelativePath = safeVaultRelativePath(sourcePath);
  if (!safeRelativePath) {
    throw new VaultIndexError([
      diagnostic(sourcePath || '<note>', 'source', 'Note path must stay inside the Vault', 'source_outside_vault'),
    ]);
  }

  const lexicalPath = path.resolve(vaultRoot, ...safeRelativePath.split('/'));
  if (!isInside(vaultRoot, lexicalPath, { allowRoot: false })) {
    throw new VaultIndexError([
      diagnostic(safeRelativePath, 'source', 'Note path must stay inside the Vault', 'source_outside_vault'),
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
    return await handle.readFile();
  } catch (error) {
    throw new VaultIndexError([
      diagnostic(
        sourcePath,
        '<filesystem>',
        'Markdown note could not be read safely from inside the Vault',
        'source_changed',
      ),
    ], error);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readNoteRecord({ vaultRoot, sourcePath }) {
  const bytes = await readContainedVaultFile(vaultRoot, sourcePath);

  const source = bytes.toString('utf8');
  const parsed = parseNoteMarkdown(source, { filename: sourcePath });
  if (!parsed.eligible) return { sourcePath, eligible: false };

  const identity = parsed.eligible
    ? resolvePublishIdentity({ data: parsed.data, body: parsed.body, sourcePath })
    : undefined;

  return {
    sourcePath,
    sourceHash: hashBytes(bytes),
    data: parsed.data,
    body: parsed.body,
    eligible: parsed.eligible,
    publishId: identity?.publishId,
    generatedPublishId: identity?.generated ?? false,
    suggestedField: identity?.suggestedField,
  };
}

function duplicatePublishIdDiagnostics(notes) {
  const pathsByPublishId = new Map();
  for (const note of notes) {
    if (!note.eligible) continue;
    const paths = pathsByPublishId.get(note.publishId) ?? [];
    paths.push(note.sourcePath);
    pathsByPublishId.set(note.publishId, paths);
  }

  const diagnostics = [];
  for (const [publishId, sourcePaths] of pathsByPublishId) {
    if (sourcePaths.length < 2) continue;
    sourcePaths.sort(comparePaths);
    diagnostics.push(diagnostic(
      sourcePaths[0],
      'publish_id',
      `Duplicate publish_id "${publishId}" appears in: ${sourcePaths.join(', ')}`,
      'duplicate_publish_id',
      { publishId, sourcePaths },
    ));
  }
  return diagnostics;
}

export async function buildVaultIndex({ vaultRoot, ignoreFolders = [] } = {}) {
  const physicalVaultRoot = await resolveVaultRoot(vaultRoot);
  const files = await listMarkdownFiles(physicalVaultRoot, ignoreFolders);
  const notes = [];
  for (const file of files) {
    notes.push(await readNoteRecord({ ...file, vaultRoot: physicalVaultRoot }));
  }

  const duplicateDiagnostics = duplicatePublishIdDiagnostics(notes);
  if (duplicateDiagnostics.length > 0) throw new VaultIndexError(duplicateDiagnostics);

  const byRelativePath = new Map();
  const byExtensionlessRelativePath = new Map();
  const byBasename = new Map();
  const byPublishId = new Map();
  for (const note of notes) {
    byRelativePath.set(note.sourcePath, note);
    const extensionlessPath = note.sourcePath.replace(/\.md$/iu, '');
    const extensionlessMatches = byExtensionlessRelativePath.get(extensionlessPath) ?? [];
    extensionlessMatches.push(note);
    byExtensionlessRelativePath.set(extensionlessPath, extensionlessMatches);
    const basename = noteBasename(note.sourcePath);
    const basenameMatches = byBasename.get(basename) ?? [];
    basenameMatches.push(note);
    byBasename.set(basename, basenameMatches);
    if (note.eligible) byPublishId.set(note.publishId, note);
  }

  return {
    notes,
    eligibleNotes: notes.filter(({ eligible }) => eligible),
    byRelativePath,
    byExtensionlessRelativePath,
    byBasename,
    byPublishId,
  };
}

export function resolveNoteLink(index, rawTarget) {
  if (!index?.byRelativePath || !index?.byBasename) {
    throw new TypeError('A Vault index is required to resolve note links');
  }

  const target = normalizeLinkTarget(rawTarget);
  if (!target) return undefined;

  if (path.posix.extname(target).toLowerCase() === '.md') {
    const exact = index.byRelativePath.get(target);
    if (exact) return exact;
  } else {
    const extensionlessMatches = index.byExtensionlessRelativePath?.get(target) ?? [];
    if (extensionlessMatches.length === 1) return extensionlessMatches[0];
    if (extensionlessMatches.length > 1) {
      const sourcePaths = extensionlessMatches.map(({ sourcePath }) => sourcePath).sort(comparePaths);
      throw new VaultIndexError([
        diagnostic(
          '<link>',
          'link',
          `Ambiguous exact note link "${rawTarget}" matches: ${sourcePaths.join(', ')}`,
          'ambiguous_note_link',
          { reference: rawTarget, sourcePaths },
        ),
      ]);
    }
  }

  const basename = noteBasename(target);
  const matches = index.byBasename.get(basename) ?? [];
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  const sourcePaths = matches.map(({ sourcePath }) => sourcePath).sort(comparePaths);
  throw new VaultIndexError([
    diagnostic(
      '<link>',
      'link',
      `Ambiguous note link "${rawTarget}" matches: ${sourcePaths.join(', ')}`,
      'ambiguous_note_link',
      { reference: rawTarget, sourcePaths },
    ),
  ]);
}

export async function scanCurrentNote({
  vaultRoot,
  sourcePath,
  ignoreFolders = [],
} = {}) {
  const physicalVaultRoot = await resolveVaultRoot(vaultRoot);
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw new VaultIndexError([
      diagnostic('<current-note>', 'source', 'Current note source must be an absolute path inside the Vault', 'invalid_source'),
    ]);
  }

  let physicalSource;
  let sourceStats;
  try {
    physicalSource = await realpath(sourcePath);
    sourceStats = await stat(physicalSource);
  } catch (error) {
    throw new VaultIndexError([
      diagnostic('<current-note>', 'source', 'Current note must exist inside the Vault', 'invalid_source'),
    ], error);
  }

  if (!isInside(physicalVaultRoot, physicalSource, { allowRoot: false })) {
    throw new VaultIndexError([
      diagnostic('<current-note>', 'source', 'Current note resolves outside the configured Vault', 'source_outside_vault'),
    ]);
  }
  if (!sourceStats.isFile() || path.extname(physicalSource).toLowerCase() !== '.md') {
    throw new VaultIndexError([
      diagnostic('<current-note>', 'source', 'Current note must be a Markdown file inside the Vault', 'invalid_source'),
    ]);
  }

  const relativeSourcePath = toPosixPath(path.relative(physicalVaultRoot, physicalSource));
  if (isIgnoredDirectory(path.posix.dirname(relativeSourcePath), normalizedIgnoreRules(ignoreFolders))) {
    throw new VaultIndexError([
      diagnostic(relativeSourcePath, 'source', 'Current note is inside a configured ignored folder', 'ignored_source'),
    ]);
  }

  const note = await readNoteRecord({ vaultRoot: physicalVaultRoot, sourcePath: relativeSourcePath });
  return note.eligible ? note : null;
}

export async function scanPendingNotes({
  vaultRoot,
  ignoreFolders = [],
  state = { version: 1, entries: {} },
} = {}) {
  const index = await buildVaultIndex({ vaultRoot, ignoreFolders });
  const stateEntries = state?.entries && typeof state.entries === 'object' && !Array.isArray(state.entries)
    ? state.entries
    : {};

  return index.eligibleNotes.filter((note) => {
    const lastHash = stateEntries[note.publishId]?.lastPublishedSourceHash;
    if (typeof lastHash !== 'string') return true;
    return lastHash.replace(/^sha256:/iu, '').toLowerCase() !== note.sourceHash;
  });
}
