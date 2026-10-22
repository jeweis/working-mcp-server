param([string]$BaselineDirectory = '')
$ErrorActionPreference = 'Stop'
if($env:GITHUB_ACTIONS -ne 'true'){throw 'Run this installer regression only on a disposable GitHub Actions Windows runner'}
$root = Split-Path $PSScriptRoot -Parent
$evidence = Join-Path $root 'build/release-test-evidence'
New-Item -ItemType Directory -Force $evidence | Out-Null
$base = Join-Path $env:TEMP ('wmcp-release-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force $base | Out-Null
$report = [ordered]@{ cases=@(); isolatedPath=$true; installerUpgrade=$null; uninstall=$null }
$systemGit=Join-Path $env:ProgramFiles 'Git'
$disabledGit=Join-Path $env:ProgramFiles ('Git-wmcp-disabled-'+[guid]::NewGuid().ToString('N'))
$gitMoved=$false
$sharedData=Join-Path $env:APPDATA 'Working MCP'
if(Test-Path $sharedData){throw 'Refusing to touch existing Working MCP user data in the test runner'}
New-Item -ItemType Directory $sharedData | Out-Null
# Only Windows system utilities remain. The application must supply Git, Bash,
# coreutils, rg, Python and the complete MCP runtime itself.
$node=(Get-Command node.exe).Source
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
$env:WORKING_DESKTOP_SMOKE = '1'
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WorkingWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  public static string[] Titles() {
    var titles=new List<string>();
    EnumWindows((h,p)=>{if(IsWindowVisible(h)){var s=new StringBuilder(512);GetWindowText(h,s,512);if(s.ToString().Contains("Working") || s.ToString().Contains("MCP"))titles.Add(s.ToString());}return true;},IntPtr.Zero);
    return titles.ToArray();
  }
}
'@
function Start-Case([string]$Executable,[string]$Name,[bool]$RequirePreparation=$false,[string]$Data='') {
  if (!$Data) { $Data=Join-Path $base $Name }
  New-Item -ItemType Directory -Force $Data | Out-Null
  $env:WORKING_DESKTOP_DATA_DIR=$Data
  $resultFile=Join-Path $Data 'smoke-result.json'
  Remove-Item $resultFile -Force -ErrorAction SilentlyContinue
  $watch=[Diagnostics.Stopwatch]::StartNew()
  $process=Start-Process -FilePath $Executable -PassThru -RedirectStandardOutput (Join-Path $evidence "$Name.stdout.log") -RedirectStandardError (Join-Path $evidence "$Name.stderr.log")
  $firstWindow=$null; $preparation=$null; $mainWindow=$null; $titlesSeen=@()
  try {
    while ($watch.Elapsed.TotalSeconds -lt 240) {
      $titles=[WorkingWindows]::Titles()
      foreach($title in $titles) {
        if ($null -eq $firstWindow) { $firstWindow=$watch.ElapsedMilliseconds }
        if ($title -like '*Preparing runtime*' -and $null -eq $preparation) { $preparation=$watch.ElapsedMilliseconds }
        if ($title -notlike '*Preparing runtime*' -and $title -notlike '*Starting*' -and $null -eq $mainWindow) { $mainWindow=$watch.ElapsedMilliseconds }
        if ($titlesSeen -notcontains $title) { $titlesSeen += $title }
      }
      if (Test-Path $resultFile) { break }
      if ($process.HasExited) { throw "$Name exited before reporting readiness (exit $($process.ExitCode))" }
      Start-Sleep -Milliseconds 100
    }
    if (!(Test-Path $resultFile)) { throw "$Name did not become ready within 240 seconds" }
    $smoke=Get-Content $resultFile -Raw | ConvertFrom-Json
    if ($smoke.tools -ne 17 -or $smoke.loginOpen -or !$smoke.keyGenerated) { throw "$Name returned an invalid renderer/backend report" }
    if ($null -eq $mainWindow) { throw "$Name never displayed a native main window" }
    if ($Name -notlike 'baseline-*' -and (!$smoke.runtime.bash -or !$smoke.runtime.grep -or !$smoke.runtime.git)) { throw "$Name did not verify bundled Bash, rg and Git" }
    if ($RequirePreparation -and ($null -eq $preparation -or $preparation -gt 10000)) { throw 'Portable launcher did not show preparation feedback within 10 seconds' }
    $readyAt=$watch.ElapsedMilliseconds
    if (!$process.WaitForExit(30000)) { throw "$Name did not shut down cleanly" }
    if ($process.ExitCode -ne 0) { throw "$Name exited with $($process.ExitCode)" }
    $case=[ordered]@{name=$Name;readyMs=$readyAt;firstWindowMs=$firstWindow;preparationWindowMs=$preparation;mainWindowMs=$mainWindow;windowTitles=$titlesSeen;smoke=$smoke;status='passed'}
    $report.cases += $case
    Write-Host "$Name : main window $mainWindow ms; preparation $preparation ms; ready $($case.readyMs) ms"
  } finally { if (!$process.HasExited) { & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null } }
}
function Install-Case([string]$Setup,[string]$Directory) {
  $p=Start-Process -FilePath $Setup -ArgumentList @('/S','--currentuser',"/D=$Directory") -PassThru
  if (!$p.WaitForExit(240000)) { & "$env:SystemRoot\System32\taskkill.exe" /PID $p.Id /T /F | Out-Null; throw 'Installer timed out' }
  if ($p.ExitCode -ne 0) { throw "Installer failed with exit $($p.ExitCode)" }
  $exe=Get-ChildItem $Directory -Filter 'Working MCP.exe' -Recurse | Select-Object -First 1
  if (!$exe) { throw 'Installed application executable is missing' }
  return $exe.FullName
}
try {
  if(Test-Path $systemGit){Move-Item -LiteralPath $systemGit -Destination $disabledGit; $gitMoved=$true}
  $report.systemGitUnavailable=!(Test-Path $systemGit)
  $compilerInfo=& $node (Join-Path $root 'scripts/nsis_info.cjs')
  if($LASTEXITCODE -ne 0){throw 'Could not resolve the builder NSIS toolset'}
  $compilerInfo=$compilerInfo | Select-Object -Last 1 | ConvertFrom-Json
  $compiler=$compilerInfo.path
  if(!(Test-Path $compiler)){throw 'NSIS compiler missing for low-space regression test'}
  if($compilerInfo.env.NSISDIR){$env:NSISDIR=$compilerInfo.env.NSISDIR}
  $spaceExe=Join-Path $evidence 'space-check-fixture.exe'
  & $compiler "/DTEST_OUT=$spaceExe" (Join-Path $root 'desktop/windows/space-test.nsi')
  if($LASTEXITCODE -ne 0){throw 'Could not build low-space fixture'}
  $space=Start-Process -FilePath $spaceExe -PassThru
  if(!$space.WaitForExit(15000) -or $space.ExitCode -ne 112){throw 'Native disk-space check failed to reject insufficient space'}
  $report.lowSpaceExitCode=$space.ExitCode
  Remove-Item $spaceExe -Force
  # ZIP is extracted once. Subsequent launches do not run a self-extractor.
  $zip=Get-ChildItem (Join-Path $root 'release') -Filter '*-win-x64.zip' | Select-Object -First 1
  if (!$zip) { throw 'Windows ZIP missing' }
  $zipDir=Join-Path $base 'zip'
  Expand-Archive -Path $zip.FullName -DestinationPath $zipDir
  Start-Case (Join-Path $zipDir 'Working MCP.exe') 'zip'
  Remove-Item $zipDir -Recurse -Force

  $installDir=Join-Path $base 'Working MCP'
  if ($BaselineDirectory -and (Test-Path $BaselineDirectory)) {
    try {
      $oldPortable=Get-ChildItem $BaselineDirectory -Filter '*-portable.exe' | Select-Object -First 1
      if ($oldPortable) { Start-Case $oldPortable.FullName 'baseline-portable' }
    } catch { $report.cases += @{name='baseline-portable';status='failed';error=$_.ToString()}; Write-Warning $_ }
    try {
      $oldSetup=Get-ChildItem $BaselineDirectory -Filter '*-setup.exe' | Select-Object -First 1
      if ($oldSetup) {
        $oldExe=Install-Case $oldSetup.FullName $installDir
        Start-Case $oldExe 'baseline-installed' $false $sharedData
      }
    } catch { $report.cases += @{name='baseline-installed';status='failed';error=$_.ToString()}; Write-Warning $_ }
  }
  $credential=Join-Path $sharedData 'credentials.json'
  $before=if(Test-Path $credential){(Get-FileHash $credential).Hash}else{$null}

  $portable=Get-ChildItem (Join-Path $root 'release') -Filter '*-portable.exe' | Select-Object -First 1
  Start-Case $portable.FullName 'portable' $true

  $setup=Get-ChildItem (Join-Path $root 'release') -Filter '*-setup.exe' | Select-Object -First 1
  # Verify the assisted installer has a visible native window before clicking
  # through or using /S. Do not conflate installer and portable startup paths.
  $wizard=Start-Process -FilePath $setup.FullName -PassThru
  try {
    $timer=[Diagnostics.Stopwatch]::StartNew(); $seen=$false
    while($timer.Elapsed.TotalSeconds -lt 15) {
      if ([WorkingWindows]::Titles().Count -gt 0) { $seen=$true; break }
      if($wizard.HasExited){break}; Start-Sleep -Milliseconds 100
    }
    if(!$seen){throw 'Assisted installer did not show its native UI'}
    $report.installerWindowMs=$timer.ElapsedMilliseconds
  } finally { if(!$wizard.HasExited){ & "$env:SystemRoot\System32\taskkill.exe" /PID $wizard.Id /T /F | Out-Null; Start-Sleep -Seconds 1 } }
  $installed=Install-Case $setup.FullName $installDir
  Start-Case $installed 'installed' $false $sharedData
  $report.installerUpgrade=if($before){$before -eq (Get-FileHash $credential).Hash}else{'baseline unavailable'}
  if($report.installerUpgrade -eq $false){throw 'Update changed the existing MCP credentials'}
  $uninstaller=Join-Path (Split-Path $installed -Parent) 'Uninstall Working MCP.exe'
  $uninstall=Start-Process -FilePath $uninstaller -ArgumentList @('/S','--currentuser') -PassThru
  if(!$uninstall.WaitForExit(120000)){throw 'Uninstaller timed out'}
  for($i=0;$i -lt 300 -and (Test-Path $installed);$i++){Start-Sleep -Milliseconds 200}
  if(Test-Path $installed){throw 'Uninstaller left the application executable behind'}
  $report.uninstall='passed'
  if(!(Test-Path $credential)){throw 'Uninstaller deleted application configuration without permission'}
} finally {
  if($gitMoved){Move-Item -LiteralPath $disabledGit -Destination $systemGit}
  Remove-Item $sharedData -Recurse -Force -ErrorAction SilentlyContinue
  $report | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $evidence 'windows-results.json') -Encoding utf8
  Remove-Item Env:WORKING_DESKTOP_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:WORKING_DESKTOP_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue
}
