'use strict';
// v26 PortableOptions has no script/include hook. Keep a versioned replacement
// of its small launcher template; refuse to silently patch a different builder.
const fs=require('node:fs'); const path=require('node:path');
function prepare(root=path.resolve(__dirname,'..')) {
  if (process.platform!=='win32') return;
  const builder=path.dirname(require.resolve('app-builder-lib/package.json'));
  if (require(path.join(builder,'package.json')).version!=='26.15.3') throw new Error('Re-review portable NSIS template for the new electron-builder version');
  const templates=path.join(builder,'templates','nsis');
  fs.copyFileSync(path.join(root,'desktop/windows/portable.nsi'),path.join(templates,'portable.nsi'));
  // Both the portable template and the assisted installer include this file.
  fs.copyFileSync(path.join(root,'desktop/windows/working-space.nsh'),path.join(templates,'include','working-space.nsh'));
}
module.exports={prepare};
if (require.main===module) prepare();
