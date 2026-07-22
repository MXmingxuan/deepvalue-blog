import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { copyAssets } from './assets.mjs';
import {
  commitPublication,
  publicationCommitMessage,
  publicationFilesDigest,
  pushPublicationCommit,
} from './git.mjs';
import { renderEntry } from './render-entry.mjs';

const MANIFEST_VERSION = 1;
const PUBLISH_ID_PATTERN = /^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u;
const SOURCE_HASH_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/iu;
const transactionContexts = new WeakMap();

function transactionContext(transaction) {
  const context = transaction && typeof transaction === 'object'
    ? transactionContexts.get(transaction)
    : undefined;
  if (!context) {
    throw new PublicationTransactionError('Unknown publication transaction', {
      code: 'invalid_transaction',
    });
  }
  return context;
}

function setTransactionStatus(transaction, context, status) {
  context.status = status;
  transaction.status = status;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function createStableDirectoryGuard(directory, {
  containmentRoot,
  code,
  label,
} = {}) {
  let handle;
  try {
    const lexicalStats = await lstat(directory);
    const physicalPath = await realpath(directory);
    const physicalStats = await lstat(physicalPath);
    if (
      physicalPath !== directory
      || lexicalStats.isSymbolicLink()
      || !lexicalStats.isDirectory()
      || physicalStats.isSymbolicLink()
      || !physicalStats.isDirectory()
      || !sameFileIdentity(lexicalStats, physicalStats)
      || (containmentRoot && !isInside(containmentRoot, physicalPath))
    ) {
      throw new Error(`${label} is not a contained physical directory`);
    }
    handle = await open(
      physicalPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const openedStats = await handle.stat();
    if (!openedStats.isDirectory() || !sameFileIdentity(openedStats, physicalStats)) {
      throw new Error(`${label} identity changed while opening`);
    }

    let closed = false;
    return {
      path: physicalPath,
      async assertStable() {
        if (closed) throw new Error(`${label} guard is closed`);
        try {
          const [resolvedNow, pathStats, handleStats] = await Promise.all([
            realpath(physicalPath),
            lstat(physicalPath),
            handle.stat(),
          ]);
          if (
            resolvedNow !== physicalPath
            || pathStats.isSymbolicLink()
            || !pathStats.isDirectory()
            || !sameFileIdentity(openedStats, pathStats)
            || !sameFileIdentity(openedStats, handleStats)
          ) {
            throw new Error(`${label} identity changed`);
          }
          return physicalPath;
        } catch (error) {
          throw new PublicationTransactionError(`${label} changed during publication`, {
            code,
            cause: error,
          });
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        await handle.close();
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error instanceof PublicationTransactionError) throw error;
    throw new PublicationTransactionError(`${label} could not be bound safely`, {
      code,
      cause: error,
    });
  }
}

async function assertTransactionRoot(context) {
  let resolved;
  let details;
  try {
    [resolved, details] = await Promise.all([
      realpath(context.root),
      lstat(context.root),
    ]);
  } catch (error) {
    throw new PublicationTransactionError('Transaction root no longer exists safely', {
      code: 'staging_changed',
      cause: error,
    });
  }
  if (
    resolved !== context.root
    || details.isSymbolicLink()
    || !details.isDirectory()
    || !sameFileIdentity(details, context.rootIdentity)
    || !isInside(context.stagingParent, context.root, { allowRoot: false })
    || context.root === context.repoRoot
  ) {
    throw new PublicationTransactionError('Transaction root identity changed', {
      code: 'staging_changed',
    });
  }
}

async function removeTransactionRoot(context) {
  await assertTransactionRoot(context);
  const rootGuard = await createStableDirectoryGuard(context.root, {
    containmentRoot: context.stagingParent,
    code: 'staging_changed',
    label: 'Transaction root',
  });
  const cleanupPath = path.join(
    context.stagingParent,
    `.publication-cleanup-${randomUUID()}`,
  );
  try {
    await rootGuard.assertStable();
    await rename(context.root, cleanupPath);
    const [resolved, details] = await Promise.all([
      realpath(cleanupPath),
      lstat(cleanupPath),
    ]);
    // The old pathname is expected to disappear after rename, so the guard's
    // pathname assertion cannot remain valid. Verify the moved inode directly
    // against the immutable identity captured when the transaction was created.
    if (
      resolved !== cleanupPath
      || details.isSymbolicLink()
      || !details.isDirectory()
      || !sameFileIdentity(details, context.rootIdentity)
      || !isInside(context.stagingParent, cleanupPath, { allowRoot: false })
    ) {
      throw new PublicationTransactionError('Transaction root changed before cleanup', {
        code: 'staging_changed',
      });
    }
    await rm(cleanupPath, { recursive: true, force: true });
  } finally {
    await rootGuard.close().catch(() => {});
  }
}

async function physicalDirectory(candidate, label) {
  const resolved = await realpath(candidate);
  const details = await stat(resolved);
  if (!details.isDirectory()) throw new TypeError(`${label} must be a directory`);
  return resolved;
}

async function physicalDirectoryAllowCreate(candidate, {
  containmentRoot,
  label,
} = {}) {
  try {
    return await physicalDirectory(candidate, label);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const resolvedCandidate = await realpathAllowMissing(candidate);
  if (!isInside(containmentRoot, resolvedCandidate, { allowRoot: false })) {
    throw new TypeError(`${label} must stay inside the repository`);
  }
  const parent = path.dirname(resolvedCandidate);
  const guard = await createStableDirectoryGuard(parent, {
    containmentRoot,
    code: 'target_changed',
    label: `${label} parent`,
  });
  try {
    await guard.assertStable();
    await mkdir(resolvedCandidate, { mode: 0o700 });
    await guard.assertStable();
    const [resolved, details] = await Promise.all([
      realpath(resolvedCandidate),
      lstat(resolvedCandidate),
    ]);
    if (
      resolved !== resolvedCandidate
      || details.isSymbolicLink()
      || !details.isDirectory()
      || !isInside(containmentRoot, resolved, { allowRoot: false })
    ) {
      throw new TypeError(`${label} must be a physical directory inside the repository`);
    }
    return resolved;
  } finally {
    await guard.close().catch(() => {});
  }
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

function safeRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || value === ''
    || value.includes('\0')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) {
    throw new PublicationTransactionError(`${label} is not a safe relative path`, {
      code: 'invalid_manifest',
    });
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new PublicationTransactionError(`${label} escapes its allowed root`, {
      code: 'invalid_manifest',
    });
  }
  return normalized;
}

function publicationSourceMetadata(note) {
  let sourcePath;
  try {
    sourcePath = safeRelativePath(note?.sourcePath, 'Publication source path');
  } catch (error) {
    throw new PublicationTransactionError('Publication source path must be Vault-relative and safe', {
      code: 'invalid_publication_metadata',
      cause: error,
    });
  }
  if (typeof note?.sourceHash !== 'string' || !SOURCE_HASH_PATTERN.test(note.sourceHash)) {
    throw new PublicationTransactionError('Publication source hash must be a SHA-256 digest', {
      code: 'invalid_publication_metadata',
    });
  }
  return { sourcePath, sourceHash: note.sourceHash };
}

async function loadManifest(transaction) {
  const context = transactionContext(transaction);
  await assertTransactionRoot(context);
  let manifest;
  try {
    const details = await lstat(context.manifestPath);
    const resolved = await realpath(context.manifestPath);
    if (
      details.isSymbolicLink()
      || !details.isFile()
      || !isInside(context.root, resolved, { allowRoot: false })
    ) {
      throw new Error('manifest is not a contained regular file');
    }
    const bytes = await readFile(context.manifestPath);
    if (sha256(bytes) !== context.manifestHash) {
      throw new PublicationTransactionError('Transaction manifest changed after creation', {
        code: 'manifest_changed',
      });
    }
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof PublicationTransactionError) throw error;
    throw new PublicationTransactionError('Transaction manifest could not be read', {
      code: 'invalid_manifest',
      cause: error,
    });
  }
  if (
    manifest?.version !== MANIFEST_VERSION
    || manifest.transactionId !== context.id
    || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.publications)
  ) {
    throw new PublicationTransactionError('Transaction manifest is invalid', {
      code: 'invalid_manifest',
    });
  }
  return manifest;
}

async function verifiedStagedFile(transaction, file) {
  const context = transactionContext(transaction);
  const targetPath = safeRelativePath(file?.targetPath, 'Manifest target path');
  if (typeof file?.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
    throw new PublicationTransactionError(`Manifest hash is invalid for ${targetPath}`, {
      code: 'invalid_manifest',
    });
  }
  if (file.operation === 'delete') {
    if (Object.hasOwn(file, 'stagedPath')) {
      throw new PublicationTransactionError(`Delete operation must not have staged bytes: ${targetPath}`, {
        code: 'invalid_manifest',
      });
    }
    return { operation: 'delete', targetPath };
  }
  if (file.operation !== undefined && file.operation !== 'write') {
    throw new PublicationTransactionError(`Manifest operation is invalid for ${targetPath}`, {
      code: 'invalid_manifest',
    });
  }
  const stagedPath = safeRelativePath(file?.stagedPath, 'Manifest staged path');
  if (stagedPath !== path.posix.join('files', targetPath)) {
    throw new PublicationTransactionError(`Staged path does not match target: ${targetPath}`, {
      code: 'invalid_manifest',
    });
  }
  const absolutePath = path.join(context.root, ...stagedPath.split('/'));
  let handle;
  try {
    const resolved = await realpath(absolutePath);
    if (!isInside(context.filesRoot, resolved, { allowRoot: false })) {
      throw new Error('staged path resolves outside files root');
    }
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat();
    const currentStats = await stat(absolutePath);
    if (!openedStats.isFile() || !sameFileIdentity(openedStats, currentStats)) {
      throw new Error('staged file identity changed');
    }
    const bytes = await handle.readFile();
    const afterReadStats = await stat(absolutePath);
    if (!sameFileIdentity(openedStats, afterReadStats) || sha256(bytes) !== file.sha256) {
      throw new Error('staged file bytes or identity changed');
    }
    return { bytes, operation: 'write', stagedPath, targetPath };
  } catch (error) {
    throw new PublicationTransactionError(`Staged file changed or escaped: ${targetPath}`, {
      code: 'staging_changed',
      cause: error,
    });
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function runNpmBuild({ cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`npm run build exited with ${code ?? signal}`), {
        code,
        signal,
        stdout,
        stderr,
      }));
    });
  });
}

