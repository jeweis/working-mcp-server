'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const RELEASES = 'https://github.com/jeweis/working-mcp-server/releases';
const API = 'https://api.github.com/repos/jeweis/working-mcp-server/releases/latest';
function version(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value || '');
  return match ? match.slice(1).map(Number) : null;
}
function newer(candidate, current) {
  const a = version(candidate), b = version(current);
  if (!a || !b) return false;
  for (let i=0; i<3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function requireSpace(directory, bytes, statfs = fs.statfsSync) {
  const info = statfs(directory);
  const free = Number(info.bavail) * Number(info.bsize);
  if (free < bytes) throw new Error(`磁盘空间不足：${directory} 至少需要 ${(bytes/1073741824).toFixed(1)} GB，可用 ${(free/1073741824).toFixed(1)} GB。请清理空间后重试。`);
}
class Updates {
  constructor({currentVersion, platform, arch, kind, directory, engine, fetchImpl=fetch, openFile, showFile, beforeInstall, statfs}) {
    Object.assign(this, {currentVersion, platform, arch, kind, directory, engine, fetchImpl, openFile, showFile, beforeInstall, statfs});
    this.phase='idle'; this.message='尚未检查更新'; this.latest=null; this.percent=0; this.busy=false; this.lastChecked=null;
    this.file=null; this.expectedHash=null;
    fs.mkdirSync(directory, {recursive:true});
    this.preferences={autoCheck:true, autoDownload:false};
    try { const saved=JSON.parse(fs.readFileSync(path.join(directory,'settings.json'),'utf8')); this.preferences={autoCheck:saved.autoCheck !== false, autoDownload:saved.autoDownload === true}; } catch {}
    if (engine) {
      engine.autoDownload=false; engine.autoInstallOnAppQuit=false; engine.allowPrerelease=false;
      engine.allowDowngrade=false; engine.disableDifferentialDownload=true; engine.logger=null;
      engine.setFeedURL({provider:'github',owner:'jeweis',repo:'working-mcp-server'});
      engine.on('download-progress', data => { this.percent=Math.max(0,Math.min(100,data.percent || 0)); });
      engine.on('error', error => { this.phase='error'; this.message='更新失败：'+error.message; });
    }
  }
  snapshot() {
    return {currentVersion:this.currentVersion, platform:this.platform, arch:this.arch, kind:this.kind,
      automaticInstall:!!this.engine, phase:this.phase, message:this.message, percent:Math.round(this.percent),
      latestVersion:this.latest?.version || null, available:!!this.latest && newer(this.latest.version,this.currentVersion),
      releaseUrl:this.latest?.url || RELEASES, lastChecked:this.lastChecked, preferences:this.preferences,
      downloaded:!!this.file, busy:this.busy};
  }
  configure(payload) {
    if (!payload || typeof payload.autoCheck !== 'boolean' || typeof payload.autoDownload !== 'boolean') throw new Error('Invalid update settings');
    this.preferences={autoCheck:payload.autoCheck,autoDownload:payload.autoDownload};
    const file=path.join(this.directory,'settings.json');
    fs.writeFileSync(file+'.tmp',JSON.stringify(this.preferences),{mode:0o600}); fs.renameSync(file+'.tmp',file);
    return this.snapshot();
  }
  async json(url) {
    const response=await this.fetchImpl(url,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(20000),redirect:'error'});
    if (!response.ok) throw new Error(response.status===403 || response.status===429 ? 'GitHub 请求频率受限，请稍后再试' : `GitHub HTTP ${response.status}`);
    return response.json();
  }
  assetName(v) {
    const suffix=this.platform==='darwin' ? `mac-${this.arch}.dmg` : this.kind==='installed' ? `win-${this.arch}-setup.exe` : this.kind==='portable' ? `win-${this.arch}-portable.exe` : `win-${this.arch}.zip`;
    return `Working-MCP-${v}-${suffix}`;
  }
  async release() {
    try { return await this.json(API); }
    catch (apiError) {
      // Public release redirects avoid the shared unauthenticated API quota.
      // Never accept an arbitrary redirect as a repository/version identifier.
      try {
        const response=await this.fetchImpl(RELEASES+'/latest',{method:'HEAD',signal:AbortSignal.timeout(20000)});
        if (!response.ok || !response.url.startsWith(RELEASES+'/tag/v')) throw apiError;
        const tag=response.url.slice((RELEASES+'/tag/').length);
        if (!version(tag)) throw apiError;
        if (!newer(tag,this.currentVersion)) return {tag_name:tag,assets:[]};
        const v=tag.slice(1), name=this.assetName(v), base=RELEASES+`/download/${tag}/`;
        const asset=await this.fetchImpl(base+name,{method:'HEAD',signal:AbortSignal.timeout(20000)});
        if (!asset.ok) throw apiError;
        const size=Number(asset.headers.get('content-length'));
        return {tag_name:tag,assets:[{name,size,browser_download_url:base+name},{name:'SHA256SUMS.txt',browser_download_url:base+'SHA256SUMS.txt'}]};
      } catch { throw apiError; }
    }
  }
  async check() {
    if (this.busy || this.phase==='installing' || this.file) return this.snapshot();
    this.busy=true; this.phase='checking'; this.message='正在从 GitHub Releases 检查更新…';
    try {
      const release=await this.release();
      if (release.draft || release.prerelease || !version(release.tag_name)) throw new Error('GitHub 未提供有效的正式版本');
      const v=release.tag_name.replace(/^v/,'');
      this.latest=null;
      if (!newer(v,this.currentVersion)) { this.phase='current'; this.message='当前已是最新版本'; }
      else {
        const name=this.assetName(v);
        const asset=release.assets?.find(item=>item.name===name);
        const base=RELEASES+`/download/v${v}/`;
        if (!asset || !Number.isSafeInteger(asset.size) || asset.size<=0 || asset.size>2_000_000_000 || asset.browser_download_url!==base+name) throw new Error('新版本缺少匹配当前系统的正式安装包');
        const sums=release.assets.find(item=>item.name==='SHA256SUMS.txt');
        if (!sums || sums.browser_download_url!==base+'SHA256SUMS.txt') throw new Error('新版本缺少校验文件');
        this.latest={version:v,asset,url:RELEASES+`/tag/v${v}`,sums:sums.browser_download_url};
        if (this.engine) {
          const result=await this.engine.checkForUpdates();
          if (result?.updateInfo?.version!==v) throw new Error('发布版本与更新元数据不一致，请稍后重试');
        }
        this.phase='available'; this.message=`发现新版本 v${v}`;
      }
      this.lastChecked=new Date().toISOString();
    } catch(error) { this.phase='error'; this.message=error.message; }
    finally { this.busy=false; }
    if (this.phase==='available' && this.preferences.autoDownload) return this.download();
    return this.snapshot();
  }
  async download() {
    if (this.busy || !this.latest || !newer(this.latest.version,this.currentVersion)) throw new Error('请先检查并选择可用的新版本');
    if (this.file) return this.snapshot();
    this.busy=true; this.phase='downloading'; this.percent=0; this.message='正在下载并验证更新…';
    const asset=this.latest.asset;
    const target=path.join(this.directory,asset.name);
    try {
      // Reserve room for download, extraction and staging. Native installer
      // independently checks TEMP and the chosen installation volume.
      requireSpace(this.directory,asset.size*5+268435456,this.statfs);
      if (this.engine) {
        const files=await this.engine.downloadUpdate();
        if (!files?.length || !fs.existsSync(files[0])) throw new Error('更新文件下载失败');
        if (this.phase==='error') throw new Error(this.message);
        this.file=files[0];
      } else {
        const sumsResponse=await this.fetchImpl(this.latest.sums,{signal:AbortSignal.timeout(30000)});
        if (!sumsResponse.ok) throw new Error('无法下载更新校验文件');
        const sums=await sumsResponse.text();
        if (sums.length>65536) throw new Error('校验文件异常');
        const line=sums.split(/\r?\n/).find(line=>line.trim().split(/\s+/)[1]===asset.name);
        const hash=line?.split(/\s+/)[0];
        if (!/^[0-9a-f]{64}$/.test(hash || '')) throw new Error('安装包没有有效的 SHA-256 校验值');
        const response=await this.fetchImpl(asset.browser_download_url,{signal:AbortSignal.timeout(30*60*1000)});
        if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
        const digest=crypto.createHash('sha256'); let count=0;
        const output=fs.createWriteStream(target+'.part',{mode:0o600});
        // Always handle write errors, including errors between drain waits.
        let writeError; output.on('error',error=>{writeError=error;});
        try {
          for await (const chunk of response.body) {
            count+=chunk.length;
            if (count>asset.size) throw new Error('下载文件大小异常');
            digest.update(chunk); this.percent=count/asset.size*100;
            if (writeError) throw writeError;
            if (!output.write(chunk)) await once(output,'drain');
          }
          output.end(); await once(output,'finish');
          if (writeError) throw writeError;
        } catch(error) { output.destroy(); await new Promise(resolve=>output.closed ? resolve() : output.once('close',resolve)); throw error; }
        if (count!==asset.size || digest.digest('hex')!==hash) throw new Error('下载校验失败，请重新下载');
        fs.renameSync(target+'.part',target); this.file=target; this.expectedHash=hash;
      }
      this.percent=100; this.phase='downloaded';
      this.message=this.engine ? '下载并校验完成。安装会停止 MCP Server 和后台任务，并重启应用。' : '下载并校验完成。请按说明退出旧版本并手动替换应用；配置会保留。';
    } catch(error) { fs.rmSync(target+'.part',{force:true}); this.phase='error'; this.message=error.message; }
    finally { this.busy=false; }
    return this.snapshot();
  }
  async install() {
    if (this.busy || this.phase!=='downloaded' || !this.file) throw new Error('请先完成下载');
    if (!this.engine) {
      const digest=crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(this.file)) digest.update(chunk);
      if (digest.digest('hex')!==this.expectedHash) { this.file=null; this.phase='error'; throw new Error('更新文件已变化，请重新下载'); }
      if (this.platform==='darwin') await this.openFile(this.file);
      else this.showFile(this.file);
      return this.snapshot();
    }
    this.phase='installing'; this.message='正在停止 MCP Server，准备安装并重启…';
    await this.beforeInstall();
    // Keep the NSIS installation progress visible; never install on ordinary quit.
    this.engine.quitAndInstall(false,true);
    return this.snapshot();
  }
}
module.exports={Updates,newer,version,requireSpace,RELEASES};
