import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createPathTools } from '../lib/paths.mjs';

test('resolveInside returns absolute path for project-relative content path', () => {
  const root = path.resolve('D:/github/deepvalue-blog').replaceAll('\\', '/');
  const tools = createPathTools(root);
  const resolved = tools.resolveInside('src/content/blog/example.md').replaceAll('\\', '/');
  assert.equal(resolved, `${root}/src/content/blog/example.md`);
});

test('resolveInside rejects parent traversal', () => {
  const tools = createPathTools(path.resolve('D:/github/deepvalue-blog'));
  assert.throws(
    () => tools.resolveInside('../outside.md'),
    /Path escapes project root/
  );
});

test('toRelativeContentPath normalizes separators', () => {
  const root = path.resolve('D:/github/deepvalue-blog');
  const tools = createPathTools(root);
  const absolute = path.join(root, 'src', 'content', 'blog', '例子.md');
  assert.equal(tools.toRelativeContentPath(absolute), 'src/content/blog/例子.md');
});
