'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {keepGitFile}=require('../../scripts/git_bundle.cjs');
test('Git bundle pruning removes docs/locales/GUI while retaining runtime and licensing',()=>{
  const root=path.resolve('git-fixture');
  for(const file of ['ucrt64/share/doc/git/git.html','ucrt64/share/locale/zh/messages.mo','ucrt64/lib/tcl8.6/init.tcl','ucrt64/bin/wish86.exe','cmd/git-gui.exe','mingw64/share/doc/git/git.html','usr/share/locale/de/messages.mo','usr/lib/tcl8.6/init.tcl','git-bash.exe','mingw64/libexec/git-core/git-gui']) assert.equal(keepGitFile(root,path.join(root,file)),false,file);
  for(const file of ['ucrt64/bin/git.exe','ucrt64/libexec/git-core/git-remote-https.exe','ucrt64/bin/libcrypto-3-x64.dll','bin/bash.exe','usr/bin/msys-2.0.dll','usr/bin/sleep.exe','mingw64/bin/git.exe','mingw64/libexec/git-core/git-remote-https.exe','mingw64/ssl/certs/ca-bundle.crt','etc/gitconfig','LICENSE.txt','usr/share/perl5/Git.pm']) assert.equal(keepGitFile(root,path.join(root,file)),true,file);
});
