import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repositoryRoot = new URL('../', import.meta.url);

const expectedRedirects = [
  {
    source: '/chemical-research/',
    destination: '/investment/?section=commodities&topic=fluorochemicals',
    statusCode: 301,
  },
  {
    source: '/fluorochemical-research/',
    destination: '/investment/?section=commodities&topic=fluorochemicals',
    statusCode: 301,
  },
  {
    source: '/energy-research/',
    destination: '/investment/?section=commodities&topic=energy',
    statusCode: 301,
  },
  {
    source: '/shipping-shipbuilding-research/',
    destination: '/investment/?section=commodities&topic=shipping',
    statusCode: 301,
  },
  {
    source: '/ai-infrastructure-research/',
    destination: '/ai/?section=ai-industry&topic=ai-infrastructure',
    statusCode: 301,
  },
  {
    source: '/ai-data-center-research/',
    destination: '/ai/?section=ai-industry&topic=ai-infrastructure',
    statusCode: 301,
  },
];

test('vercel.json defines the six legacy topic redirects as exact HTTP 301s', async () => {
  const contents = await readFile(new URL('vercel.json', repositoryRoot), 'utf8');
  const config = JSON.parse(contents);

  assert.deepEqual(config.redirects, expectedRedirects);
  assert.equal(config.redirects.some(redirect => 'permanent' in redirect), false);
});
