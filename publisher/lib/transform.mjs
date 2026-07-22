import path from 'node:path';

import {
  AssetPipelineError,
  createAssetDescriptor,
} from './assets.mjs';
import { resolvePublishIdentity } from './identity.mjs';
import {
  VaultIndexError,
  resolveNoteLink,
} from './vault-index.mjs';

const CALLOUT_LABELS = Object.freeze({
  abstract: 'Abstract',
  attention: 'Attention',
  bug: 'Bug',
  caution: 'Caution',
  check: 'Success',
  cite: 'Cite',
  danger: 'Danger',
  done: 'Success',
  error: 'Error',
  example: 'Example',
  failure: 'Failure',
  fail: 'Failure',
  faq: 'Question',
  help: 'Question',
  important: 'Important',
  info: 'Info',
  missing: 'Failure',
  note: 'Note',
  question: 'Question',
  quote: 'Quote',
  success: 'Success',
  summary: 'Summary',
  tip: 'Tip',
  tldr: 'Summary',
  todo: 'Todo',
  warning: 'Warning',
});

function diagnostic(filename, field, message, code, details = {}) {
  return { filename, field, message, ...(code ? { code } : {}), ...details };
}

function encodeUrlSegment(value) {
  return encodeURIComponent(value);
}

function splitLineEnding(line) {
  if (line.endsWith('\r\n')) return { text: line.slice(0, -2), ending: '\r\n' };
  if (line.endsWith('\n')) return { text: line.slice(0, -1), ending: '\n' };
  return { text: line, ending: '' };
}

function bodyLines(body) {
  const lines = body.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function fenceMarker(line) {
  const match = line.match(/^(?: {0,3})(?:>\s*)*(`{3,}|~{3,})/u);
  return match?.[1];
}

function isClosingFence(line, openFence) {
  const marker = fenceMarker(line);
  return Boolean(
    marker
    && marker[0] === openFence[0]
    && marker.length >= openFence.length
    && new RegExp(`^(?: {0,3})(?:>\\s*)*${openFence[0] === '`' ? '`' : '~'}{${openFence.length},}\\s*$`, 'u').test(line),
  );
}

function stableCalloutLabel(type) {
  const normalized = type.toLocaleLowerCase('en-US');
  if (CALLOUT_LABELS[normalized]) return CALLOUT_LABELS[normalized];
  return normalized
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase('en-US')}${part.slice(1)}`)
    .join(' ') || 'Note';
}

function escapeMarkdownText(value) {
  return String(value).replace(/[\\[\]*_]/gu, '\\$&');
}

function transformCalloutHeader(line) {
  const match = line.match(/^(\s{0,3}>\s*)\[!([\p{Letter}\p{Number}_-]+)\][+-]?(?:[ \t]+(.*?))?[ \t]*$/u);
  if (!match) return line;
  const [, prefix, type, rawTitle = ''] = match;
  const label = stableCalloutLabel(type);
  const title = rawTitle.trim();
  return title
    ? `${prefix}**${label}: ${escapeMarkdownText(title)}**`
    : `${prefix}**${label}:**`;
}

function visibleWikiLabel(target, alias) {
  if (typeof alias === 'string' && alias.trim() !== '') return alias.trim();
  const noteTarget = target.split('#', 1)[0].trim().replaceAll('\\', '/');
  const basename = path.posix.basename(noteTarget).replace(/\.md$/iu, '');
  return basename || 'Note';
}

function imageAlt(reference, alias) {
  const candidate = typeof alias === 'string' ? alias.trim() : '';
  if (candidate !== '' && !/^\d+(?:x\d+)?$/iu.test(candidate)) return escapeMarkdownText(candidate);
  const basename = path.posix.basename(reference.replaceAll('\\', '/'));
  return escapeMarkdownText(basename.slice(0, -path.posix.extname(basename).length) || 'image');
}

function collectHashtags(segment, tags) {
  const masked = segment
    .replace(/!?\[\[[^\]\r\n]+\]\]/gu, (value) => ' '.repeat(value.length))
    .replace(/\]\([^\)\r\n]*\)/gu, (value) => ' '.repeat(value.length))
    .replace(/<(?:https?:\/\/|ftp:\/\/|www\.)[^>]+>/giu, (value) => ' '.repeat(value.length))
    .replace(/(?:https?:\/\/|ftp:\/\/|www\.)[^\s<]+/giu, (value) => ' '.repeat(value.length));
  const hashtagPattern = /(^|[^\p{Letter}\p{Number}_/#])#([\p{Letter}\p{Number}_](?:[\p{Letter}\p{Number}_/-]*[\p{Letter}\p{Number}_])?)/gu;
  for (const match of masked.matchAll(hashtagPattern)) tags.push(match[2]);
}

function toTransformError(error, filename, reference) {
  if (error instanceof TransformError) return error;
  if (error instanceof AssetPipelineError || error instanceof VaultIndexError) {
    return new TransformError(error.diagnostics.map((item) => ({
      ...item,
      filename,
      ...(reference !== undefined ? { reference } : {}),
    })), error);
  }
  return error;
}

async function replaceWikiSyntax(segment, context) {
  const pattern = /(!)?\[\[([^\]\r\n]+?)\]\]/gu;
  let result = '';
  let cursor = 0;

  for (const match of segment.matchAll(pattern)) {
    result += segment.slice(cursor, match.index);
    const original = match[0];
    const embedded = match[1] === '!';
    const inner = match[2];
    const separator = inner.indexOf('|');
    const target = (separator === -1 ? inner : inner.slice(0, separator)).trim();
    const alias = separator === -1 ? undefined : inner.slice(separator + 1).trim();

    if (embedded) {
      let asset;
      try {
        asset = await createAssetDescriptor({
          assetIndex: context.assetIndex,
          reference: target,
          publishId: context.publishId,
          filename: context.filename,
        });
      } catch (error) {
        throw toTransformError(error, context.filename, target);
      }
      const existing = context.assetsByOutputName.get(asset.outputName);
      if (existing && (existing.sourcePath !== asset.sourcePath || existing.sourceHash !== asset.sourceHash)) {
        throw new TransformError([
          diagnostic(
            context.filename,
            'embed',
            `Image embed "${target}" collides with another deterministic asset name`,
            'asset_name_collision',
            { reference: target },
          ),
        ]);
      }
      if (!existing) {
        context.assets.push(asset);
        context.assetsByOutputName.set(asset.outputName, asset);
      }
      result += `![${imageAlt(target, alias)}](${asset.publicUrl})`;
    } else if (target.startsWith('#')) {
      // A same-note heading link has no Vault note target. Preserve it verbatim.
      result += original;
    } else {
      let resolved;
      try {
        resolved = resolveNoteLink(context.vaultIndex, target);
      } catch (error) {
        throw toTransformError(error, context.filename, target);
      }
      const label = escapeMarkdownText(visibleWikiLabel(target, alias));
      result += resolved?.eligible && context.publicPublishIds.has(resolved.publishId)
        ? `[${label}](/blog/${encodeUrlSegment(resolved.publishId)}/)`
        : label;
    }
    cursor = match.index + original.length;
  }
  result += segment.slice(cursor);
  return result;
}

