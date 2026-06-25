const state = {
  items: [],
  filter: 'all',
  selected: null,
  loading: false
};

const labels = {
  all: '全部内容',
  inbox: '收件箱',
  draft: '草稿',
  'needs-check': '待检查',
  ready: '可发布',
  published: '已发布',
  archived: '归档'
};

const statusLabels = {
  inbox: '收件箱',
  draft: '草稿',
  'needs-check': '待检查',
  ready: '可发布',
  published: '已发布',
  archived: '归档'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showMessage(text) {
  const node = document.querySelector('#message');
  node.textContent = text;
  node.hidden = !text;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? '请求失败');
  }
  return payload;
}

function itemSearchText(item) {
  return [
    item.data.title,
    item.data.description,
    item.relativePath,
    item.contentType,
    ...(item.data.tags ?? []),
    ...(item.data.categories ?? []),
    ...(item.data.tech ?? []),
    item.ops?.topic,
    item.ops?.company,
    item.ops?.ticker
  ].filter(Boolean).join(' ').toLowerCase();
}

function filteredItems() {
  const query = document.querySelector('#search').value.trim().toLowerCase();
  return state.items.filter((item) => {
    const matchesFilter = state.filter === 'all' || item.workflowStatus === state.filter;
    return matchesFilter && (!query || itemSearchText(item).includes(query));
  });
}

function renderPipeline() {
  const counts = Object.fromEntries(Object.keys(labels).map((key) => [key, 0]));
  counts.all = state.items.length;
  for (const item of state.items) {
    counts[item.workflowStatus] = (counts[item.workflowStatus] ?? 0) + 1;
  }

  document.querySelector('#pipeline').innerHTML = Object.entries(labels).map(([key, label]) => `
    <div class="navitem ${state.filter === key ? 'active' : ''}" data-filter="${escapeHtml(key)}">
      <span>${escapeHtml(label)}</span>
      <span>${counts[key] ?? 0}</span>
    </div>
  `).join('');

  document.querySelectorAll('[data-filter]').forEach((node) => {
    node.addEventListener('click', () => {
      state.filter = node.dataset.filter;
      render();
    });
  });
}

