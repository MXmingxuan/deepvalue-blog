import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
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

test('publisher documentation names the same canonical investment section slugs', async () => {
  const publisherReadme = await source('publisher/README.md');

  for (const section of INVESTMENT_SECTIONS) {
    assert.match(publisherReadme, new RegExp(`\\b${section}\\b`, 'u'));
  }

  assert.doesNotMatch(
    publisherReadme,
    /one of `commodities`, `industries`, `companies`, `macro`, or\s+`trading`/u,
  );
});

test('production hero uses the compressed asset and design plan has portable provenance', async () => {
  const homepage = await source('src/pages/index.astro');
  const plan = await source('docs/superpowers/plans/2026-07-21-site-editorial-redesign.md');
  const optimizedHero = await stat(new URL(
    'public/images/brand/commodities-macro-hero.avif',
    repositoryRoot,
  ));

  assert.match(homepage, /commodities-macro-hero\.avif/u);
  assert.doesNotMatch(homepage, /commodities-macro-hero\.png/u);
  assert.ok(optimizedHero.size >= 100_000 && optimizedHero.size <= 700_000);
  await assert.rejects(source('public/images/brand/commodities-macro-hero.png'));
  assert.match(plan, /SHA-256:/u);
  assert.doesNotMatch(plan, /\/Users\/matt\//u);
});

test('dark surfaces use an accessible copper semantic token for small text', async () => {
  const layout = await source('src/layouts/Base.astro');
  const homepage = await source('src/pages/index.astro');
  const blogIndex = await source('src/pages/blog/index.astro');

  assert.match(layout, /--color-copper-on-ink:\s*#[0-9a-f]{6}/iu);
  assert.match(layout, /\.footer-links a\s*\{[^}]*color:\s*var\(--color-copper-on-ink\)/su);
  assert.match(homepage, /\.hero-index-row span:first-child\s*\{[^}]*color:\s*var\(--color-copper-on-ink\)/su);
  assert.match(blogIndex, /\.domain-filter button\.is-active span\s*\{[^}]*color:\s*var\(--color-copper-on-ink\)/su);
});

test('Beyond provides a direct in-site entrance to the projects index', async () => {
  const beyond = await source('src/pages/beyond/index.astro');

  assert.match(beyond, /href="\/projects\/"/u);
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
