'use strict';
// Only invoked by explicit release smoke mode; uses an isolated test workspace.
const fs=require('node:fs'); const path=require('node:path'); const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
async function verifyTools(backend,directory,resources) {
  const workspace=path.join(directory,'release-smoke-project');fs.mkdirSync(workspace,{recursive:true});
  fs.writeFileSync(path.join(workspace,'fixture.txt'),'release runtime fixture');
  const data=await backend.request('/api/state',{action:'add',name:'release-smoke',path:workspace});
  const wid=data.workspaces.find(item=>item.name==='release-smoke').id;
  const key=(await backend.request('/api/credentials')).api_key;
  async function call(name,args={}) {
    const response=await fetch(backend.origin+'/mcp',{method:'POST',headers:{
      Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:'application/json, text/event-stream',
      'MCP-Method':'tools/call','MCP-Name':name,'MCP-Protocol-Version':'2026-07-28'
    },body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,
      _meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}})});
    const text=await response.text();
    const result=response.headers.get('content-type')?.includes('text/event-stream') ? JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6)) : JSON.parse(text);
    assert.ok(result.result && !result.result.isError,JSON.stringify(result));return result.result.structuredContent;
  }
  const sid=(await call('workspace_current')).session_id;
  await call('workspace_switch',{workspace_id:wid,session_id:sid});
  assert.equal((await call('bash',{command:'printf packaged',session_id:sid})).result.output,'packaged');
  assert.ok((await call('grep',{pattern:'release runtime fixture',session_id:sid})).result.output.includes('fixture.txt'));
  execFileSync(path.join(resources,'tools','git','bin',process.platform==='win32'?'git.exe':'git'),['init','-q',workspace],{windowsHide:true});
  assert.equal((await call('git_status',{session_id:sid})).result.exit_code,0);
  return {bash:true,grep:true,git:true};
}
module.exports={verifyTools};
