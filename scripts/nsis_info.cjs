'use strict';
// Use the exact compiler/environment resolver used by our pinned builder.
require('app-builder-lib/out/toolsets/windows.js').getMakeNsisPath()
  .then(info=>console.log(JSON.stringify(info)))
  .catch(error=>{console.error(error.message);process.exitCode=1;});
