!ifndef WORKING_SPACE_INCLUDED
!define WORKING_SPACE_INCLUDED
!include LogicLib.nsh
!include FileFunc.nsh

; Input path need not exist: GetRoot supports both drive and UNC paths.
!macro WorkingCheckSpace DIRECTORY REQUIRED_KB
  ${GetRoot} "${DIRECTORY}" $R7
  StrCpy $R7 "$R7\"
  System::Call 'kernel32::GetDiskFreeSpaceExW(w "$R7", *l .r8, p0, p0)i.r9'
  ${If} $9 == 0
    MessageBox MB_OK|MB_ICONSTOP "Cannot check free disk space on $R7. Check that the drive is accessible and TEMP is writable." /SD IDOK
    SetErrorLevel 112
    Quit
  ${EndIf}
  System::Int64Op $8 / 1024
  Pop $8
  System::Int64Op $8 < ${REQUIRED_KB}
  Pop $9
  ${If} $9 != 0
    MessageBox MB_OK|MB_ICONSTOP "Not enough disk space on $R7. Required: ${REQUIRED_KB} KB; available: $8 KB. Clear disk space or choose another drive/TEMP directory and try again." /SD IDOK
    SetErrorLevel 112
    Quit
  ${EndIf}
!macroend

!ifdef APP_64_UNPACKED_SIZE
  !define /math WORKING_TEMP_KB ${APP_64_UNPACKED_SIZE} * 3
  !define /math WORKING_TARGET_KB ${APP_64_UNPACKED_SIZE} + 262144
!else
  !define WORKING_TEMP_KB 2097152
  !define WORKING_TARGET_KB 1048576
!endif
!macro WorkingCheckTempSpace
  !insertmacro WorkingCheckSpace "$TEMP" ${WORKING_TEMP_KB}
!macroend
!endif
