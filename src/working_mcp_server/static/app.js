'use strict';
const desktop = window.workingDesktop;
let mcpKey = '';
let apiKey = '';
let state = null;
let editing = null;
let pendingAction = null;
let busy = false;
const $ = (id) => document.getElementById(id);
const login = $('login-dialog');
let toastTimer;
function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function request(payload) {
  if (desktop) {
    state = await desktop.request(payload);
    render();
    return state;
  }
  let response;
  try { response = await fetch('/api/state', {
    method: payload ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${apiKey}`, ...(payload ? {'Content-Type': 'application/json'} : {})},
    ...(payload ? {body: JSON.stringify(payload)} : {})
  }); } catch (error) {
    $('connection').textContent = '连接中断';
    $('connection').classList.remove('online');
    throw new Error('无法连接服务器，请检查服务是否运行');
  }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !login.open) disconnect();
    throw new Error(data.error || '请求失败');
  }
  state = data;
  render();
  return data;
}
async function mutate(payload, message) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('[data-mode]').forEach(b => b.disabled = true);
  try { await request(payload); if (message) toast(message); }
  catch (error) { toast(error.message, true); }
  finally { busy = false; document.querySelectorAll('[data-mode]').forEach(b => b.disabled = false); }
}
function actionButton(label, handler, danger = false) {
  const button = element('button', danger ? 'danger' : '', label);
  button.type = 'button';
  button.addEventListener('click', handler);
  return button;
}
function confirm(title, description, action) {
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  pendingAction = action;
  $('confirm-dialog').showModal();
}
function render() {
  $('connection').textContent = '已连接';
  $('connection').classList.add('online');
  $('nav-count').textContent = state.tools.length;
  $('tool-count').textContent = `${state.tools.length} 个工具可用`;
  $('mode-title').textContent = state.read_only ? '只读模式已开启' : '全部工具已开启';
  $('mode-description').textContent = state.read_only ? 'Agent 可以浏览和搜索代码、查看 Git 历史，并切换工作区。' : 'Agent 可以读取、修改代码，执行命令并管理后台进程。';
  document.querySelectorAll('[data-mode]').forEach(button => {
    const selected = (button.dataset.mode === 'true') === state.read_only;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('workspace-count').textContent = state.workspaces.length;
  $('workspaces').replaceChildren();
  for (const workspace of state.workspaces) {
    const card = element('article', 'workspace-card');
    const top = element('div', 'workspace-top');
    top.append(element('span', 'folder', '▱'), element('h3', '', workspace.name));
    if (workspace.id === state.default_workspace) top.append(element('span', 'default-badge', '默认'));
    card.append(top, element('div', 'path-label', 'ABSOLUTE PATH'), element('div', 'workspace-path', workspace.absolute_path));
    const bottom = element('div', 'workspace-bottom');
    bottom.append(element('span', `available ${workspace.exists ? '' : 'missing'}`, workspace.exists ? '● 目录可访问' : '● 目录不存在'));
    const actions = element('div', 'card-actions');
    actions.append(actionButton('重命名', () => openWorkspace(workspace)));
    if (workspace.id !== state.default_workspace) {
      actions.append(actionButton('设为默认', () => mutate({action: 'default', id: workspace.id}, '默认工作区已更新')));
      actions.append(actionButton('移除', () => confirm('移除此工作区？', `“${workspace.name}” 将从配置中移除，磁盘文件不会被删除。使用此工作区的会话将在下次调用时回到默认工作区。`, () => mutate({action: 'remove', id: workspace.id}, '工作区已移除')), true));
    }
    bottom.append(actions); card.append(bottom); $('workspaces').append(card);
  }
  $('tools').replaceChildren();
  for (const tool of state.tools) {
    const card = element('article', 'tool-card');
    card.append(element('h3', '', tool.name), element('p', '', tool.description));
    $('tools').append(card);
  }
  $('processes').replaceChildren();
  if (!state.processes.length) $('processes').append(element('div', 'empty', '暂无托管进程。通过 bash 工具启动的命令会显示在这里。'));
  for (const process of state.processes) {
    const card = element('article', 'process-card');
    card.append(element('span', 'badge', process.status === 'running' ? '运行中' : '已结束'), element('code', '', process.command), element('p', '', `${process.workspace.name} · ${process.id}`));
    $('processes').append(card);
  }
}
function disconnect() {
  apiKey = ''; state = null;
  $('workspaces').replaceChildren(); $('tools').replaceChildren(); $('processes').replaceChildren();
  $('connection').textContent = '未连接'; $('connection').classList.remove('online');
  $('api-key').value = '';
  if (!login.open) login.showModal();
}
function openWorkspace(workspace = null) {
  editing = workspace;
  $('workspace-dialog-title').textContent = workspace ? '重命名工作区' : '添加工作区';
  $('save-workspace').textContent = workspace ? '保存名称' : '添加工作区';
  $('workspace-name').value = workspace?.name || '';
  $('workspace-path').value = '';
  $('workspace-path').required = !workspace;
  $('path-field').hidden = !!workspace;
  $('workspace-error').textContent = '';
  $('workspace-dialog').showModal();
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  apiKey = $('api-key').value;
  const submit = event.submitter; submit.disabled = true;
  $('login-error').textContent = '';
  try { await request(); $('api-key').value = ''; login.close(); }
  catch (error) { apiKey = ''; $('login-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
login.addEventListener('cancel', event => event.preventDefault());
$('logout').addEventListener('click', disconnect);
$('refresh').addEventListener('click', () => request().then(() => toast('状态已刷新')).catch(e => toast(e.message, true)));
$('add-workspace').addEventListener('click', () => openWorkspace());
$('cancel-workspace').addEventListener('click', () => $('workspace-dialog').close());
$('workspace-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try {
    await request(editing ? {action: 'rename', id: editing.id, name: $('workspace-name').value} : {action: 'add', name: $('workspace-name').value, path: $('workspace-path').value});
    $('workspace-dialog').close(); toast(editing ? '名称已更新' : '工作区已添加');
  } catch (error) { $('workspace-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('cancel-confirm').addEventListener('click', () => $('confirm-dialog').close());
$('confirm-form').addEventListener('submit', event => {
  event.preventDefault(); $('confirm-dialog').close(); if (pendingAction) pendingAction(); pendingAction = null;
});
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  const readOnly = button.dataset.mode === 'true';
  if (!state || state.read_only === readOnly) return;
  if (readOnly && state.processes.some(p => p.status === 'running')) {
    confirm('开启只读模式？', '所有托管命令及其子进程将被停止。清理完成后，只读模式才会生效。', () => mutate({action: 'mode', read_only: true}, '只读模式已生效'));
  } else mutate({action: 'mode', read_only: readOnly}, readOnly ? '只读模式已生效' : '全部工具已启用');
}));
const pages = {
  overview: ['工作区与权限', '让 agent 在合适的目录，使用合适的工具。'],
  tools: ['工具目录', '为 agent 准备的编程工具，职责清楚，按需开放。'],
  processes: ['运行进程', '查看服务器托管的命令及其所属工作区。'],
  tunnel: ['ChatGPT 隧道', '通过 OpenAI Secure MCP Tunnel，连接这台电脑上的编程工具。']
};
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  $('mobile-view').value = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button));
  for (const [key, values] of Object.entries(pages)) {
    $(`${key}-view`).hidden = key !== button.dataset.view;
    if (key === button.dataset.view) {
      $('page-title').textContent = values[0]; $('breadcrumb').textContent = values[0]; $('page-description').textContent = values[1];
      if (key === 'tunnel' && desktop) refreshTunnel().catch(error => toast(error.message, true));
    }
  }
}));
$('mobile-view').addEventListener('change', event => document.querySelector(`[data-view="${event.target.value}"]`).click());
$('endpoint').textContent = `${location.origin}/mcp`;
$('copy-endpoint').addEventListener('click', () => copy(`${location.origin}/mcp`).then(() => toast('MCP 地址已复制')).catch(() => toast('无法访问剪贴板，请手动复制地址', true)));
setInterval(() => { if ((apiKey || desktop) && !busy && !document.hidden && !$('workspace-dialog').open && !$('confirm-dialog').open) request().catch(() => {}); }, 10000);
async function copy(text) {
  if (desktop) return desktop.copyText(text);
  return navigator.clipboard.writeText(text);
}
async function loadCredentials() {
  const data = await desktop.credentials();
  mcpKey = data.api_key;
  $('mcp-api-key').value = mcpKey;
}
$('key-reveal').addEventListener('click', () => {
  const reveal = $('mcp-api-key').type === 'password';
  $('mcp-api-key').type = reveal ? 'text' : 'password';
  $('key-reveal').textContent = reveal ? '隐藏' : '显示';
});
$('key-copy').addEventListener('click', () => copy(mcpKey).then(() => toast('MCP API Key 已复制')).catch(e => toast(e.message, true)));
$('key-edit').addEventListener('click', () => {
  $('new-api-key').value = '';
  $('key-error').textContent = '';
  $('key-dialog').showModal();
});
$('key-cancel').addEventListener('click', () => $('key-dialog').close());
async function saveKey(payload) {
  const buttons = $('key-form').querySelectorAll('button');
  buttons.forEach(button => button.disabled = true);
  try {
    const data = await desktop.setApiKey(payload);
    mcpKey = data.api_key;
    $('mcp-api-key').value = mcpKey;
    $('new-api-key').value = '';
    $('key-dialog').close();
    toast('密钥已更新，旧密钥已失效');
  } catch (error) { $('key-error').textContent = error.message; }
  finally { buttons.forEach(button => button.disabled = false); }
}
$('key-form').addEventListener('submit', event => { event.preventDefault(); saveKey({api_key: $('new-api-key').value}); });
$('key-generate').addEventListener('click', () => saveKey({generate: true}));
$('browse-directory').addEventListener('click', async () => {
  try {
    const directory = await desktop.chooseDirectory();
    if (directory) {
      $('workspace-path').value = directory;
      if (!$('workspace-name').value) $('workspace-name').value = directory.replace(/[\\/]$/, '').split(/[\\/]/).pop();
    }
  } catch (error) { $('workspace-error').textContent = error.message; }
});
if (desktop) {
  $('logout').hidden = true;
  $('desktop-settings').hidden = false;
  $('browse-directory').hidden = false;
  Promise.all([request(), loadCredentials(), initializeTunnel()]).catch(error => toast(error.message, true));
} else login.showModal();

let tunnelState = null;
let tunnelBusy = false;
async function refreshTunnel(fill = false) {
  if (!desktop) return;
  tunnelState = await desktop.tunnel('state');
  const labels = {stopped:'已停止', connecting:'连接中', ready:'隧道已就绪', error:'需要处理', stopping:'正在停止'};
  $('tunnel-status').textContent = tunnelState.tunnelId ? labels[tunnelState.phase] || tunnelState.phase : '未配置';
  $('tunnel-guide-id').textContent = tunnelState.tunnelId || '你的 Tunnel ID';
  $('tunnel-client-state').textContent = tunnelState.available ? '官方 tunnel-client 已内置，无需安装命令行工具。' : '当前缺少 tunnel-client，请使用完整安装包。开发模式可运行 npm run tunnel:fetch。';
  $('tunnel-message').textContent = tunnelState.message || '保存配置后，点击启动隧道。';
  $('tunnel-health').textContent = `● 客户端健康：${tunnelState.healthy ? '正常' : '未确认'}`;
  $('tunnel-ready').textContent = `● 隧道就绪：${tunnelState.ready ? '已就绪' : '未就绪'}`;
  $('tunnel-logs').textContent = tunnelState.logs || '暂无日志。';
  $('tunnel-key-state').textContent = tunnelState.hasRuntimeKey ? (tunnelState.remembered ? '运行密钥已加密保存。留空保留原密钥。' : '运行密钥仅保留在本次应用内存中。留空保留。') : '请输入具有 Tunnels Read + Use 权限的 OpenAI 运行 API Key。';
  if (fill) {
    $('tunnel-id').value = tunnelState.tunnelId;
    $('tunnel-remember').checked = tunnelState.remembered;
    $('tunnel-auto').checked = tunnelState.autoStart;
  }
  const running = tunnelState.running;
  for (const id of ['tunnel-id','tunnel-runtime-key','tunnel-auto','tunnel-remember','tunnel-save']) $(id).disabled = running || tunnelBusy;
  if (!tunnelState.canRemember) {
    $('tunnel-remember').disabled = true; $('tunnel-auto').disabled = true;
    $('tunnel-remember').checked = false; $('tunnel-auto').checked = false;
  }
  $('tunnel-start').disabled = running || tunnelBusy || !tunnelState.available;
  $('tunnel-stop').disabled = tunnelBusy || !running;
  $('tunnel-doctor').disabled = tunnelBusy || !tunnelState.available || !tunnelState.hasRuntimeKey;
}
async function initializeTunnel() {
  $('tunnel-nav').hidden = false;
  $('tunnel-mobile-option').hidden = false;
  await refreshTunnel(true);
}
async function saveTunnel() {
  const result = await desktop.tunnel('save', {tunnelId:$('tunnel-id').value.trim(), runtimeKey:$('tunnel-runtime-key').value,
    remember:$('tunnel-remember').checked, autoStart:$('tunnel-auto').checked});
  $('tunnel-runtime-key').value = '';
  return result;
}
async function tunnelAction(action) {
  if (tunnelBusy) return;
  tunnelBusy = true;
  $('tunnel-error').textContent = '';
  document.querySelectorAll('.tunnel-buttons button, #tunnel-form input').forEach(button => button.disabled = true);
  try {
    if (action === 'save' || action === 'start') await saveTunnel();
    if (action === 'start') await desktop.tunnel('start');
    if (action === 'stop') await desktop.tunnel('stop');
    if (action === 'doctor') {
      $('tunnel-diagnostics').textContent = '诊断中，请等待（最长约 45 秒）…';
      const report = await desktop.tunnel('doctor');
      $('tunnel-diagnostics').textContent = `${report.timedOut ? '诊断超时' : '退出状态：' + report.exitCode}\n${report.output}`;
      if (report.exitCode === 0) $('tunnel-diagnostics').textContent += '\n配置诊断通过不代表云端已授权；请继续检查隧道就绪状态，并在 ChatGPT 调用工具验证。';
      if (report.exitCode !== 0) $('tunnel-error').textContent = '诊断发现问题，请展开下方结果查看权限、密钥或网络错误。';
    }
    if (action === 'save') toast('隧道配置已保存');
  } catch (error) { $('tunnel-error').textContent = error.message; }
  finally {
    tunnelBusy = false;
    document.querySelectorAll('.tunnel-buttons button').forEach(button => button.disabled = false);
    await refreshTunnel().catch(error => { $('tunnel-error').textContent = error.message; });
  }
}
$('tunnel-form').addEventListener('submit', event => { event.preventDefault(); tunnelAction('save'); });
for (const action of ['start','stop','doctor']) $('tunnel-' + action).addEventListener('click', () => tunnelAction(action));
$('tunnel-remember').addEventListener('change', () => { if (!$('tunnel-remember').checked) $('tunnel-auto').checked = false; });
$('tunnel-auto').addEventListener('change', () => { if ($('tunnel-auto').checked) $('tunnel-remember').checked = true; });
document.querySelectorAll('[data-guide]').forEach(button => button.addEventListener('click', () => desktop.openGuide(button.dataset.guide).catch(error => toast(error.message,true))));
$('tunnel-copy-id').addEventListener('click', () => {
  if (!tunnelState?.tunnelId) return toast('请先保存 Tunnel ID', true);
  copy(tunnelState.tunnelId).then(() => toast('Tunnel ID 已复制')).catch(error => toast(error.message,true));
});
$('tunnel-copy-prompt').addEventListener('click', () => copy('请只使用 Working MCP 插件调用 workspace_current，告诉我当前工作区的名字和绝对路径。不要修改文件或执行命令。后续工具调用请复用返回的 session_id。').then(() => toast('验证提示词已复制')).catch(error => toast(error.message,true)));
setInterval(() => { if (desktop && !tunnelBusy && !document.hidden && !$('tunnel-view').hidden) refreshTunnel().catch(() => {}); }, 2000);
