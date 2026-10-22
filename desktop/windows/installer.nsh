!ifndef BUILD_UNINSTALLER
!include "working-space.nsh"
!macro customInit
  !insertmacro WorkingCheckTempSpace
  !insertmacro WorkingCheckSpace "$INSTDIR" ${WORKING_TARGET_KB}
!macroend
; Assisted installs can select a different volume after .onInit. Recheck it
; immediately before the instfiles page. NSIS also performs its native size check.
!macro customPageAfterChangeDir
  Page custom WorkingCheckSelectedDrive
!macroend
Function WorkingCheckSelectedDrive
  !insertmacro WorkingCheckSpace "$INSTDIR" ${WORKING_TARGET_KB}
  Abort
FunctionEnd

!endif
