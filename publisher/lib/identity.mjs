import { createHash } from 'node:crypto';
import path from 'node:path';

const MAX_READABLE_LENGTH = 72;

function readableSlug(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/['’]/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  return Array.from(normalized).slice(0, MAX_READABLE_LENGTH).join('').replace(/-+$/g, '');
}

function sourceFilename(sourcePath) {
  const portablePath = String(sourcePath ?? '').replaceAll('\\', '/');
  return path.posix.basename(portablePath).replace(/\.md$/iu, '');
}

function identityHash(sourcePath, readable) {
  const sourceKey = String(sourcePath ?? '').replaceAll('\\', '/').normalize('NFC');
  return createHash('sha256')
    .update(`${sourceKey}\0${readable}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
}

export function resolvePublishIdentity({ data = {}, sourcePath = '' } = {}) {
  if (typeof data.publish_id === 'string' && data.publish_id.trim() !== '') {
    return {
      publishId: data.publish_id,
      generated: false,
      suggestedField: undefined,
    };
  }

  const readable = readableSlug(data.title) || readableSlug(sourceFilename(sourcePath)) || 'entry';
  const publishId = `${readable}-${identityHash(sourcePath, readable)}`;

  return {
    publishId,
    generated: true,
    suggestedField: `publish_id: ${publishId}`,
  };
}
