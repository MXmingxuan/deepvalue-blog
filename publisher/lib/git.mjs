import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function safeRelativePath(value) {
  if (
    typeof value !== 'string'
    || value === ''
    || value.includes('\0')
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) return undefined;
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function runGit(repoRoot, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    if (input !== undefined) child.stdin.end(input);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function nulPaths(bytes) {
  return bytes.toString('utf8').split('\0').filter(Boolean).sort();
}

async function requireGit(repoRoot, args, operation, options) {
  const result = await runGit(repoRoot, args, options);
  if (result.code !== 0) {
    throw new GitPublicationError(`${operation} failed`, {
      code: 'git_failed',
      details: { args, stderr: result.stderr, exitCode: result.code, signal: result.signal },
    });
  }
  return result;
}

async function stagedPaths(repoRoot, env) {
  const result = await requireGit(
    repoRoot,
    ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACDMRTUXB'],
    'Inspecting staged files',
    { env },
  );
  return nulPaths(result.stdout);
}

async function createTargetParentGuard(repoRoot, parentPath) {
  let handle;
  try {
    const lexicalStats = await lstat(parentPath);
    const physicalPath = await realpath(parentPath);
    const physicalStats = await lstat(physicalPath);
    if (
      physicalPath !== parentPath
      || lexicalStats.isSymbolicLink()
      || !lexicalStats.isDirectory()
      || physicalStats.isSymbolicLink()
      || !physicalStats.isDirectory()
      || !sameFileIdentity(lexicalStats, physicalStats)
      || !isInside(repoRoot, physicalPath)
    ) {
      throw new Error('target parent is not a contained physical directory');
    }
    handle = await open(
      physicalPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const openedStats = await handle.stat();
    if (!openedStats.isDirectory() || !sameFileIdentity(openedStats, physicalStats)) {
      throw new Error('target parent identity changed while opening');
    }

    let closed = false;
    return {
      path: physicalPath,
      async assertStable() {
        if (closed) throw new Error('target parent guard is closed');
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
            throw new Error('target parent identity changed');
          }
        } catch (error) {
          throw new GitPublicationError('Publication target parent changed during Git staging', {
            code: 'target_changed',
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
    if (error instanceof GitPublicationError) throw error;
    throw new GitPublicationError('Publication target parent could not be bound safely', {
      code: 'unsafe_target',
      cause: error,
    });
  }
}

async function readGuardedTarget(destination, guard, targetPath) {
  await guard.assertStable();
  let handle;
  try {
    const resolved = await realpath(destination);
    if (resolved !== destination || path.dirname(destination) !== guard.path) {
      throw new Error('target is not a physical child of its bound parent');
    }
    handle = await open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat();
    const pathStats = await lstat(destination);
    if (
      !openedStats.isFile()
      || pathStats.isSymbolicLink()
      || !sameFileIdentity(openedStats, pathStats)
    ) {
      throw new Error('target identity changed while opening');
    }
    const bytes = await handle.readFile();
    await guard.assertStable();
    const finalStats = await lstat(destination);
    if (finalStats.isSymbolicLink() || !sameFileIdentity(openedStats, finalStats)) {
      throw new Error('target identity changed while reading');
    }
    return bytes;
  } catch (error) {
    if (error instanceof GitPublicationError) throw error;
    throw new GitPublicationError(`Publication target changed after build: ${targetPath}`, {
      code: 'target_changed',
      cause: error,
    });
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function validateManifestTargets(repoRoot, manifest) {
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new GitPublicationError('Publication manifest must contain files', { code: 'invalid_manifest' });
  }
  const targets = [];
  const seen = new Set();
  const parentGuards = new Map();
  try {
    for (const file of manifest.files) {
      const targetPath = safeRelativePath(file?.targetPath);
      const operation = file?.operation ?? 'write';
      if (
        !targetPath
        || !['write', 'delete'].includes(operation)
        || !SHA256_PATTERN.test(file?.sha256 ?? '')
        || seen.has(targetPath)
      ) {
        throw new GitPublicationError('Publication manifest contains an invalid target or hash', {
          code: 'invalid_manifest',
        });
      }
      const destination = path.join(repoRoot, ...targetPath.split('/'));
      const physicalDestination = await realpathAllowMissing(destination);
      if (!isInside(repoRoot, physicalDestination, { allowRoot: false })) {
        throw new GitPublicationError(`Publication target escapes the repository: ${targetPath}`, {
          code: 'unsafe_target',
        });
      }
      const parent = path.dirname(destination);
      let guard = parentGuards.get(parent);
      if (!guard) {
        guard = await createTargetParentGuard(repoRoot, parent);
        parentGuards.set(parent, guard);
      }
      if (operation === 'delete') {
        try {
          await lstat(destination);
          throw new GitPublicationError(`Deleted publication target reappeared: ${targetPath}`, {
            code: 'target_changed',
          });
        } catch (error) {
          if (error instanceof GitPublicationError) throw error;
          if (error?.code !== 'ENOENT') throw error;
        }
        await guard.assertStable();
        const parentBytes = await requireGit(
          repoRoot,
          ['show', `HEAD:${targetPath}`],
          'Reading publication deletion baseline',
        );
        if (sha256(parentBytes.stdout) !== file.sha256) {
          throw new GitPublicationError(`Publication deletion baseline changed: ${targetPath}`, {
            code: 'target_changed',
          });
        }
      } else if (sha256(await readGuardedTarget(destination, guard, targetPath)) !== file.sha256) {
        throw new GitPublicationError(`Publication target changed after build: ${targetPath}`, {
          code: 'target_changed',
        });
      }
      seen.add(targetPath);
      targets.push(targetPath);
    }
    return {
      targetPaths: targets.sort(),
      async assertStable() {
        for (const guard of parentGuards.values()) await guard.assertStable();
      },
      async close() {
        for (const guard of parentGuards.values()) await guard.close().catch(() => {});
      },
    };
  } catch (error) {
    for (const guard of parentGuards.values()) await guard.close().catch(() => {});
    throw error;
  }
}

async function verifyIndexBlobs(repoRoot, manifest, env) {
  const targetPaths = manifest.files.map(({ targetPath }) => targetPath);
  const result = await requireGit(
    repoRoot,
    ['ls-files', '--stage', '-z', '--', ...targetPaths],
    'Reading staged publication blobs',
    { env },
  );
  const records = new Map();
  for (const rawRecord of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const match = rawRecord.match(/^\d+ ([a-f0-9]+) (\d+)\t([\s\S]+)$/u);
    if (!match || match[2] !== '0') {
      throw new GitPublicationError('Publication index contains an unresolved or invalid entry', {
        code: 'staging_mismatch',
      });
    }
    records.set(match[3], match[1]);
  }

  for (const file of manifest.files) {
    const objectId = records.get(file.targetPath);
    if (file.operation === 'delete') {
      if (objectId) {
        throw new GitPublicationError(`Publication index still contains deleted ${file.targetPath}`, {
          code: 'staging_mismatch',
        });
      }
      continue;
    }
    if (!objectId) {
      throw new GitPublicationError(`Publication index is missing ${file.targetPath}`, {
        code: 'staging_mismatch',
      });
    }
    const blob = await requireGit(
      repoRoot,
      ['cat-file', 'blob', objectId],
      'Reading staged publication blob',
    );
    if (sha256(blob.stdout) !== file.sha256) {
      throw new GitPublicationError(`Staged blob hash differs from the manifest: ${file.targetPath}`, {
        code: 'staging_mismatch',
      });
    }
  }
}

export class GitPublicationError extends Error {
  constructor(message, {
    code = 'git_failed',
    details,
    retry,
    committed = false,
    commitSha,
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'GitPublicationError';
    this.code = code;
    if (details !== undefined) this.details = details;
    if (retry !== undefined) this.retry = retry;
    this.committed = committed;
    if (commitSha !== undefined) this.commitSha = commitSha;
  }
}

export function publicationCommitMessage(manifest) {
  const publications = Array.isArray(manifest?.publications) ? manifest.publications : [];
  if (publications.length === 1 && typeof publications[0]?.title === 'string') {
    const title = publications[0].title.replace(/\s+/gu, ' ').trim();
    if (title !== '') return `publish: ${Array.from(title).slice(0, 100).join('')}`;
  }
  return `publish: ${publications.length} entries`;
}

export function publicationFilesDigest(files) {
  const records = files
    .map(({ operation, targetPath, sha256: fileHash }) => operation === 'delete'
      ? { operation, targetPath, sha256: fileHash }
      : { targetPath, sha256: fileHash })
    .sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  return sha256(Buffer.from(JSON.stringify(records), 'utf8'));
}

function publicationCommitBody(manifest, targetPaths) {
  const included = new Set(targetPaths);
  const digest = publicationFilesDigest(
    manifest.files.filter(({ targetPath }) => included.has(targetPath)),
  );
  return `${publicationCommitMessage(manifest)}\n\nPublisher-Manifest-SHA256: ${digest}`;
}

export async function pushPublicationCommit({
  repoRoot,
  commitSha,
  remote = 'origin',
} = {}) {
  if (typeof remote !== 'string' || remote.trim() === '' || remote.startsWith('-')) {
    throw new TypeError('remote must be a safe Git remote name');
  }
  const physicalRepoRoot = await realpath(repoRoot);
  const head = (await requireGit(
    physicalRepoRoot,
    ['rev-parse', 'HEAD'],
    'Reading publication commit',
  )).stdout.toString('utf8').trim();
  if (typeof commitSha !== 'string' || head !== commitSha) {
    throw new GitPublicationError('Publication commit is no longer the current HEAD', {
      code: 'push_failed',
      retry: { commitSha, remote, branch: null },
    });
  }
  const branch = (await requireGit(
    physicalRepoRoot,
    ['branch', '--show-current'],
    'Reading current branch',
  )).stdout.toString('utf8').trim();
  if (branch === '') {
    throw new GitPublicationError('Cannot push a publication commit from detached HEAD', {
      code: 'push_failed',
      retry: { commitSha, remote, branch: null },
    });
  }
  const args = ['push', remote, branch];
  const pushResult = await runGit(physicalRepoRoot, args);
  if (pushResult.code !== 0) {
    throw new GitPublicationError('Publication commit was created, but push failed', {
      code: 'push_failed',
      details: { stderr: pushResult.stderr, exitCode: pushResult.code, signal: pushResult.signal },
      retry: { commitSha, remote, branch, args },
    });
  }
  return { commitSha, pushed: true, remote, branch };
}

export async function commitPublication({
  repoRoot,
  manifest,
  push = false,
  remote = 'origin',
  expectedParentSha,
} = {}) {
  if (typeof push !== 'boolean') throw new TypeError('push must be a boolean');
  const physicalRepoRoot = await realpath(repoRoot);
  const rootStats = await stat(physicalRepoRoot);
  if (!rootStats.isDirectory()) throw new TypeError('repoRoot must be a Git repository directory');
  await requireGit(physicalRepoRoot, ['rev-parse', '--git-dir'], 'Locating Git repository');

  const targetValidation = await validateManifestTargets(physicalRepoRoot, manifest);
  const { targetPaths } = targetValidation;
  try {
    const existingStaged = await stagedPaths(physicalRepoRoot);
    const overlappingStaged = existingStaged.filter((targetPath) => targetPaths.includes(targetPath));
    if (overlappingStaged.length > 0) {
      throw new GitPublicationError('Git index already contains staged changes at publication targets', {
        code: 'staged_conflict',
        details: { stagedPaths: overlappingStaged },
      });
    }

    const parentSha = (await requireGit(
      physicalRepoRoot,
      ['rev-parse', 'HEAD'],
      'Reading publication parent commit',
    )).stdout.toString('utf8').trim();
    if (expectedParentSha !== undefined && parentSha !== expectedParentSha) {
      throw new GitPublicationError('Repository HEAD changed after the candidate build', {
        code: 'repository_changed',
        details: { expectedParentSha, actualParentSha: parentSha },
      });
    }
    const indexRoot = await mkdtemp(path.join(os.tmpdir(), 'publisher-git-index-'));
    const isolatedEnv = { GIT_INDEX_FILE: path.join(indexRoot, 'index') };
    let commitSha;
    try {
      await requireGit(
        physicalRepoRoot,
        ['read-tree', parentSha],
        'Initializing isolated publication index',
        { env: isolatedEnv },
      );
      await targetValidation.assertStable();
      await requireGit(
        physicalRepoRoot,
        ['add', '--', ...targetPaths],
        'Staging publication files',
        { env: isolatedEnv },
      );
      await targetValidation.assertStable();
      const actualStagedPaths = await stagedPaths(physicalRepoRoot, isolatedEnv);
      if (
        actualStagedPaths.length === 0
        || actualStagedPaths.some((targetPath) => !targetPaths.includes(targetPath))
      ) {
        throw new GitPublicationError('Staged files do not match the publication manifest', {
          code: 'staging_mismatch',
          details: { manifestPaths: targetPaths, stagedPaths: actualStagedPaths },
        });
      }
      await verifyIndexBlobs(physicalRepoRoot, manifest, isolatedEnv);
      await targetValidation.assertStable();

      const message = publicationCommitMessage(manifest);
      const commitBody = publicationCommitBody(manifest, actualStagedPaths);
      const treeSha = (await requireGit(
        physicalRepoRoot,
        ['write-tree'],
        'Writing exact publication tree',
        { env: isolatedEnv },
      )).stdout.toString('utf8').trim();
      commitSha = (await requireGit(
        physicalRepoRoot,
        ['commit-tree', treeSha, '-p', parentSha],
        'Creating exact publication commit',
        { input: `${commitBody}\n` },
      )).stdout.toString('utf8').trim();

      const committedPaths = nulPaths((await requireGit(
        physicalRepoRoot,
        ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commitSha],
        'Verifying publication commit scope',
      )).stdout);
      if (
        committedPaths.length !== actualStagedPaths.length
        || committedPaths.some((targetPath, index) => targetPath !== actualStagedPaths[index])
      ) {
        throw new GitPublicationError('Publication commit tree does not match the isolated staged set', {
          code: 'staging_mismatch',
          details: { committedPaths, stagedPaths: actualStagedPaths },
        });
      }

      await requireGit(
        physicalRepoRoot,
        ['update-ref', '-m', message, 'HEAD', commitSha, parentSha],
        'Advancing HEAD to the publication commit',
      );
      const refreshResult = await runGit(
        physicalRepoRoot,
        ['reset', '--quiet', 'HEAD', '--', ...targetPaths],
      );
      if (refreshResult.code !== 0) {
        throw new GitPublicationError('Publication committed, but the working index needs recovery', {
          code: 'index_recovery_required',
          committed: true,
          commitSha,
          details: {
            stderr: refreshResult.stderr,
            message,
            publicationPaths: actualStagedPaths,
            preexistingStagedPaths: existingStaged,
          },
          retry: {
            commitSha,
            args: ['reset', '--quiet', 'HEAD', '--', ...targetPaths],
          },
        });
      }

      if (!push) {
        return { commitSha, message, stagedPaths: actualStagedPaths, pushed: false };
      }

      try {
        const pushResult = await pushPublicationCommit({
          repoRoot: physicalRepoRoot,
          commitSha,
          remote,
        });
        return { commitSha, message, stagedPaths: actualStagedPaths, ...pushResult };
      } catch (error) {
        error.committed = true;
        error.commitSha = commitSha;
        throw error;
      }
    } finally {
      // The ref may already point at the publication commit; temporary-index cleanup
      // must never turn that durable success into an apparent pre-commit failure.
      await rm(indexRoot, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await targetValidation.close();
  }
}
