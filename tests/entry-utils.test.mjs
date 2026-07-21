import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveEntryDate,
  isPublished,
  selectPublished,
  sortEntriesByPublishedNewestFirst,
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

test('selectPublished combines domain, section, and topic filters after excluding drafts', () => {
  const entries = [
    entry('matching-published', { section: 'commodities', topic: 'energy' }),
    entry('matching-draft', {
      status: 'draft',
      section: 'commodities',
      topic: 'energy',
    }),
    entry('wrong-domain', {
      domain: 'ai',
      section: 'commodities',
      topic: 'energy',
    }),
    entry('wrong-section', { section: 'macro', topic: 'energy' }),
    entry('wrong-topic', { section: 'commodities', topic: 'shipping' }),
  ];

  assert.deepEqual(
    selectPublished(entries, {
      domain: 'investment',
      section: 'commodities',
      topic: 'energy',
    }).map(item => item.id),
    ['matching-published'],
  );
});

test('selectPublished returns all and only published entries when filters are empty', () => {
  const entries = [
    entry('article'),
    entry('log', { format: 'log' }),
    entry('draft', { status: 'draft' }),
  ];

  assert.deepEqual(selectPublished(entries).map(item => item.id), ['article', 'log']);
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

  assert.equal(effectiveEntryDate(entries[1]).toISOString(), '2026-07-03T00:00:00.000Z');
});

test('sortEntriesByPublishedNewestFirst preserves chronological log time', () => {
  const entries = [
    entry('older-updated', {
      published_at: new Date('2026-07-01T09:30:00Z'),
      updated_at: new Date('2026-07-04T12:00:00Z'),
    }),
    entry('newer', { published_at: new Date('2026-07-03T08:15:00Z') }),
    entry('middle', { published_at: new Date('2026-07-02T16:45:00Z') }),
  ];

  assert.deepEqual(
    sortEntriesByPublishedNewestFirst(entries).map(item => item.id),
    ['newer', 'middle', 'older-updated'],
  );
});
