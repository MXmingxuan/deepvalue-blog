import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STATE = { items: {}, commands: [] };

export function createStateStore(projectRoot = process.cwd()) {
  const stateDir = path.join(projectRoot, '.content-ops');
  const statePath = path.join(stateDir, 'state.json');

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
    const state = await readState();
    const next = await updater(state);
    await writeState(next);
    return next;
  }

  return { statePath, readState, writeState, updateState };
}
