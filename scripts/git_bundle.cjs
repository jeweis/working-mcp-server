'use strict';
const path=require('node:path');
const fs=require('node:fs');
// Deny only documentation, translations, GUI and installer payloads. Preserve
// Bash/coreutils, all DLLs, git-core helpers, SSH/TLS, Perl and configuration.
function keepGitFile(root,file) {
  const rel=path.relative(root,file).split(path.sep).join('/').toLowerCase();
  if (!rel) return true;
  if (/^(?:\.git|dev|tmp)(?:\/|$)/.test(rel)) return false;
  if (/^(?:git-bash\.exe|git-cmd\.exe|unins\d*\..*|releaseNotes\.html)$/i.test(rel)) return false;
  if (/^(?:mingw64|ucrt64|usr)\/share\/(?:doc|man|info|locale|git-gui|gitk|gitweb)(?:\/|$)/.test(rel)) return false;
  if (/^(?:usr|mingw64|ucrt64)\/lib\/(?:tcl\d[^/]*|tk\d[^/]*)(?:\/|$)/.test(rel)) return false;
  if (/^(?:(?:usr|mingw64|ucrt64)\/bin|cmd)\/(?:wish|tclsh|git-gui|gitk)(?:[\d.]*)(?:\.exe)?$/.test(rel)) return false;
  if (/^(?:mingw64|ucrt64)\/libexec\/git-core\/(?:git-gui|gitk)(?:\.exe)?$/.test(rel)) return false;
  return true;
}
function measure(root) {
  let files=0,bytes=0;
  for (const entry of fs.readdirSync(root,{withFileTypes:true})) {
    const file=path.join(root,entry.name);
    if (entry.isDirectory()) { const sub=measure(file); files+=sub.files; bytes+=sub.bytes; }
    else { files++; bytes+=fs.lstatSync(file).size; }
  }
  return {files,bytes};
}
module.exports={keepGitFile,measure};
