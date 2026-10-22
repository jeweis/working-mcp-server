; Adapted from electron-builder 26.15.3 portable.nsi (MIT).
; Keep native progress visible and use a private extraction directory per launch.
!include "common.nsh"
!include "extractAppPackage.nsh"
!include "working-space.nsh"

Caption "Working MCP - Preparing runtime"
Page instfiles
ShowInstDetails show
CompletedText "Runtime ready. Starting Working MCP..."

# https://github.com/electron-userland/electron-builder/issues/3972#issuecomment-505171582
CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel ${REQUEST_EXECUTION_LEVEL}

Function .onInit
  System::Call 'kernel32::CreateMutexW(p0, i0, w "Local\WorkingMCPPortable")p.r0 ?e'
  Pop $1
  ${If} $1 == 183
    MessageBox MB_OK "Working MCP is already preparing or running. Please use the existing window."
    Quit
  ${EndIf}
  SetSilent normal
  !insertmacro WorkingCheckTempSpace

  !insertmacro check64BitAndSetRegView
FunctionEnd

Function .onGUIInit
  InitPluginsDir

  !ifdef SPLASH_IMAGE
    File /oname=$PLUGINSDIR\splash.bmp "${SPLASH_IMAGE}"
    BgImage::SetBg $PLUGINSDIR\splash.bmp
    BgImage::Redraw
  !endif
FunctionEnd

Section
  DetailPrint "Preparing runtime. Extracting files; this may take a few minutes."
  DetailPrint "For faster subsequent launches, use the ZIP or installed version."

  StrCpy $INSTDIR "$PLUGINSDIR\app"
  ; Keep $PLUGINSDIR unique per launch. Never erase a live instance's runtime.

  RMDir /r $INSTDIR
  SetOutPath $INSTDIR

  !ifdef APP_DIR_64
    !ifdef APP_DIR_ARM64
      !ifdef APP_DIR_32
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${elseif} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        ${if} ${IsNativeARM64}
          File /r "${APP_DIR_ARM64}\*.*"
        ${else}
          File /r "${APP_DIR_64}\*.*"
        {endIf}
      !endif
    !else
      !ifdef APP_DIR_32
        ${if} ${RunningX64}
          File /r "${APP_DIR_64}\*.*"
        ${else}
          File /r "${APP_DIR_32}\*.*"
        ${endIf}
      !else
        File /r "${APP_DIR_64}\*.*"
      !endif
    !endif
  !else
    !ifdef APP_DIR_32
      File /r "${APP_DIR_32}\*.*"
    !else
      !insertmacro extractEmbeddedAppPackage
    !endif
  !endif

  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" +4
    MessageBox MB_OK|MB_ICONSTOP "Runtime extraction failed. Check free disk space, TEMP permissions and antivirus protection, then try again."
    SetErrorLevel 112
    Quit

  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_DIR", "$EXEDIR").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_FILE", "$EXEPATH").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("PORTABLE_EXECUTABLE_APP_FILENAME", "${APP_FILENAME}").r0'
  ${StdUtils.GetAllParameters} $R0 0

  !ifdef SPLASH_IMAGE
    BgImage::Destroy
  !endif

  HideWindow
	ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
  SetErrorLevel $0

  SetOutPath $EXEDIR
	RMDir /r $INSTDIR
SectionEnd
