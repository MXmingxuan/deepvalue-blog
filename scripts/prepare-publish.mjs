import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const repoRoot = process.cwd();
const blogDir = path.join(repoRoot, 'src', 'content', 'blog');
const assetRoot = path.join(repoRoot, 'public', 'images', 'research-assets');
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

const providedFiles = process.argv.slice(2);

function slugify(input, fallback = 'article') {
  const readable = input
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  if (readable && readable.length >= 4) return readable;
  return `${fallback}-${crypto.createHash('sha1').update(input).digest('hex').slice(0, 8)}`;
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function encodeUrlPath(value) {
  return value.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function findAttachment(name, markdownPath) {
  const normalizedName = name.replaceAll('\\', '/').trim();
  const candidates = [
    path.resolve(path.dirname(markdownPath), normalizedName),
    path.resolve(repoRoot, normalizedName),
    path.resolve(blogDir, normalizedName),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }

  const basename = path.basename(normalizedName);
  const rootEntries = await fs.readdir(repoRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.isFile() && entry.name === basename) {
      return path.join(repoRoot, entry.name);
    }
  }

  return null;
}

async function uniqueDestination(dir, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const stem = path.basename(originalName, path.extname(originalName));
  const safeStem = slugify(stem, 'image');
  let candidate = `${safeStem}${ext}`;
  let counter = 2;

  while (await pathExists(path.join(dir, candidate))) {
    candidate = `${safeStem}-${counter}${ext}`;
    counter += 1;
  }

  return path.join(dir, candidate);
}

async function moveAttachment(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });

  if (path.resolve(source) === path.resolve(destination)) {
    return;
  }

  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(source, destination);
    await fs.rm(source);
  }
}

function normalizeEmptyFrontmatterValues(markdown) {
  return markdown.replace(/^((?:description|summary|thesis):)\s*$/gm, '$1 ""');
}

async function processMarkdown(markdownPath) {
  let markdown = await fs.readFile(markdownPath, 'utf8');
  let changed = false;
  const articleName = path.basename(markdownPath, '.md');
  const articleSlug = slugify(articleName, 'article');
  const articleAssetDir = path.join(assetRoot, articleSlug);

  markdown = normalizeEmptyFrontmatterValues(markdown);

  const obsidianImagePattern = /!\[\[([^\]\n]+?)\]\]/g;
  const replacements = [];

  for (const match of markdown.matchAll(obsidianImagePattern)) {
    const rawTarget = match[1];
    const [targetPath, altTextRaw] = rawTarget.split('|');
    const source = await findAttachment(targetPath, markdownPath);

    if (!source) {
      console.warn(`WARN missing attachment for ${toPosixPath(path.relative(repoRoot, markdownPath))}: ${targetPath}`);
      continue;
    }

    const ext = path.extname(source).toLowerCase();
    if (!imageExtensions.has(ext)) {
      console.warn(`WARN unsupported attachment type: ${toPosixPath(path.relative(repoRoot, source))}`);
      continue;
    }

    const destination = await uniqueDestination(articleAssetDir, path.basename(source));
    await moveAttachment(source, destination);

    const publicRelative = toPosixPath(path.relative(path.join(repoRoot, 'public'), destination));
    const imageUrl = `/${encodeUrlPath(publicRelative)}`;
    const altText = (altTextRaw || path.basename(source, path.extname(source))).trim();
    replacements.push([match[0], `![${altText}](${imageUrl})`]);
    changed = true;
  }

  for (const [from, to] of replacements) {
    markdown = markdown.replace(from, to);
  }

  if (changed || markdown !== await fs.readFile(markdownPath, 'utf8')) {
    await fs.writeFile(markdownPath, markdown, 'utf8');
  }

  return {
    markdownPath,
    changed,
    moved: replacements.length,
  };
}

const markdownFiles = providedFiles.length
  ? providedFiles.map(file => path.resolve(repoRoot, file))
  : await listMarkdownFiles(blogDir);

const results = [];
for (const markdownPath of markdownFiles) {
  results.push(await processMarkdown(markdownPath));
}

for (const result of results) {
  const relative = toPosixPath(path.relative(repoRoot, result.markdownPath));
  console.log(`${relative}: ${result.moved} image(s) organized`);
}
