import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { INVESTMENT_SECTIONS } from '../publisher/lib/validate.mjs';

const repositoryRoot = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, repositoryRoot), 'utf8');
}

test('Investment section links use the publisher canonical section slugs', async () => {
  const investment = await source('src/pages/investment/index.astro');
  const sectionSlugs = [...investment.matchAll(/href:\s*'\/investment\/\?section=([^']+)'/g)]
    .map(match => match[1]);

  assert.deepEqual(sectionSlugs, INVESTMENT_SECTIONS);
});

test('EntryList renders grouped empty states and displays its effective sort timestamp', async () => {
  const entryList = await source('src/components/EntryList.astro');

  assert.match(entryList, /groupByFormat\s*\|\|\s*entries\.length\s*>\s*0/);
  assert.match(entryList, /effectiveEntryDate\(entry\)/);
  assert.match(entryList, /entry\.data\.updated_at\s*\?\s*'更新'\s*:\s*'发布'/);
});

test('Research Log sorts and labels entries by immutable published timestamp', async () => {
  const researchLog = await source('src/pages/research-log/index.astro');

  assert.match(researchLog, /sortEntriesByPublishedNewestFirst/);
  assert.match(researchLog, /PUBLISHED \/ 发布/);
  assert.match(researchLog, /entry\.data\.published_at\.toISOString\(\)/);
});

test('log detail retains timestamp precision and exposes format-specific metadata labels', async () => {
  const detail = await source('src/pages/blog/[slug].astro');

  assert.match(detail, /dateTimeFormatter/);
  assert.match(detail, /isLog\s*\?\s*dateTimeFormatter/);
  assert.match(detail, /aria-label=\{isLog\s*\?\s*'日志元数据'\s*:\s*'文章元数据'\}/);
});
