import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPathTools } from './paths.mjs';
import { parseMarkdown, serializeMarkdown } from './frontmatter.mjs';
import { createStateStore } from './state-store.mjs';
import { inferWorkflowStatus, validateItem } from './validators.mjs';

const CONTENT_DIRS = [
  { contentType: 'blog', relativeDir: 'src/content/blog' },
  { contentType: 'project', relativeDir: 'src/content/projects' }
];

async function listMarkdownFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(absolute);
    }
  }
  return files;
}

function contentTypeFromRelativePath(relativePath) {
  return relativePath.includes('/projects/') ? 'project' : 'blog';
}

function buildItem({ relativePath, contentType, parsed, itemState = {}, includeBody = false }) {
  const checks = validateItem({ contentType, data: parsed.data, body: parsed.body });
  return {
    id: relativePath,
    relativePath,
    contentType,
    data: parsed.data,
    ...(includeBody ? { body: parsed.body } : {}),
    checks,
    workflowStatus: inferWorkflowStatus({ storedStatus: itemState.workflowStatus, checks }),
    ops: itemState
  };
}

export function createContentStore(projectRoot = process.cwd()) {
  const paths = createPathTools(projectRoot);
  const stateStore = createStateStore(projectRoot);

  async function readContent(relativePath) {
    const normalizedPath = paths.contentIdFromRelative(relativePath);
    const absolutePath = paths.resolveInside(normalizedPath);
    const raw = await readFile(absolutePath, 'utf8');
    const parsed = parseMarkdown(raw);
    const contentType = contentTypeFromRelativePath(normalizedPath);
    const state = await stateStore.readState();
    return buildItem({
      relativePath: normalizedPath,
      contentType,
      parsed,
      itemState: state.items[normalizedPath] ?? {},
      includeBody: true
    });
  }

  async function listContent() {
    const state = await stateStore.readState();
    const items = [];
    for (const dir of CONTENT_DIRS) {
      const absoluteDir = paths.resolveInside(dir.relativeDir);
      await mkdir(absoluteDir, { recursive: true });
      const files = await listMarkdownFiles(absoluteDir);
      for (const absoluteFile of files) {
        const relativePath = paths.toRelativeContentPath(absoluteFile);
        const raw = await readFile(absoluteFile, 'utf8');
        const parsed = parseMarkdown(raw);
        items.push(buildItem({
          relativePath,
          contentType: dir.contentType,
          parsed,
          itemState: state.items[relativePath] ?? {}
        }));
      }
    }
    return items.sort((a, b) => String(b.data.date ?? '').localeCompare(String(a.data.date ?? '')));
  }

  async function saveContent(relativePath, { data, body, ops }) {
    const normalizedPath = paths.contentIdFromRelative(relativePath);
    const absolutePath = paths.resolveInside(normalizedPath);
    await writeFile(absolutePath, serializeMarkdown(data, body), 'utf8');
    if (ops) {
      await stateStore.updateState((state) => ({
        ...state,
        items: {
          ...state.items,
          [normalizedPath]: {
            ...(state.items[normalizedPath] ?? {}),
            ...ops,
            lastCheckedAt: new Date().toISOString()
          }
        }
      }));
    }
    return readContent(normalizedPath);
  }

  return { listContent, readContent, saveContent };
}