async function transformOutsideInlineCode(line, context) {
  let result = '';
  let cursor = 0;

  while (cursor < line.length) {
    const opening = line.indexOf('`', cursor);
    if (opening === -1) {
      const segment = line.slice(cursor);
      if (context.includeInlineHashtags) collectHashtags(segment, context.inlineTags);
      result += await replaceWikiSyntax(segment, context);
      break;
    }

    const before = line.slice(cursor, opening);
    if (context.includeInlineHashtags) collectHashtags(before, context.inlineTags);
    result += await replaceWikiSyntax(before, context);

    let runLength = 1;
    while (line[opening + runLength] === '`') runLength += 1;
    const marker = '`'.repeat(runLength);
    const closing = line.indexOf(marker, opening + runLength);
    if (closing === -1) {
      result += line.slice(opening);
      break;
    }
    result += line.slice(opening, closing + runLength);
    cursor = closing + runLength;
  }

  return result;
}

export class TransformError extends Error {
  constructor(diagnostics, cause) {
    super(diagnostics.map(({ filename, field, message }) => `${filename}: ${field}: ${message}`).join('\n'), {
      cause,
    });
    this.name = 'TransformError';
    this.diagnostics = diagnostics;
  }
}

export async function transformNote({
  note,
  vaultIndex,
  assetIndex,
  includeInlineHashtags = true,
  publicPublishIds = [],
} = {}) {
  if (!note || typeof note !== 'object' || typeof note.body !== 'string') {
    throw new TypeError('A parsed Vault note is required for transformation');
  }
  const filename = typeof note.sourcePath === 'string' ? note.sourcePath : '<note>';
  if (note.eligible === false || note.data?.publish !== true) {
    throw new TransformError([
      diagnostic(filename, 'publish', 'Only notes with the YAML boolean publish: true may be transformed', 'not_publishable'),
    ]);
  }
  if (!vaultIndex) throw new TypeError('A Vault index is required for transformation');
  if (!assetIndex) throw new TypeError('An asset index is required for transformation');
  if (typeof includeInlineHashtags !== 'boolean') {
    throw new TypeError('includeInlineHashtags must be a boolean');
  }
  if (!Array.isArray(publicPublishIds) && !(publicPublishIds instanceof Set)) {
    throw new TypeError('publicPublishIds must be an array or Set of confirmed publish IDs');
  }

  const identity = note.publishId
    ? { publishId: note.publishId }
    : resolvePublishIdentity({ data: note.data, body: note.body, sourcePath: filename });
  const context = {
    filename,
    publishId: identity.publishId,
    vaultIndex,
    assetIndex,
    includeInlineHashtags,
    publicPublishIds: new Set(publicPublishIds),
    inlineTags: [],
    assets: [],
    assetsByOutputName: new Map(),
  };

  const transformedLines = [];
  let openFence;
  for (const line of bodyLines(note.body)) {
    const { text, ending } = splitLineEnding(line);
    if (openFence) {
      transformedLines.push(line);
      if (isClosingFence(text, openFence)) openFence = undefined;
      continue;
    }

    const marker = fenceMarker(text);
    if (marker) {
      openFence = marker;
      transformedLines.push(line);
      continue;
    }

    const calloutLine = transformCalloutHeader(text);
    transformedLines.push(`${await transformOutsideInlineCode(calloutLine, context)}${ending}`);
  }

  const data = structuredClone(note.data ?? {});
  const existingTags = Array.isArray(data.tags) ? [...data.tags] : [];
  if (includeInlineHashtags) {
    const seen = new Set(existingTags);
    for (const tag of context.inlineTags) {
      if (!seen.has(tag)) {
        existingTags.push(tag);
        seen.add(tag);
      }
    }
  }
  data.tags = existingTags;

  return {
    sourcePath: filename,
    ...(typeof note.sourceHash === 'string' ? { sourceHash: note.sourceHash } : {}),
    eligible: true,
    publishId: identity.publishId,
    generatedPublishId: note.generatedPublishId ?? !note.publishId,
    ...(note.suggestedField ? { suggestedField: note.suggestedField } : {}),
    data,
    body: transformedLines.join(''),
    assets: context.assets,
  };
}
