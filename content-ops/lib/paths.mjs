import path from 'node:path';

export function createPathTools(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);

  function assertInside(absolutePath) {
    const resolved = path.resolve(absolutePath);
    const relative = path.relative(root, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return resolved;
    }
    throw new Error(`Path escapes project root: ${absolutePath}`);
  }

  function resolveInside(relativePath) {
    return assertInside(path.join(root, relativePath));
  }

  function toRelativeContentPath(absolutePath) {
    const inside = assertInside(absolutePath);
    return path.relative(root, inside).split(path.sep).join('/');
  }

  function contentIdFromRelative(relativePath) {
    return relativePath.split(path.sep).join('/');
  }

  return { root, assertInside, resolveInside, toRelativeContentPath, contentIdFromRelative };
}
