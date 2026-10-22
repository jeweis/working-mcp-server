'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {keepGitFile,measure} = require('./git_bundle.cjs');

async function main() {
  const root = path.resolve(__dirname, '..');
  const destination = path.join(root, 'build', 'desktop-resources');
  const backend = path.join(destination, 'backend-dist', 'working-mcp-backend');
  if (!fs.existsSync(backend)) throw new Error('Build the Python backend first: npm run backend:build');
  fs.rmSync(path.join(destination, 'backend'), { recursive: true, force: true });
  fs.cpSync(backend, path.join(destination, 'backend'), { recursive: true, verbatimSymlinks: true });
  const tools = path.join(destination, 'tools');
  fs.rmSync(tools, { recursive: true, force: true });
  fs.mkdirSync(tools, { recursive: true });
  const { rgPath } = await import('@vscode/ripgrep');
  fs.copyFileSync(rgPath, path.join(tools, process.platform === 'win32' ? 'rg.exe' : 'rg'));
  if (process.platform !== 'win32') fs.chmodSync(path.join(tools, 'rg'), 0o755);
  let git;
  if (process.platform === 'win32') {
    // MinGit distributions omit Bash. Bundle the complete Git for Windows
    // installation from the build machine, so end users need not install it.
    const candidates = [process.env.WORKING_BUILD_GIT_ROOT, 'C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git'];
    git = candidates.find(candidate => candidate && fs.existsSync(path.join(candidate, 'bin', 'bash.exe')));
    if (!git) throw new Error('Install Git for Windows on the build machine or set WORKING_BUILD_GIT_ROOT (must include bin/bash.exe)');
  } else {
    git = path.join(root, 'node_modules', 'dugite', 'git');
    if (!fs.existsSync(path.join(git, 'bin', 'git'))) throw new Error('Embedded Git is missing; run npm ci with download access');
  }
  const before=measure(git);
  fs.cpSync(git, path.join(tools, 'git'), { recursive: true, verbatimSymlinks: true,
    ...(process.platform==='win32' ? {filter:file=>keepGitFile(git,file)} : {}) });
  const after=measure(path.join(tools,'git'));
  fs.writeFileSync(path.join(destination,'git-bundle-stats.json'),JSON.stringify({before,after},null,2));
  console.log(`Git payload: ${before.files} → ${after.files} files; ${before.bytes} → ${after.bytes} bytes`);
  const licenses = path.join(destination, 'licenses');
  fs.mkdirSync(licenses, { recursive: true });
  for (const name of ['dugite', '@vscode/ripgrep', 'app-builder-lib']) {
    const source = path.join(root, 'node_modules', name, 'LICENSE');
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(licenses, name.replaceAll('/', '-') + '-LICENSE.txt'));
  }
  // Fail packaging early instead of shipping an app with missing tools.
  const suffix = process.platform === 'win32' ? '.exe' : '';
  execFileSync(path.join(tools, 'rg' + suffix), ['--version']);
  execFileSync(path.join(tools, 'git', 'bin', 'git' + suffix), ['--version']);
  if (process.platform === 'win32') execFileSync(path.join(tools, 'git', 'bin', 'bash.exe'), ['--noprofile', '--norc', '-c', 'printf ok']);
  require('./prepare_windows.cjs').prepare(root);
  console.log('Desktop backend, Git, Bash (Windows) and ripgrep prepared.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
