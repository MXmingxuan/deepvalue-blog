import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublished,
  selectPublished,
  sortEntriesNewestFirst,
} from '../src/lib/entry-utils.mjs';

function entry(id, overrides = {}) {
  return {
    id,
    data: {
      status: 'published',
      domain: 'investment',
      format: 'article',
      published_at: new Date('2026-07-01'),
      ...overrides,
    },
  };
}

test('isPublished accepts only published entries', () => {
  assert.equal(isPublished(entry('published')), true);
  assert.equal(isPublished(entry('draft', { status: 'draft' })), false);
  assert.equal(isPublished(entry('archived', { status: 'archived' })), false);
});

test('selectPublished filters drafts before applying domain and format filters', () => {
  const entries = [
    entry('investment-article'),
    entry('investment-log', { format: 'log' }),
    entry('ai-log', { domain: 'ai', format: 'log' }),
    entry('private-draft', { status: 'draft', domain: 'ai', format: 'log' }),
  ];

  assert.deepEqual(
    selectPublished(entries, { domain: 'ai', format: 'log' }).map(item => item.id),
    ['ai-log'],
  );
});

test('sortEntriesNewestFirst uses updated_at before published_at', () => {
  const entries = [
    entry('older', { published_at: new Date('2026-07-01') }),
    entry('updated', {
      published_at: new Date('2026-06-01'),
      updated_at: new Date('2026-07-03'),
    }),
    entry('newer', { published_at: new Date('2026-07-02') }),
  ];

  assert.deepEqual(
    sortEntriesNewestFirst(entries).map(item => item.id),
    ['updated', 'newer', 'older'],
  );
});