function renderDashboard() {
  const items = filteredItems();
  document.querySelector('#dashboard').innerHTML = `
    <div class="pagehead">
      <div>
        <p class="label">发布中心</p>
        <h1>文章工作台</h1>
      </div>
      <div class="small">${items.length} / ${state.items.length} 项</div>
    </div>
    <table>
      <thead>
        <tr><th>标题</th><th>状态</th><th>日期</th><th>标签</th><th>检查</th></tr>
      </thead>
      <tbody>
        ${items.map((item) => {
          const tags = item.data.tags ?? item.data.tech ?? [];
          const problems = item.checks.filter((check) => check.status !== 'ok');
          return `
            <tr data-open="${escapeHtml(item.relativePath)}">
              <td>
                <div class="title">${escapeHtml(item.data.title ?? '未命名')}</div>
                <div class="path">${escapeHtml(item.relativePath)}</div>
              </td>
              <td class="status"><span class="dot ${escapeHtml(item.workflowStatus)}"></span>${escapeHtml(statusLabels[item.workflowStatus] ?? item.workflowStatus)}</td>
              <td class="small">${escapeHtml(item.data.date ?? item.contentType)}</td>
              <td>${tags.slice(0, 4).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</td>
              <td class="small">${escapeHtml(problems.map((check) => check.label).join('、') || 'OK')}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  document.querySelectorAll('[data-open]').forEach((row) => {
    row.addEventListener('click', () => openDetail(row.dataset.open));
  });
}

function renderInspector() {
  const problems = state.items.filter((item) => item.checks.some((check) => check.status !== 'ok'));
  const ready = state.items.filter((item) => item.workflowStatus === 'ready');
  const published = state.items.filter((item) => item.workflowStatus === 'published');
  document.querySelector('#inspector').innerHTML = `
    <div class="panel">
      <p class="label">站点健康</p>
      <p>Markdown 文件：${state.items.length}</p>
      <p>待处理：${problems.length}</p>
      <p>可发布：${ready.length}</p>
      <p>已发布：${published.length}</p>
    </div>
    <div class="panel">
      <p class="label">发布检查</p>
      <p>检查 frontmatter</p>
      <p>打开本地预览</p>
      <p>构建并同步</p>
    </div>
    <div class="panel">
      <p class="label">研究入口</p>
      <p>主题、公司、来源字段先作为工具状态保存。</p>
    </div>
  `;
}

function renderPreview(body) {
  return body
    .split('\n')
    .slice(0, 120)
    .map((line) => `<p>${escapeHtml(line) || '&nbsp;'}</p>`)
    .join('');
}

async function openDetail(relativePath) {
  try {
    showMessage('读取文章中...');
    const { item } = await api(`/api/content/item?path=${encodeURIComponent(relativePath)}`);
    state.selected = item;
    document.querySelector('#dashboard').classList.add('hidden');
    document.querySelector('#detail').classList.remove('hidden');
    renderDetail(item);
    showMessage('');
  } catch (error) {
    showMessage(error.message);
  }
}

function renderDetail(item) {
  const title = item.data.title ?? '';
  const description = item.data.description ?? '';
  document.querySelector('#detail').innerHTML = `
    <div class="pagehead">
      <div>
        <p class="label">文章详情</p>
        <h1>${escapeHtml(title || '未命名')}</h1>
        <div class="path">${escapeHtml(item.relativePath)}</div>
      </div>
      <div class="actions">
        <button id="backBtn" type="button">返回</button>
        <button id="openExternalBtn" type="button">外部编辑器打开</button>
        <button id="saveBtn" type="button" class="primary">保存</button>
      </div>
    </div>
    <div class="editorgrid">
      <textarea id="bodyInput" aria-label="Markdown 正文">${escapeHtml(item.body)}</textarea>
      <div class="preview" id="preview">${renderPreview(item.body)}</div>
      <aside>
        <label class="field">标题
          <input id="titleInput" class="search" value="${escapeHtml(title)}">
        </label>
        <label class="field">描述
          <input id="descriptionInput" class="search" value="${escapeHtml(description)}">
        </label>
        <div class="panel">
          <p class="label">标签</p>
          ${(item.data.tags ?? item.data.tech ?? []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') || '<p>暂无标签</p>'}
        </div>
        <div class="panel">
          <p class="label">检查结果</p>
          ${item.checks.map((check) => `
            <div class="check">
              <span>${escapeHtml(check.label)}</span>
              <span>${escapeHtml(check.message)}</span>
            </div>
          `).join('')}
        </div>
      </aside>
    </div>
  `;

  document.querySelector('#backBtn').addEventListener('click', () => {
    document.querySelector('#detail').classList.add('hidden');
    document.querySelector('#dashboard').classList.remove('hidden');
    state.selected = null;
    render();
  });
  document.querySelector('#openExternalBtn').addEventListener('click', () => openExternal(item.relativePath));
  document.querySelector('#saveBtn').addEventListener('click', saveSelected);
  document.querySelector('#bodyInput').addEventListener('input', (event) => {
    document.querySelector('#preview').innerHTML = renderPreview(event.target.value);
  });
}

async function saveSelected() {
  if (!state.selected) return;
  try {
    showMessage('保存中...');
    const nextData = {
      ...state.selected.data,
      title: document.querySelector('#titleInput').value,
      description: document.querySelector('#descriptionInput').value
    };
    const payload = {
      relativePath: state.selected.relativePath,
      data: nextData,
      body: document.querySelector('#bodyInput').value,
      ops: state.selected.ops
    };
    const { item } = await api('/api/content/item', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    state.selected = item;
    await load();
    renderDetail(item);
    showMessage('已保存');
  } catch (error) {
    showMessage(error.message);
  }
}

async function openExternal(relativePath) {
  try {
    showMessage('打开外部编辑器...');
    const { command } = await api('/api/commands/open-external', {
      method: 'POST',
      body: JSON.stringify({ relativePath })
    });
    showMessage(command.status === 'passed' ? '已请求打开外部编辑器' : `打开失败：${command.stderr}`);
  } catch (error) {
    showMessage(error.message);
  }
}

async function runCommand(path, pendingText) {
  try {
    showMessage(pendingText);
    const { command } = await api(path, { method: 'POST' });
    showMessage(`${command.name} ${command.status}，退出码：${command.exitCode}`);
    await load();
  } catch (error) {
    showMessage(error.message);
  }
}

async function load() {
  const payload = await api('/api/content');
  state.items = payload.items;
  render();
}

function render() {
  renderPipeline();
  renderDashboard();
  renderInspector();
}

document.querySelector('#search').addEventListener('input', render);
document.querySelector('#refreshBtn').addEventListener('click', () => load().catch((error) => showMessage(error.message)));
document.querySelector('#buildBtn').addEventListener('click', () => runCommand('/api/commands/build', '构建中...'));
document.querySelector('#syncBtn').addEventListener('click', () => runCommand('/api/commands/sync', '同步中...'));

load().catch((error) => {
  showMessage(error.message);
});
