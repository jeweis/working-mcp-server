'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path'); const crypto=require('node:crypto');
const {EventEmitter}=require('node:events'); const {Updates,newer,requireSpace}=require('../updates.cjs');
function fixture(t,options={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wmcp-update-')); t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const content=Buffer.from('verified installer fixture'); const name='Working-MCP-0.1.1-mac-arm64.dmg';
  const base='https://github.com/jeweis/working-mcp-server/releases/download/v0.1.1/';
  const hash=crypto.createHash('sha256').update(content).digest('hex');
  const release={tag_name:'v0.1.1',draft:false,prerelease:false,assets:[{name,size:content.length,browser_download_url:base+name},{name:'SHA256SUMS.txt',browser_download_url:base+'SHA256SUMS.txt'}]};
  const opened=[];
  const manager=new Updates({currentVersion:'0.1.0',platform:'darwin',arch:'arm64',kind:'mac',directory,
    openFile:async file=>opened.push(file), showFile:file=>opened.push(file),beforeInstall:async()=>{},
    fetchImpl:async url=>url.includes('/api.github.com/') ? Response.json(release) : url.endsWith('SHA256SUMS.txt') ? new Response(`${hash}  ${name}\n`) : new Response(content),...options});
  return {manager,release,content,opened,directory};
}
test('version comparison is numeric and rejects prereleases and malformed values',()=>{
  assert.equal(newer('0.1.10','0.1.9'),true); assert.equal(newer('0.1.0','0.1.1'),false);
  assert.equal(newer('0.1.2-beta','0.1.1'),false); assert.equal(newer('v0.2.0','0.1.9'),true);
});
test('manual download verifies hash and opens only the verified local artifact',async t=>{
  const {manager,opened}=fixture(t);
  assert.equal((await manager.check()).available,true);
  const state=await manager.download(); assert.equal(state.phase,'downloaded');
  assert.equal(state.automaticInstall,false); assert.equal(state.percent,100);
  await manager.install(); assert.equal(opened.length,1);
  fs.appendFileSync(manager.file,'tampered');
  await assert.rejects(manager.install(),/已变化/); assert.equal(opened.length,1);
});
test('checksum mismatch discards a partial download and refuses installation',async t=>{
  const {manager}=fixture(t); const original=manager.fetchImpl;
  manager.fetchImpl=async url=>url.endsWith('SHA256SUMS.txt') ? new Response('0'.repeat(64)+'  Working-MCP-0.1.1-mac-arm64.dmg') : original(url);
  await manager.check(); assert.equal((await manager.download()).phase,'error');
  assert.equal(fs.existsSync(path.join(manager.directory,'Working-MCP-0.1.1-mac-arm64.dmg.part')),false);
  await assert.rejects(manager.install(),/先完成下载/);
});
test('release cannot redirect selection to an arbitrary repository or executable',async t=>{
  const {manager,release}=fixture(t); release.assets[0].browser_download_url='https://example.com/evil.exe';
  assert.equal((await manager.check()).phase,'error'); assert.equal(manager.latest,null);
});
test('disk checks fail before downloading, with a useful path and reason',async t=>{
  assert.throws(()=>requireSpace('/test',100,()=>({bavail:1,bsize:1})),/磁盘空间不足.*\/test/);
  const {manager}=fixture(t,{statfs:()=>({bavail:0,bsize:4096})}); await manager.check();
  assert.match((await manager.download()).message,/磁盘空间不足/);
});
test('automatic checking does not install or download by default; preferences persist',async t=>{
  const {manager,directory}=fixture(t); await manager.check();
  assert.equal(manager.phase,'available'); assert.equal(manager.file,null);
  manager.configure({autoCheck:false,autoDownload:true});
  const reloaded=new Updates({currentVersion:'0.1.0',directory});
  assert.deepEqual(reloaded.preferences,{autoCheck:false,autoDownload:true});
});
test('standard updater waits for cleanup before explicit installation and never installs on quit',async t=>{
  const engine=new EventEmitter(); const calls=[];
  engine.setFeedURL=()=>{};engine.checkForUpdates=async()=>({updateInfo:{version:'0.1.1'}});
  engine.quitAndInstall=()=>calls.push('install');
  const {manager,directory}=fixture(t,{engine,beforeInstall:async()=>calls.push('cleanup')});
  const file=path.join(directory,'verified.exe');fs.writeFileSync(file,'standard engine verified payload');
  engine.downloadUpdate=async()=>[file];
  await manager.check(); await manager.download();
  assert.equal(engine.autoDownload,false);assert.equal(engine.autoInstallOnAppQuit,false);
  assert.deepEqual(calls,[]);await manager.install();assert.deepEqual(calls,['cleanup','install']);
});
test('GitHub outages remain recoverable and preserve current version',async t=>{
  const {manager}=fixture(t,{fetchImpl:async()=>new Response('',{status:429})});
  const state=await manager.check();assert.equal(state.phase,'error');assert.equal(state.currentVersion,'0.1.0');assert.match(state.message,/频率/);
});
test('shared GitHub API rate limits fall back to the same repository public release redirect',async t=>{
  const {manager,content}=fixture(t);
  manager.fetchImpl=async url=>{
    if(url.includes('api.github.com')) return new Response('',{status:429});
    if(url.endsWith('/latest')) {
      const result=new Response('');Object.defineProperty(result,'url',{value:'https://github.com/jeweis/working-mcp-server/releases/tag/v0.1.1'});return result;
    }
    return new Response(null,{headers:{'content-length':String(content.length)}});
  };
  assert.equal((await manager.check()).phase,'available');
  assert.equal(manager.latest.version,'0.1.1');
});
