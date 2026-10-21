'use strict';
// Offline integration: the real official CLI probes a local MCP server and a
// local stand-in control plane. No OpenAI account or real key is contacted.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const { Backend } = require('../desktop/backend.cjs');
const { Tunnel } = require('../desktop/tunnel.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'working-tunnel-smoke-'));
  const resources = path.resolve(__dirname,'../build/desktop-resources');
  const backend = new Backend(); let proxy, control, tunnel;
  try {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const toolRoot = path.join(resources,'tools');
    const origin = await backend.start(path.join(resources,'backend','working-mcp-backend'+suffix),
      ['--desktop','--port','0','--config',path.join(directory,'config.json')], {cwd:directory, env:{...process.env,
        PATH:[toolRoot,path.join(toolRoot,'git','bin'),path.join(toolRoot,'git','cmd'),path.join(toolRoot,'git','usr','bin'),process.env.PATH].join(path.delimiter)}});
    const key = (await backend.request('/api/credentials')).api_key;
    let forwarded = 0, mismatch = false, queued = false, delivered = null;
    proxy = http.createServer(async (request,response) => {
      const chunks=[]; for await (const chunk of request) chunks.push(chunk);
      if (request.url.startsWith('/mcp') && Buffer.concat(chunks).toString().includes('workspace_current')) {
        forwarded++;
        if (request.headers.authorization !== 'Bearer '+key) mismatch=true;
      }
      const body=Buffer.concat(chunks);
      const headers={...request.headers}; delete headers.host; delete headers['content-length'];
      try {
        const upstream=await fetch(origin+request.url,{method:request.method,headers,...(body.length?{body}:{}),signal:AbortSignal.timeout(10000)});
        response.writeHead(upstream.status,Object.fromEntries(upstream.headers));
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502);response.end(); }
    });
    control = http.createServer(async (request,response) => {
      const chunks=[]; for await (const chunk of request) chunks.push(chunk);
      if (request.url.includes('/poll') && !queued) {
        queued=true;
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify({commands:[{request_id:'offline-request',shard_token:'offline-shard',
          command_type:'jsonrpc',channel:'main',created_at:new Date().toISOString(),response_timeout:'15s',
          headers:{'Mcp-Protocol-Version':['2026-07-28'],'Mcp-Method':['tools/call'],'Mcp-Name':['workspace_current']},
          jsonrpc:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'workspace_current',arguments:{},_meta:{
            'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}}}]}));
      } else if (request.url.includes('/response')) {
        delivered=JSON.parse(Buffer.concat(chunks));
        response.writeHead(200,{'Content-Type':'application/json'}); response.end('{}');
      } else if (request.url.includes('/poll')) {
        setTimeout(()=>{response.writeHead(204);response.end();},200);
      } else {
        response.writeHead(200,{'Content-Type':'application/json'});
        response.end(JSON.stringify({id:'tunnel_0123456789abcdef0123456789abcdef',name:'offline fixture'}));
      }
    });
    proxy.listen(0,'127.0.0.1'); control.listen(0,'127.0.0.1');
    await Promise.all([once(proxy,'listening'),once(control,'listening')]);
    tunnel = new Tunnel({directory:path.join(directory,'tunnel'), binary:path.join(resources,'tunnel','tunnel-client'+suffix),
      storage:{isEncryptionAvailable:()=>false}, getMcpKey:async()=>key, origin:`http://127.0.0.1:${proxy.address().port}`});
    await tunnel.save({tunnelId:'tunnel_0123456789abcdef0123456789abcdef',runtimeKey:'sk-offline-fixture-not-a-real-key'});
    const original=tunnel.invocation.bind(tunnel);
    tunnel.invocation=(command,mcpKey)=>{
      const invocation=original(command,mcpKey);
      invocation.args.push('--control-plane.base-url',`http://127.0.0.1:${control.address().port}`);
      return invocation;
    };
    const report=await tunnel.doctor();
    assert.equal(report.output.includes(key),false);
    await tunnel.start();
    for(let attempt=0;attempt<150 && !delivered;attempt++) await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(delivered, 'Official CLI did not deliver a local MCP response: '+tunnel.snapshot().logs);
    assert.ok(forwarded>0,'Official CLI did not forward the queued MCP tool call');
    assert.equal(mismatch,false,'MCP bearer credential was not forwarded correctly');
    assert.ok(delivered.resp_json?.result?.structuredContent?.workspace?.absolute_path,
      'Queued tool call failed: '+JSON.stringify(delivered));
    console.log('Official tunnel-client: local queued tool call, authenticated MCP forwarding, response delivery and redaction: PASS (local control-plane fixture only)');
  } finally {
    if(tunnel) await tunnel.stop();
    await backend.stop();
    for(const server of [proxy,control]) if(server){server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
    fs.rmSync(directory,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
