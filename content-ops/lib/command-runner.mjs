import { spawn } from 'node:child_process';
import { createPathTools } from './paths.mjs';
import { createStateStore } from './state-store.mjs';

export function createCommandRunner(projectRoot = process.cwd()) {
  const paths = createPathTools(projectRoot);
  const stateStore = createStateStore(projectRoot);

  async function record(commandRecord) {
    await stateStore.updateState((state) => ({
      ...state,
      commands: [...state.commands, commandRecord]
    }));
  }

  function runCommand(name, command, args = []) {
    const startedAt = new Date().toISOString();
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: paths.root
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      async function settle(recordValue) {
        if (settled) return;
        settled = true;
        await record(recordValue);
        resolve(recordValue);
      }

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', async (error) => {
        await settle({
          name,
          command: [command, ...args].join(' '),
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode: null,
          status: 'failed',
          stdout,
          stderr: `${stderr}${error.message}`
        });
      });
      child.on('close', async (exitCode) => {
        await settle({
          name,
          command: [command, ...args].join(' '),
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode,
          status: exitCode === 0 ? 'passed' : 'failed',
          stdout,
          stderr
        });
      });
    });
  }

  function runBuild() {
    return runCommand('build', 'npm.cmd', ['run', 'build']);
  }

  function runSync() {
    return runCommand('sync', 'npm.cmd', ['run', 'sync']);
  }

  async function openExternal(relativePath) {
    const absolute = paths.resolveInside(relativePath);
    return runCommand('open-external', 'code', [absolute]);
  }

  async function listCommands() {
    return (await stateStore.readState()).commands.toReversed();
  }

  return { runCommand, runBuild, runSync, openExternal, listCommands };
}
