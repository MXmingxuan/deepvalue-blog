import matter from 'gray-matter';
import { parse as parseYaml } from 'yaml';

const ARRAY_FIELDS = ['tags', 'commodities', 'companies', 'tickers'];
const OPTIONAL_STRING_FIELDS = [
  'publish_id',
  'section',
  'topic',
  'title',
  'summary',
  'source_title',
  'source_url',
  'thesis',
  'confidence',
];

function diagnostic(filename, field, message, code) {
  return { filename, field, message, ...(code ? { code } : {}) };
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return normalized === '' ? undefined : normalized;
}

function normalizeStringArray(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => (typeof item === 'string' ? item.trim() : item))
    .filter((item) => item !== '');
}

export class FrontmatterParseError extends Error {
  constructor(diagnostics, cause) {
    super(diagnostics.map(({ filename, field, message }) => `${filename}: ${field}: ${message}`).join('\n'), {
      cause,
    });
    this.name = 'FrontmatterParseError';
    this.diagnostics = diagnostics;
  }
}

export function isPublishEligible(frontmatter) {
  return frontmatter?.publish === true;
}

export function normalizeFrontmatter(frontmatter = {}) {
  const source = frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
    ? frontmatter
    : {};
  const normalized = {
    publish: source.publish,
    publish_id: source.publish_id,
    domain: source.domain,
    section: source.section,
    topic: source.topic,
    format: source.format,
    source_type: source.source_type,
    title: source.title,
    summary: source.summary,
    source_title: source.source_title,
    source_url: source.source_url,
    tags: source.tags,
    commodities: source.commodities,
    companies: source.companies,
    tickers: source.tickers,
    thesis: source.thesis,
    confidence: source.confidence,
  };

  for (const field of OPTIONAL_STRING_FIELDS) {
    normalized[field] = normalizeOptionalString(normalized[field]);
  }
  normalized.domain = normalizeOptionalString(normalized.domain);
  normalized.format = normalizeOptionalString(normalized.format);
  normalized.source_type = normalizeOptionalString(normalized.source_type) ?? 'original';

  for (const field of ARRAY_FIELDS) {
    normalized[field] = normalizeStringArray(normalized[field]);
  }

  return normalized;
}

export function parseNoteMarkdown(source, { filename = '<note>' } = {}) {
  if (typeof source !== 'string') {
    throw new FrontmatterParseError([
      diagnostic(filename, '<frontmatter>', 'Markdown source must be a string', 'invalid_source'),
    ]);
  }

  if (/^---\r?\n/.test(source) && !/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(source)) {
    throw new FrontmatterParseError([
      diagnostic(filename, '<frontmatter>', 'YAML frontmatter is missing its closing delimiter', 'malformed_frontmatter'),
    ]);
  }

  let parsed;
  try {
    parsed = matter(source, {
      engines: {
        yaml: (yamlSource) => parseYaml(yamlSource),
      },
      language: 'yaml',
    });
  } catch (error) {
    throw new FrontmatterParseError([
      diagnostic(filename, '<frontmatter>', `Could not parse YAML frontmatter: ${error.message}`, 'invalid_yaml'),
    ], error);
  }

  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new FrontmatterParseError([
      diagnostic(filename, '<frontmatter>', 'YAML frontmatter must be a mapping', 'invalid_yaml'),
    ]);
  }

  const data = normalizeFrontmatter(parsed.data);
  return {
    data,
    body: parsed.content,
    eligible: isPublishEligible(data),
  };
}
