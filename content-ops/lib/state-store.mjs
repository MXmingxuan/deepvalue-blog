import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE = { items: {}, commands: [] };
const updateQueues = new Map();

function queueKeyFor(statePath) {
  return process.platform === 'win32' ? statePath.toLowerCase() : statePath;
}

export function createStateStore(projectRoot = process.cwd()) {
  const normalizedRoot = path.resolve(projectRoot);
  const stateDir = path.join(normalizedRoot, '.content-ops');
  const statePath = path.join(stateDir, 'state.json');
  const queueKey = queueKeyFor(statePath);

  async function readState() {
    try {
      const raw = await readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        items: parsed.items && typeof parsed.items === 'object' ? parsed.items : {},
        commands: Array.isArray(parsed.commands) ? parsed.commands : []
      };
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(DEFAULT_STATE);
      throw error;
    }
  }

  async function writeState(state) {
    await mkdir(stateDir, { recursive: true });
    const normalized = {
      items: state.items ?? {},
      commands: Array.isArray(state.commands) ? state.commands.slice(-20) : []
    };
    const tempPath = path.join(stateDir, `state.json.tmp-${process.pid}-${Date.now()}-${randomUUID()}`);
    try {
      await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      await rename(tempPath, statePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  async function updateState(updater) {
    const updateQueue = updateQueues.get(queueKey) ?? Promise.resolve();
    const runUpdate = updateQueue.then(async () => {
      const state = await readState();
      const next = await updater(state);
      await writeState(next);
      return next;
    });
    const nextQueue = runUpdate.catch(() => {});
    updateQueues.set(queueKey, nextQueue);
    nextQueue.then(() => {
      if (updateQueues.get(queueKey) === nextQueue) {
        updateQueues.delete(queueKey);
      }
    });
    return runUpdate;
  }

  return { statePath, readState, writeState, updateState };
}
