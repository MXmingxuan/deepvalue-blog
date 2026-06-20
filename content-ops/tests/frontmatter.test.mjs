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
