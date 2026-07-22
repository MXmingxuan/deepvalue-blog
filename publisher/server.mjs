import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK_HOST = '127.0.0.1';
const PREVIEW_PREFIX = '/_publisher/preview';
const ACTION_PREFIX = '/_publisher/action/';
const UI_PREFIX = '/_publisher/ui/';
const DEFAULT_PUBLIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function controlPage(template, { route, manifest, token, allowPush }) {
  const previewRoute = `${PREVIEW_PREFIX}${route}`;
  const state = safeJson({ route, previewRoute, manifest, token, allowPush });
  return template.replace('__PUBLISHER_DATA__', state);
}

function contentType(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.avif': return 'image/avif';
    case '.gif': return 'image/gif';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';
    default: return 'application/octet-stream';
  }
}

async function previewFile(previewRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined;
  const relative = decoded.replace(/^\/+/, '');
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return undefined;
  }

  const candidates = decoded.endsWith('/')
    ? [path.join(previewRoot, ...normalized.split('/'), 'index.html')]
    : [
        path.join(previewRoot, ...normalized.split('/')),
        path.join(previewRoot, ...normalized.split('/'), 'index.html'),
      ];

  for (const candidate of candidates) {
    try {
      const physicalPath = await realpath(candidate);
      const details = await stat(physicalPath);
      if (!isInside(previewRoot, physicalPath) || !details.isFile()) continue;
      return { bytes: await readFile(physicalPath), filename: physicalPath };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }
  return undefined;
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function tokenMatches(expected, candidate) {
  if (typeof candidate !== 'string') return false;
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length
    && timingSafeEqual(expectedBytes, candidateBytes);
}

function jsonResponse(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function pageHeaders(contentTypeValue) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; frame-src 'self'; form-action 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    'Content-Type': contentTypeValue,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function previewHeaders(contentTypeValue) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self' data:; base-uri 'none'; connect-src 'none'; frame-ancestors 'self'; form-action 'none'; object-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'",
    'Content-Type': contentTypeValue,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

export async function startPublisherServer({
  previewRoot,
  route,
  manifest,
  allowPush = true,
  onConfirm,
  onCancel,
  publicRoot = DEFAULT_PUBLIC_ROOT,
} = {}) {
  if (typeof route !== 'string' || !route.startsWith('/')) {
    throw new TypeError('A root-relative target route is required');
  }
  if (typeof onConfirm !== 'function' || typeof onCancel !== 'function') {
    throw new TypeError('Publisher confirmation and cancellation handlers are required');
  }
  if (typeof allowPush !== 'boolean') throw new TypeError('allowPush must be a boolean');
  const physicalPreviewRoot = await realpath(previewRoot);
  const previewStats = await stat(physicalPreviewRoot);
  if (!previewStats.isDirectory()) throw new TypeError('previewRoot must be a directory');
  const physicalPublicRoot = await realpath(publicRoot);
  const [pageTemplate, stylesheet, application] = await Promise.all([
    readFile(path.join(physicalPublicRoot, 'index.html'), 'utf8'),
    readFile(path.join(physicalPublicRoot, 'styles.css')),
    readFile(path.join(physicalPublicRoot, 'app.js')),
  ]);

  const token = randomBytes(32).toString('base64url');
  let tokenUsed = false;
  let allowedHost;
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  resultPromise.catch(() => {});

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== allowedHost) {
        response.writeHead(421, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('Misdirected Request');
        return;
      }
      const requestUrl = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
      if (requestUrl.pathname.startsWith(ACTION_PREFIX)) {
        if (request.method !== 'POST') {
          jsonResponse(response, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' });
          return;
        }
        if (!tokenMatches(token, request.headers['x-publisher-token'])) {
          jsonResponse(response, 403, { error: 'Invalid publisher token' });
          return;
        }
        if (tokenUsed) {
          jsonResponse(response, 409, { error: 'Publisher action already used' });
          return;
        }

        const actionName = requestUrl.pathname.slice(ACTION_PREFIX.length);
        const action = actionName === 'confirm-push'
          ? { type: 'confirm', push: true }
          : actionName === 'confirm-local'
            ? { type: 'confirm', push: false }
            : actionName === 'cancel'
              ? { type: 'cancel' }
              : undefined;
        if (!action) {
          jsonResponse(response, 404, { error: 'Unknown publisher action' });
          return;
        }
        if (action.push && !allowPush) {
          jsonResponse(response, 403, { error: 'Push is disabled for this transaction' });
          return;
        }

        tokenUsed = true;
        try {
          const result = action.type === 'confirm'
            ? await onConfirm({ push: action.push })
            : await onCancel();
          const outcome = action.type === 'confirm'
            ? { action: 'confirm', push: action.push, result }
            : { action: 'cancel', result };
          jsonResponse(response, 200, { ok: true, ...outcome });
          resolveResult(outcome);
        } catch (error) {
          jsonResponse(response, 500, { error: error?.message ?? 'Publisher action failed' });
          rejectResult(error);
        }
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Method Not Allowed');
        return;
      }
      if (requestUrl.pathname === route) {
        response.writeHead(200, pageHeaders('text/html; charset=utf-8'));
        response.end(controlPage(pageTemplate, {
          route,
          manifest,
          token,
          allowPush,
        }));
        return;
      }
      if (requestUrl.pathname === `${UI_PREFIX}styles.css`) {
        response.writeHead(200, pageHeaders('text/css; charset=utf-8'));
        response.end(stylesheet);
        return;
      }
      if (requestUrl.pathname === `${UI_PREFIX}app.js`) {
        response.writeHead(200, pageHeaders('text/javascript; charset=utf-8'));
        response.end(application);
        return;
      }
      if (requestUrl.pathname.startsWith(`${PREVIEW_PREFIX}/`)) {
        const file = await previewFile(
          physicalPreviewRoot,
          requestUrl.pathname.slice(PREVIEW_PREFIX.length),
        );
        if (file) {
          response.writeHead(200, previewHeaders(contentType(file.filename)));
          response.end(file.bytes);
          return;
        }
      }
      if (!requestUrl.pathname.startsWith('/_publisher/')) {
        const file = await previewFile(physicalPreviewRoot, requestUrl.pathname);
        if (file) {
          response.writeHead(200, previewHeaders(contentType(file.filename)));
          response.end(file.bytes);
          return;
        }
      }
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Publisher server error');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  allowedHost = `${LOOPBACK_HOST}:${address.port}`;
  const url = `http://${LOOPBACK_HOST}:${address.port}${route}`;
  return {
    server,
    token,
    url,
    waitForResult: () => resultPromise,
    close: () => closeServer(server),
  };
}
