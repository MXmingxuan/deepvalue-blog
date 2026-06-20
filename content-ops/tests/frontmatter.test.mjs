import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, serializeMarkdown } from '../lib/frontmatter.mjs';

test('parseMarkdown parses frontmatter and body', () => {
  const source = `---\ntitle: 事件点评：轮胎涨价\ndate: 2026-06-16\ntags: [事件点评, 化工, 轮胎]\ncategories: [产业研究]\n---\n\n# 正文\n`;
  const parsed = parseMarkdown(source);
  assert.deepEqual(parsed.data, {
    title: '事件点评：轮胎涨价',
    date: '2026-06-16',
    tags: ['事件点评', '化工', '轮胎'],
    categories: ['产业研究']
  });
  assert.equal(parsed.body.trim(), '# 正文');
});

test('parseMarkdown handles markdown without frontmatter', () => {
  const parsed = parseMarkdown('# Untitled\n');
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.body, '# Untitled\n');
});

test('serializeMarkdown writes arrays and preserves body', () => {
  const output = serializeMarkdown({
    title: '公司分析：中国重汽000951',
    date: '2026-06-20',
    tags: ['公司分析', '重卡']
  }, '# 正文\n');
  assert.match(output, /^---\n/);
  assert.match(output, /title: 公司分析：中国重汽000951\n/);
  assert.match(output, /tags: \[公司分析, 重卡\]\n/);
  assert.match(output, /\n---\n\n# 正文\n$/);
});

test('serializeMarkdown quotes unsafe scalar descriptions', () => {
  const output = serializeMarkdown({
    title: '测试',
    description: 'alpha: beta # note'
  }, '# 正文\n');

  assert.match(output, /description: "alpha: beta # note"\n/);
});

test('serializeMarkdown quotes unsafe array items', () => {
  const output = serializeMarkdown({
    title: '测试',
    tags: ['化工', 'alpha: beta']
  }, '# 正文\n');

  assert.match(output, /tags: \[化工, "alpha: beta"\]\n/);
});

test('serializeMarkdown quotes array items containing commas', () => {
  const output = serializeMarkdown({
    title: '测试',
    tags: ['a, b', 'c']
  }, '# 正文\n');

  assert.match(output, /tags: \["a, b", c\]\n/);
});

test('parseMarkdown parses quoted array items containing commas', () => {
  const source = `---\ntitle: 测试\ntags: ["a, b", c]\n---\nbody`;
  const parsed = parseMarkdown(source);

  assert.deepEqual(parsed.data.tags, ['a, b', 'c']);
});

test('parseMarkdown round-trips comma array items', () => {
  const output = serializeMarkdown({
    title: '测试',
    tags: ['a, b', 'c']
  }, '# 正文\n');
  const parsed = parseMarkdown(output);

  assert.deepEqual(parsed.data.tags, ['a, b', 'c']);
});

test('parseMarkdown round-trips JSON-quoted scalar values', () => {
  const source = `---\ntitle: 测试\ndescription: "alpha: beta # note"\n---\n\n# 正文\n`;
  const parsed = parseMarkdown(source);

  assert.equal(parsed.data.description, 'alpha: beta # note');
});
