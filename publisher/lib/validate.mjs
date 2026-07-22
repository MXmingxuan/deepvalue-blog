export const DOMAINS = Object.freeze(['investment', 'ai', 'beyond']);
export const FORMATS = Object.freeze(['article', 'log']);
export const SOURCE_TYPES = Object.freeze(['original', 'book', 'podcast', 'report', 'news', 'mixed']);
export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const INVESTMENT_SECTIONS = Object.freeze([
  'commodities',
  'industries-companies',
  'macro-cycles',
  'markets-trading',
]);

const PUBLISH_ID_PATTERN = /^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u;
const ARRAY_FIELDS = ['tags', 'commodities', 'companies', 'tickers'];

function diagnostic(filename, field, message, code) {
  return { filename, field, message, ...(code ? { code } : {}) };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateEnum(diagnostics, { filename, field, value, allowed, optional = false }) {
  if (optional && (value === undefined || value === null || value === '')) return;
  if (!allowed.includes(value)) {
    diagnostics.push(diagnostic(
      filename,
      field,
      `${field} must be one of: ${allowed.join(', ')}`,
      'invalid_enum',
    ));
  }
}

function validateOptionalString(diagnostics, filename, field, value) {
  if (value === undefined || value === null || value === '') return;
  if (!isNonEmptyString(value)) {
    diagnostics.push(diagnostic(filename, field, `${field} must be a non-empty string`, 'invalid_type'));
  }
}

function validateUrl(diagnostics, filename, value) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    diagnostics.push(diagnostic(filename, 'source_url', 'source_url must be a valid URL', 'invalid_url'));
    return;
  }

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('URL must use HTTP or HTTPS');
    }
  } catch {
    diagnostics.push(diagnostic(filename, 'source_url', 'source_url must be an absolute HTTP(S) URL', 'invalid_url'));
  }
}

export class PublicationValidationError extends Error {
  constructor(diagnostics) {
    super(diagnostics.map(({ filename, field, message }) => `${filename}: ${field}: ${message}`).join('\n'));
    this.name = 'PublicationValidationError';
    this.diagnostics = diagnostics;
  }
}

export function validatePublicationNote({ filename = '<note>', data = {}, body = '' } = {}) {
  const diagnostics = [];
  const metadata = data && typeof data === 'object' && !Array.isArray(data) ? data : {};

  if (metadata.publish !== true) {
    diagnostics.push(diagnostic(
      filename,
      'publish',
      'publish must be the YAML boolean true for publication',
      'not_publishable',
    ));
  }

  if (metadata.publish_id !== undefined && metadata.publish_id !== null) {
    if (!isNonEmptyString(metadata.publish_id) || !PUBLISH_ID_PATTERN.test(metadata.publish_id)) {
      diagnostics.push(diagnostic(
        filename,
        'publish_id',
        'publish_id must contain only letters or numbers separated by single hyphens',
        'invalid_publish_id',
      ));
    }
  }

  validateEnum(diagnostics, {
    filename,
    field: 'domain',
    value: metadata.domain,
    allowed: DOMAINS,
  });
  validateEnum(diagnostics, {
    filename,
    field: 'format',
    value: metadata.format,
    allowed: FORMATS,
  });
  validateEnum(diagnostics, {
    filename,
    field: 'source_type',
    value: metadata.source_type ?? 'original',
    allowed: SOURCE_TYPES,
  });
  validateEnum(diagnostics, {
    filename,
    field: 'confidence',
    value: metadata.confidence,
    allowed: CONFIDENCE_LEVELS,
    optional: true,
  });

  if (metadata.format === 'article') {
    if (!isNonEmptyString(metadata.title)) {
      diagnostics.push(diagnostic(filename, 'title', 'Articles require a non-empty title', 'required'));
    }
    if (!isNonEmptyString(metadata.summary)) {
      diagnostics.push(diagnostic(filename, 'summary', 'Articles require a non-empty summary', 'required'));
    }
    if (!isNonEmptyString(metadata.section)) {
      diagnostics.push(diagnostic(filename, 'section', 'Articles require a non-empty section', 'required'));
    }
  } else {
    validateOptionalString(diagnostics, filename, 'title', metadata.title);
    validateOptionalString(diagnostics, filename, 'summary', metadata.summary);
    validateOptionalString(diagnostics, filename, 'section', metadata.section);
  }

  if (isNonEmptyString(metadata.section)) {
    if (metadata.domain === 'investment' && !INVESTMENT_SECTIONS.includes(metadata.section)) {
      diagnostics.push(diagnostic(
        filename,
        'section',
        `Investment section must be one of: ${INVESTMENT_SECTIONS.join(', ')}`,
        'invalid_section',
      ));
    } else if (
      DOMAINS.includes(metadata.domain)
      && metadata.domain !== 'investment'
      && INVESTMENT_SECTIONS.includes(metadata.section)
    ) {
      diagnostics.push(diagnostic(
        filename,
        'section',
        `Section ${metadata.section} is reserved for the investment domain`,
        'invalid_section',
      ));
    }
  }

  validateOptionalString(diagnostics, filename, 'topic', metadata.topic);
  validateOptionalString(diagnostics, filename, 'source_title', metadata.source_title);
  validateOptionalString(diagnostics, filename, 'thesis', metadata.thesis);
  validateUrl(diagnostics, filename, metadata.source_url);

  for (const field of ARRAY_FIELDS) {
    const value = metadata[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      diagnostics.push(diagnostic(filename, field, `${field} must be an array of strings`, 'invalid_type'));
      continue;
    }
    for (const [index, item] of value.entries()) {
      if (!isNonEmptyString(item)) {
        diagnostics.push(diagnostic(
          filename,
          `${field}[${index}]`,
          `${field} entries must be non-empty strings`,
          'invalid_type',
        ));
      }
    }
  }

  if (!isNonEmptyString(body)) {
    diagnostics.push(diagnostic(filename, 'body', 'Publication body must not be empty', 'required'));
  }

  return diagnostics;
}

export function assertValidPublicationNote(note) {
  const diagnostics = validatePublicationNote(note);
  if (diagnostics.length > 0) throw new PublicationValidationError(diagnostics);
  return note;
}
