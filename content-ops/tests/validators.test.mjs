import test from 'node:test';
import assert from 'node:assert/strict';
import { validateItem, inferWorkflowStatus } from '../lib/validators.mjs';

test('validateItem accepts complete blog metadata', () => {
  const checks = validateItem({
    contentType: 'blog',
    data: {
      title: '赛道研究：氢能',
      date: '2026-06-18',
      tags: ['氢能'],
      categories: ['产业研究'],
      description: '氢能产业研究'
    },
    body: '# 正文\n'
  });
  assert.equal(checks.every((check) => check.status === 'ok'), true);
});

test('validateItem reports missing description as warning for blog', () => {
  const checks = validateItem({
    contentType: 'blog',
    data: { title: '事件点评：轮胎涨价', date: '2026-06-16', tags: ['事件点评'] },
    body: '# 正文\n'
  });
  assert.deepEqual(checks.find((check) => check.id === 'description'), {
    id: 'description',
    label: '描述',
    status: 'warn',
    message: '建议补充 description，方便列表和 SEO 展示'
  });
});

test('validateItem reports required project description as error', () => {
  const checks = validateItem({
    contentType: 'project',
    data: { title: '期货分析系统' },
    body: '# 项目\n'
  });
  assert.deepEqual(checks.find((check) => check.id === 'description'), {
    id: 'description',
    label: '描述',
    status: 'error',
    message: '项目缺少 description'
  });
});

test('validateItem reports empty body as error', () => {
  const checks = validateItem({
    contentType: 'blog',
    data: { title: '测试', date: '2026-06-18' },
    body: '   \n'
  });
  assert.equal(checks.find((check) => check.id === 'body').status, 'error');
});

test('inferWorkflowStatus uses stored status before validation-derived status', () => {
  assert.equal(inferWorkflowStatus({ storedStatus: 'draft', checks: [] }), 'draft');
});

test('inferWorkflowStatus returns needs-check when required check fails', () => {
  assert.equal(inferWorkflowStatus({
    storedStatus: undefined,
    checks: [{ id: 'title', status: 'error' }]
  }), 'needs-check');
});

test('inferWorkflowStatus returns ready when checks all pass', () => {
  assert.equal(inferWorkflowStatus({
    storedStatus: undefined,
    checks: [{ id: 'title', status: 'ok' }]
  }), 'ready');
});