function runGit(repoRoot, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function repositoryBaseline(repoRoot) {
  const [head, statusResult] = await Promise.all([
    runGit(repoRoot, ['rev-parse', 'HEAD']),
    runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  if (head.code !== 0 || statusResult.code !== 0) {
    throw new PublicationTransactionError('Could not capture the repository preview baseline', {
      code: 'git_inspection_failed',
      details: { stderr: `${head.stderr}\n${statusResult.stderr}`.trim() },
    });
  }
  const headSha = head.stdout.toString('utf8').trim();
  return {
    headSha,
    fingerprint: sha256(Buffer.concat([head.stdout, Buffer.from([0]), statusResult.stdout])),
  };
}

function isOwnedTarget(state, file) {
  const previous = state?.entries?.[file.publishId];
  if (!previous || typeof previous !== 'object') return false;
  if (file.kind === 'entry') return previous.emittedMarkdownPath === file.targetPath;
  return Array.isArray(previous.emittedAssetPaths)
    && previous.emittedAssetPaths.includes(file.targetPath);
}

async function indexRecord(repoRoot, targetPath) {
  const result = await runGit(repoRoot, ['ls-files', '--stage', '-z', '--', targetPath]);
  if (result.code !== 0) {
    throw new PublicationTransactionError('Could not inspect the Git index', {
      code: 'git_inspection_failed',
      details: { stderr: result.stderr },
    });
  }
  if (result.stdout.length === 0) return undefined;
  const record = result.stdout.toString('utf8').split('\0').find(Boolean);
  const match = record?.match(/^(\d+) ([a-f0-9]+) (\d+)\t([\s\S]+)$/u);
  if (!match || match[4] !== targetPath || match[3] !== '0') {
    throw new PublicationTransactionError(`Git index entry is not safe to replace: ${targetPath}`, {
      code: 'target_conflict',
    });
  }
  return { mode: match[1], objectId: match[2] };
}

async function lastPublisherBytes(repoRoot, targetPath) {
  const history = await runGit(repoRoot, ['log', '--format=%H', '--', targetPath]);
  if (history.code !== 0) {
    throw new PublicationTransactionError('Could not inspect publication history', {
      code: 'git_inspection_failed',
      details: { stderr: history.stderr },
    });
  }
  for (const commitSha of history.stdout.toString('utf8').split('\n').filter(Boolean)) {
    const [message, changed] = await Promise.all([
      runGit(repoRoot, ['show', '-s', '--format=%B', commitSha]),
      runGit(repoRoot, [
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-only',
        '-r',
        '-z',
        commitSha,
      ]),
    ]);
    if (message.code !== 0 || changed.code !== 0) continue;
    const marker = message.stdout.toString('utf8')
      .match(/^Publisher-Manifest-SHA256: ([a-f0-9]{64})$/mu)?.[1];
    if (!marker) continue;

    const changedPaths = changed.stdout.toString('utf8').split('\0').filter(Boolean).sort();
    const files = [];
    let requestedBytes;
    let valid = changedPaths.length > 0;
    for (const changedPath of changedPaths) {
      const tree = await runGit(repoRoot, ['ls-tree', '-z', commitSha, '--', changedPath]);
      const record = tree.stdout.toString('utf8').split('\0').find(Boolean);
      const match = record?.match(/^\d+ blob ([a-f0-9]+)\t([\s\S]+)$/u);
      if (tree.code !== 0) {
        valid = false;
        break;
      }
      if (!match) {
        const previousBlob = await runGit(repoRoot, ['show', `${commitSha}^:${changedPath}`]);
        if (previousBlob.code !== 0) {
          valid = false;
          break;
        }
        files.push({
          operation: 'delete',
          targetPath: changedPath,
          sha256: sha256(previousBlob.stdout),
        });
      } else {
        if (match[2] !== changedPath) {
          valid = false;
          break;
        }
        const blob = await runGit(repoRoot, ['cat-file', 'blob', match[1]]);
        if (blob.code !== 0) {
          valid = false;
          break;
        }
        files.push({ targetPath: changedPath, sha256: sha256(blob.stdout) });
        if (changedPath === targetPath) requestedBytes = blob.stdout;
      }
    }
    if (valid && requestedBytes && publicationFilesDigest(files) === marker) {
      return requestedBytes;
    }
  }
  return undefined;
}

async function targetConflict(transaction, state, file, guard) {
  const context = transactionContext(transaction);
  const targetPath = safeRelativePath(file.targetPath, 'Manifest target path');
  const destination = path.join(context.repoRoot, ...targetPath.split('/'));
  const physicalDestination = await realpathAllowMissing(destination);
  if (!isInside(context.repoRoot, physicalDestination, { allowRoot: false })) {
    return { reason: 'target resolves outside the repository' };
  }

  let current;
  try {
    current = await stableFileIfPresent(destination, guard, 'Publication conflict target');
  } catch (error) {
    if (error instanceof PublicationTransactionError) throw error;
    throw new PublicationTransactionError(`Target could not be bound safely: ${targetPath}`, {
      code: 'target_changed',
      cause: error,
    });
  }
  const tracked = await indexRecord(context.repoRoot, targetPath);
  if (!current) {
    return tracked
      ? { reason: 'tracked target is missing' }
      : { approval: { existed: false } };
  }
  if (!isOwnedTarget(state, file)) return { reason: 'existing target is not recorded in publisher state' };
  if (!tracked) return { reason: 'recorded target is untracked' };

  const [worktreeDiff, indexDiff, publishedBytes] = await Promise.all([
    runGit(context.repoRoot, ['diff', '--quiet', '--', targetPath]),
    runGit(context.repoRoot, ['diff', '--cached', '--quiet', '--', targetPath]),
    lastPublisherBytes(context.repoRoot, targetPath),
  ]);
  if (worktreeDiff.code !== 0) return { reason: 'working-tree bytes differ from the last committed publication' };
  if (indexDiff.code !== 0) return { reason: 'Git index contains an overlapping staged change' };
  if (!publishedBytes) return { reason: 'last publisher output could not be established' };
  const currentHash = sha256(current.bytes);
  if (currentHash !== sha256(publishedBytes)) {
    return { reason: 'current hash differs from the last publisher output' };
  }
  return {
    approval: {
      existed: true,
      hash: currentHash,
      identity: current.identity,
    },
  };
}

function assertAllowedTarget(transaction, file) {
  const context = transactionContext(transaction);
  const targetPath = safeRelativePath(file.targetPath, 'Manifest target path');
  const allowedRoot = file.kind === 'entry'
    ? toPosixPath(path.relative(context.repoRoot, context.entryOutputDir))
    : file.kind === 'asset'
      ? toPosixPath(path.relative(context.repoRoot, context.mediaOutputDir))
      : undefined;
  if (!allowedRoot || (targetPath !== allowedRoot && !targetPath.startsWith(`${allowedRoot}/`))) {
    throw new PublicationTransactionError(`Manifest target is outside its configured output: ${targetPath}`, {
      code: 'invalid_manifest',
    });
  }
  return targetPath;
}

async function stableReadFile(destination, guard, label) {
  await guard.assertStable();
  let handle;
  try {
    const resolved = await realpath(destination);
    if (resolved !== destination || path.dirname(destination) !== guard.path) {
      throw new Error(`${label} is not a physical child of its bound parent`);
    }
    handle = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat();
    const pathStats = await lstat(destination);
    if (
      !openedStats.isFile()
      || pathStats.isSymbolicLink()
      || !sameFileIdentity(openedStats, pathStats)
    ) {
      throw new Error(`${label} identity changed while opening`);
    }
    const bytes = await handle.readFile();
    await guard.assertStable();
    const finalStats = await lstat(destination);
    if (finalStats.isSymbolicLink() || !sameFileIdentity(openedStats, finalStats)) {
      throw new Error(`${label} identity changed while reading`);
    }
    return {
      bytes,
      mode: openedStats.mode & 0o777,
      identity: { dev: openedStats.dev, ino: openedStats.ino },
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function stableFileIfPresent(destination, guard, label) {
  await guard.assertStable();
  try {
    const details = await lstat(destination);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new PublicationTransactionError(`${label} is not a regular file`, {
        code: 'target_changed',
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await guard.assertStable();
    return undefined;
  }
  return stableReadFile(destination, guard, label);
}

async function restoreQuarantinedPath(quarantinePath, destination, guard) {
  await guard.assertStable();
  await link(quarantinePath, destination);
  await guard.assertStable();
  await rm(quarantinePath, { force: true });
}

async function atomicWrite(destination, bytes, mode, guard, snapshot) {
  if (path.dirname(destination) !== guard.path) {
    throw new PublicationTransactionError('Publication target parent does not match its guard', {
      code: 'target_changed',
    });
  }
  await guard.assertStable();
  const tempPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.publish-${process.pid}-${randomUUID()}`,
  );
  let handle;
  let openedStats;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    openedStats = await handle.stat();
    const pathStats = await lstat(tempPath);
    if (!openedStats.isFile() || !sameFileIdentity(openedStats, pathStats)) {
      throw new Error('Temporary publication target identity changed while opening');
    }
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
    await guard.assertStable();
    const writtenStats = await lstat(tempPath);
    if (writtenStats.isSymbolicLink() || !sameFileIdentity(openedStats, writtenStats)) {
      throw new Error('Temporary publication target identity changed while writing');
    }
    await handle.close();
    handle = undefined;
    await guard.assertStable();

    if (snapshot.existed) {
      const quarantinePath = path.join(
        guard.path,
        `.${path.basename(destination)}.previous-${randomUUID()}`,
      );
      await rename(destination, quarantinePath);
      snapshot.quarantinePath = quarantinePath;
      const quarantined = await stableReadFile(
        quarantinePath,
        guard,
        'Quarantined publication target',
      );
      if (
        !sameFileIdentity(quarantined.identity, snapshot.originalIdentity)
        || sha256(quarantined.bytes) !== snapshot.backupHash
      ) {
        try {
          await restoreQuarantinedPath(quarantinePath, destination, guard);
          snapshot.quarantinePath = undefined;
        } catch {
          // Preserve the displaced file in quarantine rather than overwrite a concurrent target.
        }
        throw new PublicationTransactionError('Publication target changed before replacement', {
          code: 'target_changed',
        });
      }
    }

    snapshot.appliedIdentity = { dev: openedStats.dev, ino: openedStats.ino };
    await link(tempPath, destination);
    await guard.assertStable();
    const destinationStats = await lstat(destination);
    if (destinationStats.isSymbolicLink() || !sameFileIdentity(openedStats, destinationStats)) {
      throw new Error('Publication target identity changed during replacement');
    }
    await rm(tempPath, { force: true });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    try {
      await guard.assertStable();
      await rm(tempPath, { force: true });
    } catch {
      // Never follow a replaced parent merely to clean up a failed write.
    }
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') {
      throw new PublicationTransactionError('Publication target changed during atomic replacement', {
        code: 'target_changed',
        cause: error,
      });
    }
    throw error;
  }
}

async function atomicDelete(destination, guard, snapshot) {
  if (!snapshot.existed) {
    throw new PublicationTransactionError('A delete target was not present at approval', {
      code: 'target_changed',
    });
  }
  const quarantinePath = path.join(
    guard.path,
    `.${path.basename(destination)}.previous-${randomUUID()}`,
  );
  await guard.assertStable();
  await rename(destination, quarantinePath);
  snapshot.quarantinePath = quarantinePath;
  try {
    const quarantined = await stableReadFile(
      quarantinePath,
      guard,
      'Quarantined publication deletion target',
    );
    if (
      !sameFileIdentity(quarantined.identity, snapshot.originalIdentity)
      || sha256(quarantined.bytes) !== snapshot.backupHash
    ) {
      throw new PublicationTransactionError('Publication deletion target changed before removal', {
        code: 'target_changed',
      });
    }
  } catch (error) {
    try {
      await restoreQuarantinedPath(quarantinePath, destination, guard);
      snapshot.quarantinePath = undefined;
    } catch {
      // Keep the approved bytes quarantined if a concurrent path now blocks restoration.
    }
    throw error;
  }
}

async function bindMutationDirectories(transaction, files) {
  const context = transactionContext(transaction);
  const outputGuards = new Map();
  const parentGuards = new Map();
  try {
    for (const outputRoot of new Set([context.entryOutputDir, context.mediaOutputDir])) {
      outputGuards.set(outputRoot, await createStableDirectoryGuard(outputRoot, {
        containmentRoot: context.repoRoot,
        code: 'target_changed',
        label: 'Publication output directory',
      }));
    }

    for (const file of files) {
      const targetPath = assertAllowedTarget(transaction, file);
      const outputRoot = file.kind === 'entry' ? context.entryOutputDir : context.mediaOutputDir;
      const outputGuard = outputGuards.get(outputRoot);
      const destination = path.join(context.repoRoot, ...targetPath.split('/'));
      const parent = path.dirname(destination);
      if (parentGuards.has(parent)) continue;

      await outputGuard.assertStable();
      const physicalParent = await realpathAllowMissing(parent);
      if (!isInside(outputRoot, physicalParent)) {
        throw new PublicationTransactionError(`Publication parent escapes its output root: ${targetPath}`, {
          code: 'target_changed',
        });
      }
      const firstCreated = await mkdir(parent, { recursive: true, mode: 0o700 });
      await outputGuard.assertStable();
      const guard = await createStableDirectoryGuard(parent, {
        containmentRoot: outputRoot,
        code: 'target_changed',
        label: 'Publication target parent',
      });
      parentGuards.set(parent, { guard, created: firstCreated !== undefined });
    }
    return { outputGuards, parentGuards };
  } catch (error) {
    for (const { guard, created } of [...parentGuards.values()].reverse()) {
      if (!created) continue;
      try {
        await guard.assertStable();
        await rmdir(guard.path);
      } catch {
        // Preserve anything that appeared concurrently; this path has no publication files yet.
      }
    }
    for (const { guard } of parentGuards.values()) await guard.close().catch(() => {});
    for (const guard of outputGuards.values()) await guard.close().catch(() => {});
    throw error;
  }
}

async function closeMutationGuards(context) {
  const guards = context.mutationGuards;
  if (!guards) return;
  context.mutationGuards = undefined;
  for (const { guard } of guards.parentGuards.values()) await guard.close().catch(() => {});
  for (const guard of guards.outputGuards.values()) await guard.close().catch(() => {});
}

async function assertMutationGuardsStable(context) {
  const guards = context.mutationGuards;
  if (!guards) {
    throw new PublicationTransactionError('Publication mutation guards are unavailable', {
      code: 'target_changed',
    });
  }
  for (const guard of guards.outputGuards.values()) await guard.assertStable();
  for (const { guard } of guards.parentGuards.values()) await guard.assertStable();
}

async function removeCreatedTargetParents(context) {
  const records = [...(context.mutationGuards?.parentGuards.values() ?? [])]
    .filter(({ created }) => created)
    .sort((left, right) => right.guard.path.length - left.guard.path.length);
  for (const { guard } of records) {
    await guard.assertStable();
    try {
      await rmdir(guard.path);
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST' && error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function restoreSnapshots(transaction) {
  const context = transactionContext(transaction);
  await assertTransactionRoot(context);
  if (!context.mutationGuards) {
    throw new PublicationTransactionError('Publication mutation guards are unavailable', {
      code: 'rollback_failed',
    });
  }
  const snapshots = context.snapshots ?? [];
  for (const snapshot of [...snapshots].reverse()) {
    if (!snapshot.applied) continue;
    const parentRecord = context.mutationGuards.parentGuards.get(path.dirname(snapshot.destination));
    if (!parentRecord) {
      throw new PublicationTransactionError('Publication target parent guard is unavailable', {
        code: 'rollback_failed',
      });
    }
    const current = await stableFileIfPresent(
      snapshot.destination,
      parentRecord.guard,
      'Applied publication target',
    );
    const currentHash = current ? sha256(current.bytes) : undefined;
    if (snapshot.existed && !snapshot.quarantinePath && currentHash === snapshot.backupHash) {
      continue;
    }
    if (!snapshot.existed && !current) continue;
    if (
      current
      && (
        currentHash !== snapshot.appliedHash
        || (
          snapshot.appliedIdentity
          && !sameFileIdentity(current.identity, snapshot.appliedIdentity)
        )
      )
    ) {
      throw new PublicationTransactionError('Applied publication target changed before rollback', {
        code: 'target_changed',
      });
    }

    let appliedQuarantinePath;
    if (current) {
      appliedQuarantinePath = path.join(
        parentRecord.guard.path,
        `.${path.basename(snapshot.destination)}.rollback-${randomUUID()}`,
      );
      await parentRecord.guard.assertStable();
      await rename(snapshot.destination, appliedQuarantinePath);
      const moved = await stableReadFile(
        appliedQuarantinePath,
        parentRecord.guard,
        'Quarantined applied publication target',
      );
      if (
        sha256(moved.bytes) !== snapshot.appliedHash
        || !sameFileIdentity(moved.identity, current.identity)
      ) {
        try {
          await restoreQuarantinedPath(
            appliedQuarantinePath,
            snapshot.destination,
            parentRecord.guard,
          );
        } catch {
          // Preserve the moved file if a concurrent target now occupies its original name.
        }
        throw new PublicationTransactionError('Publication target changed during rollback', {
          code: 'target_changed',
        });
      }
    }

    if (snapshot.existed) {
      if (!snapshot.quarantinePath) {
        throw new PublicationTransactionError('Original publication target quarantine is missing', {
          code: 'rollback_failed',
        });
      }
      const original = await stableReadFile(
        snapshot.quarantinePath,
        parentRecord.guard,
        'Quarantined original publication target',
      );
      if (
        sha256(original.bytes) !== snapshot.backupHash
        || !sameFileIdentity(original.identity, snapshot.originalIdentity)
      ) {
        throw new PublicationTransactionError('Original publication target quarantine changed', {
          code: 'target_changed',
        });
      }
      await restoreQuarantinedPath(
        snapshot.quarantinePath,
        snapshot.destination,
        parentRecord.guard,
      );
      snapshot.quarantinePath = undefined;
    }
    if (appliedQuarantinePath) await rm(appliedQuarantinePath, { force: true });
  }
  await removeCreatedTargetParents(context);
}

async function assertSnapshotStillApproved(snapshot, guard) {
  let current;
  try {
    current = await stableFileIfPresent(
      snapshot.destination,
      guard,
      'Approved publication target',
    );
  } catch (error) {
    if (error instanceof PublicationTransactionError) throw error;
    throw new PublicationTransactionError('Publication target changed while validating approval', {
      code: 'target_changed',
      cause: error,
    });
  }
  if (!snapshot.existed) {
    if (current) {
      throw new PublicationTransactionError('A publication target appeared after approval', {
        code: 'target_changed',
      });
    }
    return;
  }
  if (
    !current
    || sha256(current.bytes) !== snapshot.backupHash
    || !sameFileIdentity(current.identity, snapshot.originalIdentity)
  ) {
    throw new PublicationTransactionError('Publication target identity or bytes changed after approval', {
      code: 'target_changed',
    });
  }
}

async function finalizeSnapshots(context) {
  for (const snapshot of context.snapshots ?? []) {
    if (!snapshot.quarantinePath) continue;
    const parentRecord = context.mutationGuards?.parentGuards.get(
      path.dirname(snapshot.destination),
    );
    if (!parentRecord) throw new Error('Publication target parent guard is unavailable');
    const original = await stableReadFile(
      snapshot.quarantinePath,
      parentRecord.guard,
      'Quarantined original publication target',
    );
    if (
      sha256(original.bytes) !== snapshot.backupHash
      || !sameFileIdentity(original.identity, snapshot.originalIdentity)
    ) {
      throw new PublicationTransactionError('Original publication target quarantine changed', {
        code: 'target_changed',
      });
    }
    await rm(snapshot.quarantinePath, { force: true });
    snapshot.quarantinePath = undefined;
  }
}

function recordCleanupWarning(transaction, context, message) {
  context.cleanupWarning = context.cleanupWarning
    ? `${context.cleanupWarning}; ${message}`
    : message;
  transaction.cleanupWarning = context.cleanupWarning;
}

async function releaseCommittedArtifacts(transaction, context) {
  try {
    await finalizeSnapshots(context);
  } catch (error) {
    recordCleanupWarning(
      transaction,
      context,
      `Committed output quarantine cleanup failed: ${error.message}`,
    );
  }
  await closeMutationGuards(context);
}

async function cleanupTerminalTransaction(transaction, context) {
  try {
    await removeTransactionRoot(context);
  } catch (error) {
    recordCleanupWarning(
      transaction,
      context,
      `Temporary transaction cleanup failed: ${error.message}`,
    );
  }
}

function repoRelativePath(repoRoot, candidate, label) {
  if (!isInside(repoRoot, candidate, { allowRoot: false })) {
    throw new TypeError(`${label} must stay inside the repository`);
  }
  return toPosixPath(path.relative(repoRoot, candidate));
}

export class PublicationTransactionError extends Error {
  constructor(message, { code = 'transaction_failed', details, cause } = {}) {
    super(message, { cause });
    this.name = 'PublicationTransactionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export async function createPublicationTransaction({
  repoRoot,
  entryOutputDir,
  mediaOutputDir,
  vaultRoot,
  notes = [],
  state = { version: 1, entries: {} },
  confirmedAt = new Date(),
  stagingParent = os.tmpdir(),
} = {}) {
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new TypeError('At least one transformed publication note is required');
  }

  const physicalRepoRoot = await physicalDirectory(repoRoot, 'Repository root');
  const physicalEntryOutputDir = await physicalDirectory(entryOutputDir, 'Entry output directory');
  const physicalVaultRoot = await physicalDirectory(vaultRoot, 'Vault root');
  const physicalStagingParent = await physicalDirectory(stagingParent, 'Staging parent');
  if (
    isInside(physicalRepoRoot, physicalStagingParent)
    || isInside(physicalStagingParent, physicalRepoRoot)
    || isInside(physicalVaultRoot, physicalStagingParent)
    || isInside(physicalStagingParent, physicalVaultRoot)
  ) {
    throw new TypeError('Staging parent must be outside the repository and Vault without overlap');
  }
  const physicalMediaOutputDir = await physicalDirectoryAllowCreate(mediaOutputDir, {
    containmentRoot: physicalRepoRoot,
    label: 'Media output directory',
  });
  const entryOutputPath = repoRelativePath(
    physicalRepoRoot,
    physicalEntryOutputDir,
    'Entry output directory',
  );
  const mediaOutputPath = repoRelativePath(
    physicalRepoRoot,
    physicalMediaOutputDir,
    'Media output directory',
  );
  const transactionRoot = await mkdtemp(path.join(physicalStagingParent, 'publication-'));
  const filesRoot = path.join(transactionRoot, 'files');
  const transactionId = randomUUID();
  const files = [];
  const publications = [];
  const targetPaths = new Set();

  function addFile(file) {
    if (targetPaths.has(file.targetPath)) {
      throw new PublicationTransactionError(`Duplicate transaction target: ${file.targetPath}`, {
        code: 'duplicate_target',
      });
    }
    targetPaths.add(file.targetPath);
    files.push(file);
  }

  try {
    await mkdir(filesRoot, { recursive: true, mode: 0o700 });
    for (const note of notes) {
      if (!PUBLISH_ID_PATTERN.test(note?.publishId ?? '')) {
        throw new TypeError('Every transformed note must have a valid publishId');
      }
      const sourceMetadata = publicationSourceMetadata(note);
      const previousState = state?.entries?.[note.publishId];
      const rendered = renderEntry({ note, previousState, confirmedAt });
      const entryTargetPath = path.posix.join(entryOutputPath, `${note.publishId}.md`);
      const entryStagedPath = path.posix.join('files', entryTargetPath);
      const entryBytes = Buffer.from(rendered.markdown, 'utf8');
      const absoluteEntryStagedPath = path.join(transactionRoot, ...entryStagedPath.split('/'));
      await mkdir(path.dirname(absoluteEntryStagedPath), { recursive: true, mode: 0o700 });
      await writeFile(absoluteEntryStagedPath, entryBytes, { flag: 'wx', mode: 0o600 });
      addFile({
        kind: 'entry',
        publishId: note.publishId,
        targetPath: entryTargetPath,
        stagedPath: entryStagedPath,
        sha256: sha256(entryBytes),
      });

      const assetTargetDir = path.posix.join(mediaOutputPath, note.publishId);
      const assetStagingDir = path.join(filesRoot, ...assetTargetDir.split('/'));
      const copiedAssets = note.assets?.length > 0
        ? await copyAssets({ assets: note.assets, stagingDir: assetStagingDir, vaultRoot })
        : [];
      const assetTargets = [];
      for (const asset of copiedAssets) {
        const targetPath = path.posix.join(assetTargetDir, asset.outputName);
        const stagedPath = path.posix.join('files', targetPath);
        const stagedBytes = await readFile(path.join(transactionRoot, ...stagedPath.split('/')));
        addFile({
          kind: 'asset',
          publishId: note.publishId,
          targetPath,
          stagedPath,
          sha256: sha256(stagedBytes),
        });
        assetTargets.push(targetPath);
      }

      for (const previousAssetPath of previousState?.emittedAssetPaths ?? []) {
        const targetPath = safeRelativePath(previousAssetPath, 'Previously emitted asset path');
        if (assetTargets.includes(targetPath)) continue;
        if (!targetPath.startsWith(`${assetTargetDir}/`)) {
          throw new PublicationTransactionError(
            `Previously emitted asset is outside its publication directory: ${targetPath}`,
            { code: 'invalid_publication_metadata' },
          );
        }
        const publishedBytes = await lastPublisherBytes(physicalRepoRoot, targetPath);
        if (!publishedBytes) {
          throw new PublicationTransactionError(
            `Could not establish the last publisher bytes for obsolete asset: ${targetPath}`,
            { code: 'target_conflict' },
          );
        }
        addFile({
          kind: 'asset',
          operation: 'delete',
          publishId: note.publishId,
          targetPath,
          sha256: sha256(publishedBytes),
        });
      }

      publications.push({
        publishId: note.publishId,
        title: rendered.title,
        sourcePath: sourceMetadata.sourcePath,
        sourceHash: sourceMetadata.sourceHash,
        publishedAt: rendered.publishedAt,
        ...(rendered.updatedAt ? { updatedAt: rendered.updatedAt } : {}),
        entryTargetPath,
        assetTargetPaths: assetTargets,
      });
    }

    const manifest = {
      version: MANIFEST_VERSION,
      transactionId,
      files,
      publications,
    };
    const manifestPath = path.join(transactionRoot, 'manifest.json');
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await writeFile(manifestPath, manifestBytes, {
      flag: 'wx',
      mode: 0o600,
    });
    const rootIdentity = await lstat(transactionRoot);
    const transaction = {
      id: transactionId,
      root: transactionRoot,
      manifestPath,
      manifest,
      repoRoot: physicalRepoRoot,
      entryOutputDir: physicalEntryOutputDir,
      mediaOutputDir: physicalMediaOutputDir,
      status: 'staged',
    };
    transactionContexts.set(transaction, {
      id: transactionId,
      root: transactionRoot,
      rootIdentity,
      stagingParent: physicalStagingParent,
      filesRoot,
      manifestPath,
      manifestHash: sha256(manifestBytes),
      repoRoot: physicalRepoRoot,
      entryOutputDir: physicalEntryOutputDir,
      mediaOutputDir: physicalMediaOutputDir,
      status: 'staged',
    });
    return transaction;
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeCandidateFile(candidateRoot, targetPath, bytes) {
  const destination = path.join(candidateRoot, ...targetPath.split('/'));
  const physicalDestination = await realpathAllowMissing(destination);
  if (!isInside(candidateRoot, physicalDestination, { allowRoot: false })) {
    throw new PublicationTransactionError(`Candidate target escapes through a symlink: ${targetPath}`, {
      code: 'unsafe_preview_target',
    });
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    const details = await lstat(destination);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new PublicationTransactionError(`Candidate target is not a regular file: ${targetPath}`, {
        code: 'unsafe_preview_target',
      });
    }
  } catch (error) {
    if (error instanceof PublicationTransactionError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(destination, bytes, { mode: 0o600 });
}

async function createExactCandidate(context, {
  directoryName,
  headSha,
  files,
} = {}) {
  const candidateRoot = path.join(context.root, directoryName);
  const candidateIndex = path.join(context.root, `.${directoryName}-index-${randomUUID()}`);
  await mkdir(candidateRoot, { mode: 0o700 });
  const env = { GIT_INDEX_FILE: candidateIndex };
  try {
    const readTree = await runGit(context.repoRoot, ['read-tree', headSha], { env });
    if (readTree.code !== 0) {
      throw new PublicationTransactionError('Could not initialize the exact candidate tree', {
        code: 'git_inspection_failed',
        details: { stderr: readTree.stderr },
      });
    }
    const checkout = await runGit(context.repoRoot, [
      'checkout-index',
      '--all',
      '--force',
      `--prefix=${candidateRoot}${path.sep}`,
    ], { env });
    if (checkout.code !== 0) {
      throw new PublicationTransactionError('Could not check out the exact candidate tree', {
        code: 'git_inspection_failed',
        details: { stderr: checkout.stderr },
      });
    }
  } finally {
    await rm(candidateIndex, { force: true }).catch(() => {});
  }

  const sourceNodeModules = path.join(context.repoRoot, 'node_modules');
  const candidateNodeModules = path.join(candidateRoot, 'node_modules');
  try {
    const nodeModulesStats = await lstat(sourceNodeModules);
    await lstat(candidateNodeModules);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const nodeModulesStats = await lstat(sourceNodeModules).catch(() => undefined);
      if (nodeModulesStats?.isDirectory() && !nodeModulesStats.isSymbolicLink()) {
        await symlink(sourceNodeModules, candidateNodeModules, 'dir');
      }
    } else {
      throw error;
    }
  }

  for (const { bytes, operation = 'write', targetPath } of files) {
    if (operation === 'delete') {
      await rm(path.join(candidateRoot, ...targetPath.split('/')), { force: true });
    } else {
      await writeCandidateFile(candidateRoot, targetPath, bytes);
    }
  }
  return candidateRoot;
}

export async function buildTransactionPreview(transaction, { runBuild = runNpmBuild } = {}) {
  const context = transactionContext(transaction);
  if (context.status !== 'staged') {
    throw new PublicationTransactionError('Only a staged transaction can build a preview', {
      code: 'invalid_transaction_state',
    });
  }
  if (typeof runBuild !== 'function') throw new TypeError('runBuild must be a function');

  const manifest = await loadManifest(transaction);
  const verifiedFiles = [];
  for (const file of manifest.files) {
    assertAllowedTarget(transaction, file);
    verifiedFiles.push(await verifiedStagedFile(transaction, file));
  }
  const previewRepoBaseline = await repositoryBaseline(context.repoRoot);

  try {
    const previewRoot = await createExactCandidate(context, {
      directoryName: 'preview-repo',
      headSha: previewRepoBaseline.headSha,
      files: verifiedFiles,
    });
    const buildResult = await runBuild({ cwd: previewRoot, transaction, manifest });
    context.previewRoot = previewRoot;
    context.previewBuild = buildResult;
    context.previewManifestHash = context.manifestHash;
    context.previewRepoBaseline = previewRepoBaseline.fingerprint;
    context.previewHeadSha = previewRepoBaseline.headSha;
    transaction.previewRoot = previewRoot;
    transaction.previewBuild = buildResult;
    setTransactionStatus(transaction, context, 'previewed');
    return { root: previewRoot, build: buildResult };
  } catch (error) {
    const previewRoot = path.join(context.root, 'preview-repo');
    context.previewRoot = previewRoot;
    transaction.previewRoot = previewRoot;
    setTransactionStatus(transaction, context, 'preview_failed');
    if (error instanceof PublicationTransactionError) throw error;
    throw new PublicationTransactionError('Preview build failed', {
      code: 'preview_build_failed',
      details: { stdout: error?.stdout ?? '', stderr: error?.stderr ?? '' },
      cause: error,
    });
  }
}

export async function applyPublicationTransaction(transaction, {
  state = { version: 1, entries: {} },
  runBuild = runNpmBuild,
} = {}) {
  const context = transactionContext(transaction);
  if (context.status !== 'previewed') {
    throw new PublicationTransactionError('Only a successfully previewed transaction can be applied', {
      code: 'invalid_transaction_state',
    });
  }
  if (typeof runBuild !== 'function') throw new TypeError('runBuild must be a function');

  const manifest = await loadManifest(transaction);
  const verifiedFiles = [];
  for (const file of manifest.files) {
    assertAllowedTarget(transaction, file);
    const verified = await verifiedStagedFile(transaction, file);
    verifiedFiles.push({ file, ...verified });
  }
  if (
    context.previewManifestHash !== context.manifestHash
  ) {
    throw new PublicationTransactionError('Manifest changed after preview; rebuild the preview', {
      code: 'repository_changed',
    });
  }

  const snapshots = [];
  context.snapshots = snapshots;
  transaction.snapshots = [];

  try {
    context.mutationGuards = await bindMutationDirectories(
      transaction,
      verifiedFiles.map(({ file }) => file),
    );
    const approvals = new Map();
    const conflicts = [];
    for (const { file, targetPath } of verifiedFiles) {
      const destination = path.join(context.repoRoot, ...targetPath.split('/'));
      const parentRecord = context.mutationGuards.parentGuards.get(path.dirname(destination));
      const assessment = await targetConflict(transaction, state, file, parentRecord.guard);
      if (assessment.reason) conflicts.push({ targetPath, reason: assessment.reason });
      else approvals.set(targetPath, assessment.approval);
    }
    if (conflicts.length > 0) {
      throw new PublicationTransactionError(
        `Publication target conflict: ${conflicts.map(({ targetPath }) => targetPath).join(', ')}`,
        { code: 'target_conflict', details: { conflicts } },
      );
    }
    if ((await repositoryBaseline(context.repoRoot)).fingerprint !== context.previewRepoBaseline) {
      throw new PublicationTransactionError('Repository changed after preview; rebuild the preview', {
        code: 'repository_changed',
      });
    }

    for (const { file, targetPath } of verifiedFiles) {
      const destination = path.join(context.repoRoot, ...targetPath.split('/'));
      const parentRecord = context.mutationGuards.parentGuards.get(path.dirname(destination));
      const original = await stableFileIfPresent(
        destination,
        parentRecord.guard,
        'Publication target',
      );
      const approval = approvals.get(targetPath);
      if (
        !approval
        || approval.existed !== Boolean(original)
        || (
          original
          && (
            approval.hash !== sha256(original.bytes)
            || !sameFileIdentity(approval.identity, original.identity)
          )
        )
      ) {
        throw new PublicationTransactionError('Publication target changed after conflict approval', {
          code: 'target_changed',
        });
      }
      if (original) {
        snapshots.push({
          destination,
          existed: true,
          backupHash: sha256(original.bytes),
          originalIdentity: original.identity,
          appliedHash: file.sha256,
          mode: original.mode,
          applied: false,
        });
      } else {
        snapshots.push({ destination, existed: false, appliedHash: file.sha256, applied: false });
      }
    }
    transaction.snapshots = snapshots.map(({ destination, existed }) => ({
      targetPath: toPosixPath(path.relative(context.repoRoot, destination)),
      existed,
    }));

    for (const [index, { bytes, operation, targetPath }] of verifiedFiles.entries()) {
      const destination = path.join(context.repoRoot, ...targetPath.split('/'));
      const parentRecord = context.mutationGuards.parentGuards.get(path.dirname(destination));
      await assertSnapshotStillApproved(snapshots[index], parentRecord.guard);
      if (operation === 'delete') {
        await atomicDelete(destination, parentRecord.guard, snapshots[index]);
      } else {
        await atomicWrite(destination, bytes, 0o600, parentRecord.guard, snapshots[index]);
      }
      snapshots[index].applied = true;
    }

    const candidateRoot = await createExactCandidate(context, {
      directoryName: 'apply-repo',
      headSha: context.previewHeadSha,
      files: verifiedFiles,
    });
    const buildResult = await runBuild({ cwd: candidateRoot, transaction, manifest });
    await assertMutationGuardsStable(context);
    context.appliedBuild = buildResult;
    transaction.appliedBuild = buildResult;
    setTransactionStatus(transaction, context, 'applied');
    return { manifest, build: buildResult };
  } catch (error) {
    const mutationOccurred = snapshots.some(({ applied }) => applied);
    if (context.mutationGuards) {
      try {
        await restoreSnapshots(transaction);
      } catch (rollbackError) {
        await closeMutationGuards(context);
        setTransactionStatus(transaction, context, 'rollback_failed');
        throw new PublicationTransactionError('Publication failed and target rollback also failed', {
          code: 'rollback_failed',
          details: { originalError: error?.message, rollbackError: rollbackError?.message },
          cause: rollbackError,
        });
      }
      await closeMutationGuards(context);
    }
    setTransactionStatus(
      transaction,
      context,
      error?.code === 'target_conflict' && !mutationOccurred ? 'previewed' : 'apply_failed',
    );
    if (error instanceof PublicationTransactionError) throw error;
    throw new PublicationTransactionError('Repository build failed; publication targets were restored', {
      code: 'build_failed',
      details: { stdout: error?.stdout ?? '', stderr: error?.stderr ?? '' },
      cause: error,
    });
  }
}

export async function rollbackPublicationTransaction(transaction) {
  const context = transactionContext(transaction);
  if (context.status !== 'applied') {
    throw new PublicationTransactionError('Only an applied transaction can be rolled back', {
      code: 'invalid_transaction_state',
    });
  }
  try {
    await restoreSnapshots(transaction);
  } catch (error) {
    await closeMutationGuards(context);
    setTransactionStatus(transaction, context, 'rollback_failed');
    throw new PublicationTransactionError('Publication rollback failed safely', {
      code: 'rollback_failed',
      cause: error,
    });
  }
  await closeMutationGuards(context);
  setTransactionStatus(transaction, context, 'rolled_back');
}

export async function confirmPublicationTransaction(transaction, {
  stateStore,
  push = false,
  remote = 'origin',
} = {}) {
  const context = transactionContext(transaction);
  if (context.status !== 'applied') {
    throw new PublicationTransactionError('Only an applied transaction can be confirmed', {
      code: 'invalid_transaction_state',
    });
  }
  if (!stateStore || typeof stateStore.updateState !== 'function') {
    throw new TypeError('A publisher state store is required');
  }
  if (typeof push !== 'boolean') throw new TypeError('push must be a boolean');

  const manifest = await loadManifest(transaction);
  let commit;
  let committedRecovery;
  try {
    commit = await commitPublication({
      repoRoot: context.repoRoot,
      manifest,
      push: false,
      expectedParentSha: context.previewHeadSha,
    });
  } catch (error) {
    if (error?.committed === true && typeof error.commitSha === 'string') {
      committedRecovery = error;
      commit = {
        commitSha: error.commitSha,
        message: error.details?.message ?? publicationCommitMessage(manifest),
        stagedPaths: error.details?.publicationPaths ?? [],
        pushed: false,
      };
    } else {
      try {
        await restoreSnapshots(transaction);
      } catch (rollbackError) {
        await closeMutationGuards(context);
        setTransactionStatus(transaction, context, 'rollback_failed');
        throw new PublicationTransactionError('Git failed and target rollback also failed', {
          code: 'rollback_failed',
          details: { originalError: error?.message, rollbackError: rollbackError?.message },
          cause: rollbackError,
        });
      }
      await closeMutationGuards(context);
      setTransactionStatus(transaction, context, 'rolled_back');
      throw error;
    }
  }
  await releaseCommittedArtifacts(transaction, context);
  context.commit = commit;
  transaction.commit = commit;
  setTransactionStatus(transaction, context, 'committed');

  try {
    context.state = await stateStore.updateState((current) => {
      const next = structuredClone(current);
      next.version = 1;
      next.entries ??= {};
      for (const publication of manifest.publications) {
        next.entries[publication.publishId] = {
          sourcePath: publication.sourcePath,
          lastPublishedSourceHash: publication.sourceHash,
          emittedMarkdownPath: publication.entryTargetPath,
          emittedAssetPaths: [...publication.assetTargetPaths],
          publishedAt: publication.publishedAt,
          ...(publication.updatedAt ? { updatedAt: publication.updatedAt } : {}),
        };
      }
      return next;
    });
    transaction.state = context.state;
  } catch (error) {
    setTransactionStatus(transaction, context, 'state_failed');
    const stateError = new PublicationTransactionError('Publication commit succeeded, but state update failed', {
      code: 'state_update_failed',
      details: { commitSha: commit.commitSha },
      cause: error,
    });
    await cleanupTerminalTransaction(transaction, context);
    throw stateError;
  }

  if (committedRecovery) {
    committedRecovery.stateUpdated = true;
    context.retry = committedRecovery.retry;
    transaction.retry = committedRecovery.retry;
    setTransactionStatus(transaction, context, 'git_recovery_required');
    await cleanupTerminalTransaction(transaction, context);
    throw committedRecovery;
  }

  if (!push) {
    setTransactionStatus(transaction, context, 'confirmed');
    await cleanupTerminalTransaction(transaction, context);
    return { ...commit, pushed: false };
  }

  try {
    const pushResult = await pushPublicationCommit({
      repoRoot: context.repoRoot,
      commitSha: commit.commitSha,
      remote,
    });
    setTransactionStatus(transaction, context, 'confirmed');
    await cleanupTerminalTransaction(transaction, context);
    return { ...commit, ...pushResult };
  } catch (error) {
    setTransactionStatus(transaction, context, 'push_failed');
    context.retry = error?.retry;
    transaction.retry = error?.retry;
    await cleanupTerminalTransaction(transaction, context);
    throw error;
  }
}

export async function cancelPublicationTransaction(transaction) {
  const context = transactionContext(transaction);
  if (!['staged', 'previewed', 'preview_failed', 'apply_failed', 'rolled_back'].includes(context.status)) {
    throw new PublicationTransactionError('This transaction can no longer be canceled', {
      code: 'invalid_transaction_state',
    });
  }
  await removeTransactionRoot(context);
  setTransactionStatus(transaction, context, 'canceled');
}
