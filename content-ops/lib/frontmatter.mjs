function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => stripQuotes(item.trim())).filter(Boolean);
  }
  return stripQuotes(value);
}

function stripQuotes(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function serializeString(value) {
  const stringValue = String(value ?? '');
  if (stringValue.trim() !== stringValue || /: |#|["'[\]{}\r\n]/.test(stringValue)) {
    return JSON.stringify(stringValue);
  }
  return stringValue;
}

function serializeValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeString(item)).join(', ')}]`;
  }
  return serializeString(value);
}

export function parseFrontmatter(block) {
  const data = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1);
    data[key] = parseValue(value);
  }
  return data;
}

export function parseMarkdown(source) {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { data: {}, body: source };
  }
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new Error('Malformed frontmatter: missing closing delimiter');
  }
  const body = source.slice(match[0].length);
  return { data: parseFrontmatter(match[1]), body };
}

export function serializeMarkdown(data, body) {
  const lines = Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${serializeValue(value)}`);
  const normalizedBody = body.startsWith('\n') ? body.slice(1) : body;
  return `---\n${lines.join('\n')}\n---\n\n${normalizedBody}`;
}
