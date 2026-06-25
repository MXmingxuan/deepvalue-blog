function ok(id, label, message = '通过') {
  return { id, label, status: 'ok', message };
}

function warn(id, label, message) {
  return { id, label, status: 'warn', message };
}

function error(id, label, message) {
  return { id, label, status: 'error', message };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDate(value) {
  if (!isNonEmptyString(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function hasReadableBody(body) {
  return typeof body === 'string' && body.trim().length > 0;
}

export function validateItem(item) {
  const data = item.data ?? {};
  const body = item.body ?? '';
  const checks = [];

  checks.push(isNonEmptyString(data.title)
    ? ok('title', '标题')
    : error('title', '标题', '缺少 title'));

  if (item.contentType === 'blog') {
    checks.push(isValidDate(data.date)
      ? ok('date', '日期')
      : error('date', '日期', '缺少有效 date'));

    checks.push(isNonEmptyString(data.description)
      ? ok('description', '描述')
      : warn('description', '描述', '建议补充 description，方便列表和 SEO 展示'));

    checks.push(Array.isArray(data.tags)
      ? ok('tags', '标签')
      : warn('tags', '标签', '建议使用 tags 数组'));

    checks.push(Array.isArray(data.categories)
      ? ok('categories', '分类')
      : warn('categories', '分类', '建议使用 categories 数组'));
  }

  if (item.contentType === 'project') {
    checks.push(isNonEmptyString(data.description)
      ? ok('description', '描述')
      : error('description', '描述', '项目缺少 description'));
  }

  checks.push(hasReadableBody(body)
    ? ok('body', '正文')
    : error('body', '正文', '正文为空'));

  return checks;
}

export function inferWorkflowStatus({ storedStatus, checks }) {
  if (storedStatus) return storedStatus;
  if (checks.some((check) => check.status === 'error')) return 'needs-check';
  if (checks.some((check) => check.status === 'warn')) return 'needs-check';
  return 'ready';
}
