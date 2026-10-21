'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const TUNNEL_ID = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/;
function redact(text, secrets = []) {
  for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]').replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]');
}
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = file + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {mode:0o600}); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, {force:true}); }
}

class Tunnel {
  constructor({directory, binary, storage, getMcpKey, origin, spawnImpl = spawn, fetchImpl = fetch}) {
    Object.assign(this, {directory, binary, storage, getMcpKey, origin, spawnImpl, fetchImpl});
    this.file = path.join(directory, 'tunnel.json');
    this.settings = {tunnelId:'', autoStart:false};
    this.key = ''; this.child = null; this.diagnosticChild = null; this.phase = 'stopped'; this.message = '';
    this.logs = ''; this.secrets = []; this.healthOrigin = null; this.timer = null; this.operation = false; this.epoch = 0;
    fs.mkdirSync(directory, {recursive:true});
    if (fs.existsSync(this.file)) {
      const settings = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (settings.tunnelId && !TUNNEL_ID.test(settings.tunnelId)) throw new Error('保存的 Tunnel ID 格式无效');
      this.settings = {tunnelId:settings.tunnelId || '', autoStart:settings.autoStart === true};
      if (settings.encryptedKey) {
        this.encryptedKey = settings.encryptedKey;
        try {
          if (!this.canRemember()) throw new Error('系统加密不可用');
          this.key = storage.decryptString(Buffer.from(settings.encryptedKey, 'base64'));
        } catch { this.message = '无法解密已保存的运行密钥，请重新输入并保存。'; }
      }
    }
  }
  canRemember() {
    return this.storage.isEncryptionAvailable() && this.storage.getSelectedStorageBackend?.() !== 'basic_text';
  }
  running() { return !!this.child && this.child.exitCode === null && this.child.signalCode === null; }
  snapshot() {
    return {...this.settings, available:fs.existsSync(this.binary), hasRuntimeKey:!!this.key,
      remembered:!!this.encryptedKey, canRemember:this.canRemember(), running:this.running(),
      phase:this.phase, message:redact(this.message, this.secrets), logs:redact(this.logs, [...this.secrets, this.key]),
      healthy:!!this.healthy, ready:!!this.ready};
  }
  async save({tunnelId, runtimeKey = '', remember = false, autoStart = false, forgetKey = false}) {
    if (this.running() || this.operation) throw new Error('请先停止隧道，再修改配置');
    if (!TUNNEL_ID.test(tunnelId || '')) throw new Error('请输入完整的 tunnel_... ID（32 位标识，可含 4 位命名空间）');
    if (typeof runtimeKey !== 'string' || runtimeKey.length > 1024 || /\s/.test(runtimeKey)) throw new Error('运行密钥不能包含空白字符');
    const key = forgetKey ? '' : runtimeKey || this.key;
    if (key && !key.startsWith('sk-')) throw new Error('请输入 OpenAI Platform 的运行 API Key（sk-...），不要填写本机 MCP API Key');
    let encryptedKey;
    if (remember && key) {
      if (!this.canRemember()) throw new Error('当前系统加密不可用；可取消记住密钥，仅在本次打开期间使用');
      encryptedKey = this.storage.encryptString(key).toString('base64');
    }
    if (autoStart && !encryptedKey) throw new Error('自动连接需要先使用系统加密记住运行密钥');
    const settings = {tunnelId, autoStart:autoStart === true, ...(encryptedKey ? {encryptedKey} : {})};
    atomicJson(this.file, settings);
    this.settings = {tunnelId, autoStart:autoStart === true};
    this.encryptedKey = encryptedKey;
    this.key = key; this.secrets.push(key); this.phase = 'stopped'; this.message = '';
    return this.snapshot();
  }
  invocation(command, mcpKey) {
    if (!fs.existsSync(this.binary)) throw new Error('当前应用未包含 tunnel-client，请安装完整桌面包或运行 npm run tunnel:fetch');
    if (!TUNNEL_ID.test(this.settings.tunnelId) || !this.key) throw new Error('请先保存 Tunnel ID 和 OpenAI 运行密钥');
    const url = new URL(this.origin);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('隧道目标必须为本应用的本机 MCP Server');
    this.secrets.push(mcpKey, this.key);
    // No literal credential is placed in argv or a config/profile file.
    const args = [command, '--control-plane.tunnel-id', this.settings.tunnelId,
      '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--mcp.server-url', this.origin + '/mcp',
      '--mcp.extra-headers', 'Authorization: env:WORKING_TUNNEL_MCP_AUTH',
      '--mcp.discovery-extra-headers', 'Authorization: env:WORKING_TUNNEL_MCP_AUTH',
      '--log.format', 'json', '--log.level', 'info'];
    // Strip inherited tunnel settings so a developer shell cannot change the
    // control plane, proxy destination, profiles, raw logging or extra targets.
    const env = {...process.env};
    for (const name of Object.keys(env)) {
      if (/^(CONTROL_PLANE_|MCP_|HARPOON_|TUNNEL_CLIENT_|HEALTH_|CLOUDFLARED_|LOG_|ADMIN_UI_|WORKING_MCP_)/.test(name)
          || ['OPENAI_API_KEY','OPENAI_ADMIN_KEY','ALLOW_REMOTE_UI','OPEN_WEB_UI'].includes(name)) delete env[name];
    }
    Object.assign(env, {CONTROL_PLANE_API_KEY:this.key, WORKING_TUNNEL_MCP_AUTH:'Bearer ' + mcpKey,
      OPEN_WEB_UI:'false', ALLOW_REMOTE_UI:'false'});
    if (command === 'run') args.push('--health.listen-addr', '127.0.0.1:0', '--health.url-file', path.join(this.directory, 'health.url'));
    else args.push('--explain', '--json');
    return {args, options:{cwd:this.directory, env, windowsHide:true, detached:process.platform !== 'win32', stdio:['ignore','pipe','pipe']}};
  }
  collect(child) {
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream?.on('data', chunk => {
      pending += chunk.toString();
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        this.logs = (this.logs + redact(pending.slice(0, end + 1), this.secrets)).slice(-32768);
        pending = pending.slice(end + 1);
      }
      if (pending.length > 32768) pending = '[过长日志行已省略]';
      });
      stream?.on('end', () => { if (pending) this.logs = (this.logs + redact(pending, this.secrets)).slice(-32768); });
    }
  }
  async start() {
    if (this.operation || this.running()) throw new Error('隧道已运行或正在执行操作');
    this.operation = true;
    const epoch = ++this.epoch;
    try {
      const mcpKey = await this.getMcpKey();
      if (epoch !== this.epoch) throw new Error('连接操作已取消');
      const {args, options} = this.invocation('run', mcpKey);
      fs.rmSync(path.join(this.directory, 'health.url'), {force:true});
      this.logs = ''; this.phase = 'connecting'; this.message = '正在连接 OpenAI，等待健康与就绪检查…'; this.healthy = this.ready = false;
      const child = this.spawnImpl(this.binary, args, options);
      this.child = child;
      this.collect(child);
      child.on('error', error => { this.phase = 'error'; this.message = error.message; });
      child.on('exit', (code) => {
        clearInterval(this.timer); this.timer = null;
        if (this.child === child) {
          this.child = null; this.healthy = this.ready = false;
          if (this.phase !== 'stopping') { this.phase = 'error'; this.message = `隧道进程已退出（${code}），请运行诊断并检查权限与密钥。`; }
        }
      });
      this.timer = setInterval(() => this.refreshHealth().catch(() => {}), 2000);
      this.timer.unref?.();
      return this.snapshot();
    } finally { this.operation = false; }
  }
  async refreshHealth() {
    if (!this.running()) return;
    const child = this.child;
    try {
      const value = fs.readFileSync(path.join(this.directory, 'health.url'), 'utf8').trim();
      const url = new URL(value);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Invalid local health URL');
      const results = await Promise.all(['/healthz','/readyz'].map(route => this.fetchImpl(url.origin + route, {signal:AbortSignal.timeout(1500), redirect:'error'})));
      if (this.child !== child || !this.running()) return;
      await Promise.all(results.map(response => response.arrayBuffer()));
      this.healthy = results[0].ok; this.ready = results[1].ok;
      this.healthOrigin = url.origin;
      this.phase = this.ready ? 'ready' : 'connecting';
      this.message = this.ready ? '隧道客户端已就绪。请在 ChatGPT 添加插件并调用工具，完成端到端验证。' : '客户端运行中，但尚未就绪。请检查日志、隧道关联和运行密钥权限。';
    } catch {
      if (this.child === child && this.running()) { this.healthy = this.ready = false; this.phase = 'connecting'; }
    }
  }
  async terminate(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit').catch(() => {});
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID',String(child.pid),'/T','/F'], {windowsHide:true, stdio:'ignore'});
      await once(killer, 'exit').catch(() => {});
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      else child.kill();
      await exited;
    }
  }
  async stop() {
    this.epoch++;
    this.phase = 'stopping'; clearInterval(this.timer); this.timer = null;
    await Promise.all([this.terminate(this.child), this.terminate(this.diagnosticChild)]);
    this.child = this.diagnosticChild = null; this.healthy = this.ready = false;
    this.phase = 'stopped'; this.message = '隧道已停止，本机 MCP Server 仍在运行。';
    return this.snapshot();
  }
  async doctor() {
    if (this.operation) throw new Error('请等待当前操作完成');
    this.operation = true;
    const epoch = ++this.epoch;
    try {
      const mcpKey = await this.getMcpKey();
      if (epoch !== this.epoch) throw new Error('诊断操作已取消');
      const {args, options} = this.invocation('doctor', mcpKey);
      const child = this.spawnImpl(this.binary, args, options); this.diagnosticChild = child;
      let output = '';
      for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => { output = (output + data.toString()).slice(-1_000_000); });
      let timer;
      const result = await Promise.race([
        once(child, 'exit').then(([code]) => ({exitCode:code})),
        new Promise(resolve => { timer = setTimeout(() => resolve({timedOut:true}), 45000); })
      ]).finally(() => clearTimeout(timer));
      if (result.timedOut) await this.terminate(child);
      return {...result, output:redact(output, this.secrets).slice(-32768)};
    } finally { this.diagnosticChild = null; this.operation = false; }
  }
}
module.exports = {Tunnel, TUNNEL_ID, redact};
