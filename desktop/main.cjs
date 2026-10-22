'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, safeStorage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Tunnel } = require('./tunnel.cjs');
const { Backend } = require('./backend.cjs');
const { Updates } = require('./updates.cjs');
const startedAt=Date.now();
let updates;
let updateTimer;

app.setName('Working MCP');
if (process.env.WORKING_DESKTOP_DATA_DIR) {
  fs.mkdirSync(process.env.WORKING_DESKTOP_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.WORKING_DESKTOP_DATA_DIR);
}
let window;
let backend;
let tunnel;
let quitting = false;
let cleanupFinished = false;
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (cleanupFinished) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    clearInterval(updateTimer);
    Promise.resolve(tunnel?.stop()).catch(() => {}).then(() => backend?.stop()).catch(() => {}).finally(() => { cleanupFinished = true; app.quit(); });
  });
  app.whenReady().then(start).catch(error => {
    if (!quitting) dialog.showErrorBox('Working MCP 无法启动', String(error.message || error));
    app.quit();
  });
}

async function start() {
  const dataDirectory = process.env.WORKING_DESKTOP_DATA_DIR || app.getPath('userData');
  const repo = path.resolve(__dirname, '..');
  const resources = app.isPackaged ? process.resourcesPath : path.join(repo, 'build', 'desktop-resources');
  const gitRoot = path.join(resources, 'tools', 'git');
  const paths = [path.join(resources, 'tools'), path.join(gitRoot, 'bin')];
  if (process.platform === 'win32') paths.push(path.join(gitRoot, 'cmd'), path.join(gitRoot, 'ucrt64', 'bin'), path.join(gitRoot, 'mingw64', 'bin'), path.join(gitRoot, 'usr', 'bin'));
  // Finder-launched apps have a reduced PATH; include conventional developer paths.
  if (process.platform === 'darwin') paths.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  const env = { ...process.env, PATH: [...paths, process.env.PATH || ''].join(path.delimiter) };
  delete env.WORKING_MCP_API_KEY;
  for (const prefix of ['', 'ucrt64', 'mingw64']) {
    const helpers=path.join(gitRoot,prefix,'libexec','git-core');
    if(fs.existsSync(helpers)){env.GIT_EXEC_PATH=helpers;break;}
  }
  let executable, args;
  const frozen = path.join(resources, 'backend', process.platform === 'win32' ? 'working-mcp-backend.exe' : 'working-mcp-backend');
  if (app.isPackaged || process.env.WORKING_DESKTOP_USE_BUNDLE === '1') {
    executable = frozen; args = [];
  } else {
    executable = path.join(repo, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    args = [path.join(repo, 'desktop', 'backend-entry.py')];
  }
  if (!fs.existsSync(executable)) throw new Error('找不到内置后端。开发模式请先执行 uv sync；打包请执行 npm run pack。');
  window = new BrowserWindow({ width: 1220, height: 860, minWidth: 760, minHeight: 600,
    title: 'Working MCP', backgroundColor: '#111514', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true }
  });
  await window.loadFile(path.join(__dirname,'startup.html'));
  window.show();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'Working MCP', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'reload' }, { role: 'minimize' }, { role: 'close' }] },
    { label: '帮助', submenu: [{ label:'检查更新…', click:()=>updates?.check().catch(()=>{}) }] }
  ]));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== backend?.origin + '/admin') event.preventDefault();
  });
  backend = new Backend();
  backend.on('unexpected-exit', () => {
    if (!quitting) { dialog.showErrorBox('MCP Server 已停止', '后端进程意外退出。请关闭并重新打开应用。'); app.quit(); }
  });
  function trusted(event) {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== backend.origin + '/admin') {
      throw new Error('Untrusted IPC sender');
    }
  }
  const actions = new Set(['mode', 'add', 'rename', 'default', 'remove']);
  ipcMain.handle('working:state', (event, payload) => {
    trusted(event);
    if (payload !== undefined && (!payload || !actions.has(payload.action))) throw new Error('Invalid action');
    return backend.request('/api/state', payload);
  });
  ipcMain.handle('working:credentials', event => { trusted(event); return backend.request('/api/credentials'); });
  ipcMain.handle('working:key', async (event, payload) => {
    trusted(event);
    if (!payload || !(payload.generate === true || typeof payload.api_key === 'string')) throw new Error('Invalid key request');
    const result = await backend.request('/api/credentials', payload.generate === true ? { generate: true } : { api_key: payload.api_key });
    if (tunnel?.running()) {
      await tunnel.stop();
      try { await tunnel.start(); } catch (error) { tunnel.message = error.message; tunnel.phase = 'error'; }
    }
    return result;
  });
  ipcMain.handle('working:updates', async (event, action, payload) => {
    trusted(event);
    if (!updates) throw new Error('更新管理尚未就绪');
    switch(action) {
      case 'state': return updates.snapshot();
      case 'check': return updates.check();
      case 'download': return updates.download();
      case 'install': return updates.install();
      case 'settings': return updates.configure(payload);
      case 'release': return shell.openExternal(updates.snapshot().releaseUrl);
      default: throw new Error('Invalid update action');
    }
  });
  ipcMain.handle('working:directory', async event => {
    trusted(event);
    const result = await dialog.showOpenDialog(window, { title: '选择工作区目录', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('working:copy', (event, text) => {
    trusted(event);
    if (typeof text !== 'string' || text.length > 100000) throw new Error('Invalid clipboard content');
    clipboard.writeText(text);
  });
  ipcMain.handle('working:tunnel', async (event, action, payload) => {
    trusted(event);
    if (!tunnel) throw new Error('隧道管理尚未就绪');
    switch (action) {
      case 'state': return tunnel.snapshot();
      case 'save': return tunnel.save(payload || {});
      case 'start': return tunnel.start();
      case 'stop': return tunnel.stop();
      case 'doctor': return tunnel.doctor();
      default: throw new Error('Invalid tunnel action');
    }
  });
  const guides = {
    platform:'https://platform.openai.com/settings/organization/tunnels',
    keys:'https://platform.openai.com/settings/organization/api-keys',
    roles:'https://platform.openai.com/settings/organization/people/roles',
    chatgpt:'https://chatgpt.com/plugins',
    docs:'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels'
  };
  ipcMain.handle('working:guide', (event, target) => {
    trusted(event);
    if (!Object.hasOwn(guides, target)) throw new Error('Invalid guide target');
    return shell.openExternal(guides[target]);
  });
  // Development uses the checkout; a packaged Finder/Explorer launch starts
  // with a useful user directory rather than the read-only application bundle.
  const cwd = process.env.WORKING_DESKTOP_WORKSPACE || (app.isPackaged ? app.getPath('documents') : repo);
  const origin = await backend.start(executable, [...args, '--desktop', '--port', '8000', '--config', path.join(dataDirectory, 'config.json')], { cwd, env });
  if (quitting || !window || window.isDestroyed()) return;
  tunnel = new Tunnel({directory:path.join(dataDirectory, 'tunnel'),
    binary:path.join(resources, 'tunnel', process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client'),
    storage:safeStorage, getMcpKey:async () => (await backend.request('/api/credentials')).api_key, origin});
  let kind=process.platform==='darwin' ? 'mac' : process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : fs.existsSync(path.join(path.dirname(process.execPath),'Uninstall Working MCP.exe')) ? 'installed' : 'zip';
  let macSigned=false;
  if (process.platform==='darwin' && app.isPackaged) {
    try {
      const {spawnSync}=require('node:child_process');
      const signature=spawnSync('/usr/bin/codesign',['-dv','--verbose=2',path.resolve(path.dirname(process.execPath),'../..')],{encoding:'utf8'});
      macSigned=/^TeamIdentifier=(?!not set)[A-Z0-9]+$/m.test(signature.stderr || '');
    } catch {}
  }
  const engine=app.isPackaged && (kind==='installed' || macSigned) ? require('electron-updater').autoUpdater : null;
  if (engine && process.platform==='darwin') engine.channel='latest-'+process.arch;
  updates=new Updates({currentVersion:app.getVersion(),platform:process.platform,arch:process.arch,kind,
    directory:path.join(dataDirectory,'updates'),engine,
    openFile:async file=>{const error=await shell.openPath(file);if(error) throw new Error(error);},
    showFile:file=>shell.showItemInFolder(file),
    beforeInstall:async()=>{await tunnel.stop();await backend.stop();}
  });
  await window.loadURL(origin + '/admin');
  window.show();
  if (app.isPackaged && process.env.WORKING_DESKTOP_SMOKE!=='1') {
    if (updates.preferences.autoCheck) updates.check().catch(()=>{});
    updateTimer=setInterval(()=>{if(updates.preferences.autoCheck) updates.check().catch(()=>{});},6*60*60*1000);
    updateTimer.unref();
  }
  if (tunnel.settings.autoStart && tunnel.key) {
    tunnel.start().catch(error => { tunnel.phase = 'error'; tunnel.message = error.message; });
  }
  if (process.env.WORKING_DESKTOP_SMOKE === '1') {
    // Test the shipped renderer and preload bridge as well as the backend.
    const smoke = await window.webContents.executeJavaScript(`(async () => {
      const data = await window.workingDesktop.request();
      const keys = await window.workingDesktop.credentials();
      await new Promise(resolve => setTimeout(resolve, 500));
      return {tools: data.tools.length, keyGenerated: keys.api_key.startsWith('wmcp_'),
        loginOpen: document.getElementById('login-dialog').open,
        settingsVisible: !document.getElementById('desktop-settings').hidden,
        tunnelAvailable: (await window.workingDesktop.tunnel('state')).available,
        tunnelPagePresent: !!document.getElementById('tunnel-view'),
        versionVisible: document.getElementById('app-version').textContent,
        updateVersion: (await window.workingDesktop.updates('state')).currentVersion};
    })()`);
    if (smoke.tools !== 17 || !smoke.keyGenerated || smoke.loginOpen || !smoke.settingsVisible || !smoke.tunnelAvailable || !smoke.tunnelPagePresent) throw new Error('Desktop smoke failed: ' + JSON.stringify(smoke));
    smoke.runtime=await require('./smoke.cjs').verifyTools(backend,dataDirectory,resources);
    smoke.windowVisible=window.isVisible(); smoke.startupMs=Date.now()-startedAt;
    if (!smoke.windowVisible || !smoke.versionVisible.includes(app.getVersion())) throw new Error('Version/startup UI not ready');
    fs.writeFileSync(path.join(dataDirectory, 'smoke-result.json'), JSON.stringify(smoke));
    await new Promise(resolve=>setTimeout(resolve,2000));
    app.quit();
  }
}
