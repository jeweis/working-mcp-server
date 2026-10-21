'use strict';
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createInterface } = require('node:readline');
const { EventEmitter, once } = require('node:events');

class Backend extends EventEmitter {
  constructor() {
    super();
    this.adminToken = randomBytes(32).toString('hex');
    this.child = null;
    this.origin = null;
    this.stopping = false;
  }
  async start(executable, args, options) {
    if (this.child) throw new Error('Backend already started');
    const child = spawn(executable, args, {
      ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...options.env, WORKING_MCP_ADMIN_TOKEN: this.adminToken }
    });
    this.child = child;
    // These streams must always be drained; retain a bounded diagnostic tail.
    let diagnostics = '';
    child.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-12000); });
    child.stdin.on('error', () => {}); // An already-exited backend closes this pipe.
    let startupError;
    child.on('error', error => { startupError = error; });
    child.on('exit', (code, signal) => {
      if (!this.stopping && this.origin) this.emit('unexpected-exit', { code, signal });
    });
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('MCP Server 启动超时')), 60000);
      const onError = error => finish(error);
      const onExit = () => finish(startupError || new Error(`MCP Server 启动失败：${diagnostics}`));
      const onLine = line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.event === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port < 65536) {
          this.origin = `http://127.0.0.1:${message.port}`;
          finish(null, this.origin);
        }
      };
      function finish(error, result) {
        clearTimeout(timer);
        child.off('error', onError); child.off('exit', onExit); lines.off('line', onLine);
        if (error) reject(error); else resolve(result);
      }
      child.once('error', onError); child.once('exit', onExit); lines.on('line', onLine);
    });
    try {
      await ready;
      // A bound socket is not enough: wait until the authenticated API serves.
      for (let attempt = 0; attempt < 200; attempt++) {
        if (child.exitCode !== null) throw new Error('MCP Server 已退出');
        try { await this.request('/api/state'); return this.origin; } catch (error) {
          if (attempt === 199) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } catch (error) { await this.stop(); throw error; }
  }
  async request(path, payload) {
    if (!this.origin || !['/api/state', '/api/credentials'].includes(path)) throw new Error('Server unavailable');
    const response = await fetch(this.origin + path, {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.adminToken}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(15000), redirect: 'error'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit').catch(() => {});
    child.stdin.end('shutdown\n');
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await once(killer, 'exit').catch(() => {});
      } else child.kill('SIGKILL');
      await exited;
    }
  }
}
module.exports = { Backend };
