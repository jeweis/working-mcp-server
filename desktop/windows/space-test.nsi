; Built only by the Windows release test. No test bypass is shipped in the app.
Unicode true
Name "Working MCP disk-space test"
OutFile "${TEST_OUT}"
RequestExecutionLevel user
SilentInstall silent
!include "working-space.nsh"
Section
  ; 2 TiB requirement deterministically exceeds available hosted-runner space.
  !insertmacro WorkingCheckSpace "$TEMP" 2147483647
  SetErrorLevel 0
SectionEnd
