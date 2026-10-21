'use strict';
const { Backend } = require('../desktop/backend.cjs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'working-desktop-test-'));
  const backend = new Backend();
  try {
    const root = path.resolve(__dirname, '..');
    const resources = path.join(root, 'build', 'desktop-resources');
    const executable = path.join(resources, 'backend', process.platform === 'win32' ? 'working-mcp-backend.exe' : 'working-mcp-backend');
    const gitRoot = path.join(resources, 'tools', 'git');
    const toolsPath = [path.join(resources, 'tools'), path.join(gitRoot, 'bin'), path.join(gitRoot, 'cmd'), path.join(gitRoot, 'mingw64', 'bin'), path.join(gitRoot, 'usr', 'bin'), process.env.PATH].join(path.delimiter);
    const workspace = path.join(directory, 'project');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'working fixture');
    const origin = await backend.start(executable, ['--desktop', '--port', '0', '--config', path.join(directory, 'config.json')], {
      cwd: workspace, env: {...process.env, PATH: toolsPath}
    });
    assert.equal((await backend.request('/api/state')).tools.length, 17);
    const first = (await backend.request('/api/credentials')).api_key;
    assert.ok(first.startsWith('wmcp_'));
    assert.equal((await fetch(origin + '/api/state')).status, 401);
    assert.equal((await fetch(origin + '/api/state', {headers: {Authorization: 'Bearer ' + first}})).status, 401);
    async function tool(name, arguments_ = {}) {
      const response = await fetch(origin + '/mcp', {method: 'POST', headers: {
        Authorization: 'Bearer ' + first, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Method': 'tools/call', 'MCP-Name': name, 'MCP-Protocol-Version': '2026-07-28'
      }, body: JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/call', params:{name, arguments:arguments_, _meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28', 'io.modelcontextprotocol/clientCapabilities':{}}}})});
      const text = await response.text();
      const message = response.headers.get('content-type')?.includes('text/event-stream')
        ? JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6)) : JSON.parse(text);
      assert.ok(message.result && !message.result.isError, JSON.stringify(message));
      return message.result.structuredContent;
    }
    const sid = (await tool('workspace_current')).session_id;
    assert.equal((await tool('bash', {command:'printf packaged', session_id:sid})).result.output, 'packaged');
    assert.ok((await tool('grep', {pattern:'working fixture', session_id:sid})).result.output.includes('fixture.txt'));
    execFileSync(path.join(gitRoot, 'bin', process.platform === 'win32' ? 'git.exe' : 'git'), ['init', '-q', workspace]);
    assert.equal((await tool('git_status', {session_id:sid})).result.exit_code, 0);
    const replacement = 'replacement-test-secret-123456';
    await backend.request('/api/credentials', {api_key: replacement});
    assert.equal((await fetch(origin + '/mcp', {method:'POST', headers:{Authorization:'Bearer '+first, 'Content-Type':'application/json'}, body:'{}'})).status, 401);
    assert.notEqual((await fetch(origin + '/mcp', {method:'POST', headers:{Authorization:'Bearer '+replacement, 'Content-Type':'application/json'}, body:'{}'})).status, 401);
    await backend.request('/api/state', {action:'mode', read_only:true});
    assert.equal((await backend.request('/api/state')).tools.length, 11);
    console.log('Bundled Python runtime, private management, generated key, live rotation and mode switch: PASS');
  } finally {
    await backend.stop();
    fs.rmSync(directory, {recursive:true, force:true});
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
