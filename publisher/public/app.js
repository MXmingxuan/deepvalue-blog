const stateElement = document.querySelector('#publisher-data');
const state = JSON.parse(stateElement.textContent);

const publicationList = document.querySelector('#publication-list');
const fileList = document.querySelector('#file-list');
const status = document.querySelector('#publisher-status');
const actionButtons = [...document.querySelectorAll('[data-action]')];

function textElement(tagName, className, value) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = value;
  return element;
}

for (const publication of state.manifest.publications ?? []) {
  const item = document.createElement('li');
  item.className = 'publication-item';
  item.append(
    textElement('strong', 'publication-title', publication.title || publication.publishId),
    textElement('span', 'source-path', publication.sourcePath),
  );
  publicationList.append(item);
}

for (const file of state.manifest.files ?? []) {
  const item = document.createElement('li');
  item.className = 'file-item';
  const summary = document.createElement('div');
  summary.className = 'file-summary';
  summary.append(
    textElement('span', 'file-kind', file.operation || file.kind),
    textElement('span', 'file-path', file.targetPath),
  );
  item.append(summary);
  if (file.beforeSha256) {
    item.append(textElement('code', 'file-hash', `before sha256:${file.beforeSha256}`));
  }
  item.append(textElement('code', 'file-hash', `after sha256:${file.sha256}`));
  fileList.append(item);
}

document.querySelector('#publication-count').textContent = `${state.manifest.publications?.length ?? 0} NOTES`;
document.querySelector('#file-count').textContent = `${state.manifest.files?.length ?? 0} FILES`;
document.querySelector('#target-route').textContent = state.route;
document.querySelector('#target-preview').src = state.previewRoute;

const pushButton = document.querySelector('[data-action="confirm-push"]');
if (!state.allowPush) pushButton.hidden = true;

function lockActions() {
  for (const button of actionButtons) button.disabled = true;
}

async function performAction(action) {
  lockActions();
  status.textContent = action === 'cancel' ? '正在取消并清理临时事务…' : '正在应用、构建并创建精确提交…';
  try {
    const response = await fetch(`/_publisher/action/${action}`, {
      method: 'POST',
      headers: { 'x-publisher-token': state.token },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Publisher action failed (${response.status})`);
    status.textContent = action === 'cancel'
      ? '发布已取消。临时事务已清理，仓库未应用发布内容。'
      : result.result?.pushed
        ? '发布提交已创建并推送。'
        : '发布提交已创建，未执行推送。';
  } catch (error) {
    status.textContent = `操作失败：${error.message}。请查看终端中的恢复指引。`;
  }
}

for (const button of actionButtons) {
  button.addEventListener('click', () => performAction(button.dataset.action), { once: true });
}
