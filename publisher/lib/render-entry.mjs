import { stringify as stringifyYaml } from 'yaml';

const OPTIONAL_FIELDS = [
  'section',
  'topic',
  'summary',
  'source_title',
  'source_url',
  'thesis',
  'confidence',
];

function canonicalTimestamp(value) {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new TypeError('confirmedAt must be a valid publication timestamp');
  }
  return timestamp.toISOString();
}

function truncate(value, length) {
  const characters = Array.from(value);
  if (characters.length <= length) return value;
  return `${characters.slice(0, length - 1).join('').trimEnd()}…`;
}

function plainExcerpt(body) {
  const paragraph = body
    .split(/\r?\n\s*\r?\n/u)
    .map((value) => value.trim())
    .find(Boolean) ?? '';
  return paragraph
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[*_~`]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function derivedLogFields(note) {
  const excerpt = plainExcerpt(note.body);
  if (excerpt === '') throw new TypeError('A publication note must contain meaningful body text');
  const sentence = excerpt.match(/^.*?[。！？.!?]/u)?.[0] ?? excerpt;
  return {
    title: truncate(sentence, 72),
    summary: truncate(excerpt, 180),
  };
}

function publicFrontmatter(note, { publishedAt, updatedAt }) {
  const data = note.data ?? {};
  const derived = data.format === 'log' && (!data.title || !data.summary)
    ? derivedLogFields(note)
    : {};
  const frontmatter = {
    title: data.title ?? derived.title,
    publish_id: note.publishId,
    domain: data.domain,
    format: data.format,
    status: 'published',
    published_at: publishedAt,
  };
  if (updatedAt !== undefined) frontmatter.updated_at = updatedAt;

  for (const field of OPTIONAL_FIELDS) {
    const value = field === 'summary' ? (data.summary ?? derived.summary) : data[field];
    if (value !== undefined) frontmatter[field] = value;
  }

  frontmatter.source_type = data.source_type ?? 'original';
  for (const field of ['tags', 'commodities', 'companies', 'tickers']) {
    frontmatter[field] = Array.isArray(data[field]) ? [...data[field]] : [];
  }

  return frontmatter;
}

export function renderEntry({ note, previousState, confirmedAt } = {}) {
  if (!note || typeof note !== 'object' || typeof note.body !== 'string') {
    throw new TypeError('A transformed publication note is required');
  }
  if (typeof note.publishId !== 'string' || note.publishId === '') {
    throw new TypeError('A transformed note with publishId is required');
  }

  const isRepublish = typeof previousState?.publishedAt === 'string';
  const confirmedTimestamp = canonicalTimestamp(confirmedAt);
  const publishedAt = isRepublish
    ? canonicalTimestamp(previousState.publishedAt)
    : confirmedTimestamp;
  const updatedAt = isRepublish ? confirmedTimestamp : undefined;
  const frontmatter = publicFrontmatter(note, { publishedAt, updatedAt });
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 });

  return {
    publishId: note.publishId,
    title: frontmatter.title,
    publishedAt,
    updatedAt,
    markdown: `---\n${yaml}---\n${note.body}`,
  };
}
