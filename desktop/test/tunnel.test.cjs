'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Tunnel, TUNNEL_ID, redact } = require('../tunnel.cjs');

const id = 'tunnel_0123456789abcdef0123456789abcdef';
const runtimeKey = 'sk-example-runtime-secret-that-is-not-real';
const mcpKey = 'wmcp_local_mcp_secret';
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value).map(byte => byte ^ 0x55),
  decryptString: value => Buffer.from(value).map(byte => byte ^ 0x55).toString()
};
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'working-tunnel-test-'));
  const binary = path.join(directory, 'tunnel-client'); fs.writeFileSync(binary, 'fixture');
  const client = new Tunnel({directory, binary, storage, getMcpKey:async () => mcpKey,
    origin:'http://127.0.0.1:8000', ...overrides});
  t.after(() => { clearInterval(client.timer); fs.rmSync(directory, {recursive:true,force:true}); });
  return client;
}
function child() {
  const value = new EventEmitter();
  Object.assign(value, {pid:undefined, exitCode:null, signalCode:null, stdout:new PassThrough(), stderr:new PassThrough()});
  return value;
}

test('tunnel IDs preserve namespaces and reject malformed input', () => {
  assert.ok(TUNNEL_ID.test(id));
  assert.ok(TUNNEL_ID.test('tunnel_ab12_0123456789abcdef0123456789abcdef'));
  assert.equal(TUNNEL_ID.test('tunnel_../bad'), false);
});

test('runtime key persistence is encrypted and never returned to the renderer', async t => {
  const client = fixture(t);
  await client.save({tunnelId:id, runtimeKey, remember:true, autoStart:true});
  const text = fs.readFileSync(client.file, 'utf8');
  assert.equal(text.includes(runtimeKey), false);
  assert.equal(JSON.stringify(client.snapshot()).includes(runtimeKey), false);
  const reopened = new Tunnel({directory:client.directory, binary:client.binary, storage, getMcpKey:async () => mcpKey, origin:client.origin});
  assert.equal(reopened.key, runtimeKey);
  assert.equal(reopened.settings.autoStart, true);
  await client.save({tunnelId:id, remember:false});
  assert.equal(client.key, runtimeKey);
  assert.equal(fs.readFileSync(client.file,'utf8').includes('encryptedKey'), false);
  await client.save({tunnelId:id, forgetKey:true});
  assert.equal(client.snapshot().hasRuntimeKey, false);
});

test('auto-connect requires encrypted storage and local MCP keys cannot be mistaken for runtime keys', async t => {
  const client = fixture(t, {storage:{isEncryptionAvailable:()=>false}});
  await assert.rejects(client.save({tunnelId:id, runtimeKey, remember:true}), /系统加密/);
  await assert.rejects(client.save({tunnelId:id, runtimeKey, autoStart:true}), /自动连接/);
  await assert.rejects(client.save({tunnelId:id, runtimeKey:mcpKey}), /OpenAI Platform/);
  await assert.rejects(client.save({tunnelId:id, runtimeKey:'sk-space key'}), /空白/);
});

test('CLI arguments carry only secret references and inherited tunnel targets are stripped', async t => {
  const client = fixture(t);
  await client.save({tunnelId:id, runtimeKey});
  const prior = process.env.MCP_SERVER_URL;
  process.env.MCP_SERVER_URL = 'https://unwanted.invalid';
  try {
    const {args, options} = client.invocation('run', mcpKey);
    assert.equal(args.join(' ').includes(runtimeKey), false);
    assert.equal(args.join(' ').includes(mcpKey), false);
    assert.ok(args.includes('Authorization: env:WORKING_TUNNEL_MCP_AUTH'));
    assert.ok(args.includes('http://127.0.0.1:8000/mcp'));
    assert.equal(options.env.CONTROL_PLANE_API_KEY, runtimeKey);
    assert.equal(options.env.WORKING_TUNNEL_MCP_AUTH, 'Bearer '+mcpKey);
    assert.equal(options.env.MCP_SERVER_URL, undefined);
    assert.equal(options.env.ALLOW_REMOTE_UI, 'false');
  } finally { if (prior === undefined) delete process.env.MCP_SERVER_URL; else process.env.MCP_SERVER_URL = prior; }
});

test('a process being alive does not imply ready; logs redact secrets even across chunks', async t => {
  const process = child(); let ready = false;
  const client = fixture(t, {spawnImpl:()=>process,
    fetchImpl:async url => ({ok:!url.endsWith('/readyz') || ready, arrayBuffer:async()=>new ArrayBuffer(0)})});
  await client.save({tunnelId:id,runtimeKey});
  await client.start();
  assert.equal(client.snapshot().ready, false);
  process.stdout.write('key=' + runtimeKey.slice(0,12));
  assert.equal(client.snapshot().logs, '');
  process.stdout.write(runtimeKey.slice(12) + '\nAuthorization: Bearer ' + mcpKey + '\n');
  assert.equal(client.snapshot().logs.includes(runtimeKey), false);
  assert.equal(client.snapshot().logs.includes(mcpKey), false);
  fs.writeFileSync(path.join(client.directory,'health.url'), 'http://127.0.0.1:12345');
  await client.refreshHealth();
  assert.equal(client.snapshot().healthy, true);
  assert.equal(client.snapshot().phase, 'connecting');
  ready = true; await client.refreshHealth();
  assert.equal(client.snapshot().phase, 'ready');
  assert.match(client.snapshot().message,/ChatGPT/);
  process.exitCode = 1; process.emit('exit',1);
  assert.equal(client.snapshot().phase,'error');
  assert.equal(client.snapshot().ready,false);
});

test('stop cancels a pending start before credentials resolve', async t => {
  let resolveKey, spawned = false;
  const client = fixture(t, {getMcpKey:()=>new Promise(resolve => {resolveKey=resolve;}), spawnImpl:()=>{spawned=true;}});
  await client.save({tunnelId:id,runtimeKey});
  const started = client.start();
  await client.stop(); resolveKey(mcpKey);
  await assert.rejects(started,/取消/);
  assert.equal(spawned,false);
});

test('doctor returns a bounded, redacted report without claiming a successful ChatGPT connection', async t => {
  const process = child();
  const client = fixture(t, {spawnImpl:(_binary,args)=>{
    assert.equal(args[0],'doctor'); assert.ok(args.includes('--json'));
    setImmediate(()=>{process.stdout.write('failed key='+runtimeKey+' bearer='+mcpKey);process.exitCode=1;process.emit('exit',1);});
    return process;
  }});
  await client.save({tunnelId:id,runtimeKey});
  const result = await client.doctor();
  assert.equal(result.exitCode,1);
  assert.equal(result.output.includes(runtimeKey),false);
  assert.equal(result.output.includes(mcpKey),false);
  assert.equal(client.snapshot().ready,false);
});

test('redaction handles OpenAI keys and bearer headers', () => {
  assert.equal(redact('sk-abc-123 Authorization: Bearer wmcp_abc').includes('wmcp_abc'),false);
});
