import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createContentStore } from './lib/content-store.mjs';
import { createCommandRunner } from './lib/command-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();
const publicDir = path.join(__dirname, 'public');
const store = createContentStore(projectRoot);
const commands = createCommandRunner(projectRoot);

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
}

function resolvePublicPath(urlPath) {
  const safePath = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  const absolute = path.resolve(publicDir, `.${safePath}`);
  const relative = path.relative(publicDir, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw Object.assign(new Error('Static path escapes public directory'), { statusCode: 403 });
  }
  return absolute;
}

async function sendStatic(response, urlPath) {
  const absolute = resolvePublicPath(urlPath);
  const ext = path.extname(absolute);
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
  };
  const content = await readFile(absolute);
  response.writeHead(200, { 'content-type': contentTypes[ext] ?? 'application/octet-stream' });
  response.end(content);
}

async function route(request, response) {
  const url = new URL(request.url, 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/api/content') {
    return sendJson(response, 200, { items: await store.listContent() });
  }

  if (request.method === 'GET' && url.pathname === '/api/content/item') {
    return sendJson(response, 200, { item: await store.readContent(url.searchParams.get('path')) });
  }

  if (request.method === 'PUT' && url.pathname === '/api/content/item') {
    const payload = await readJson(request);
    return sendJson(response, 200, { item: await store.saveContent(payload.relativePath, payload) });
  }

  if (request.method === 'POST' && url.pathname === '/api/commands/build') {
    return sendJson(response, 200, { command: await commands.runBuild() });
  }

  if (request.method === 'POST' && url.pathname === '/api/commands/sync') {
    return sendJson(response, 200, { command: await commands.runSync() });
  }

  if (request.method === 'POST' && url.pathname === '/api/commands/open-external') {
    const payload = await readJson(request);
    return sendJson(response, 200, { command: await commands.openExternal(payload.relativePath) });
  }

  if (request.method === 'GET' && url.pathname === '/api/commands') {
    return sendJson(response, 200, { commands: await commands.listCommands() });
  }

  return sendStatic(response, url.pathname);
}

export function createContentOpsServer() {
  return http.createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      if (error.code === 'ENOENT') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      sendJson(response, error.statusCode ?? 500, { error: error.message });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.CONTENT_OPS_PORT ?? 4399);
  createContentOpsServer().listen(port, '127.0.0.1', () => {
    console.log(`Deep Value Ops running at http://localhost:${port}`);
  });
}
