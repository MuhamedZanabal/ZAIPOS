param(
  [string]$InstallerPattern = 'release\ZAIPOS-*-win-x64.exe'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Wait-Until {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Condition,
    [Parameter(Mandatory = $true)][string]$Failure,
    [int]$Seconds = 180
  )
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    try {
      if (& $Condition) { return }
    } catch {
      # Keep polling until the deadline; final diagnostics are emitted by the caller.
    }
    Start-Sleep -Milliseconds 750
  } while ((Get-Date) -lt $deadline)
  throw $Failure
}

$installer = Get-ChildItem -Path $InstallerPattern | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'WINDOWS_ACCEPTANCE_INSTALLER_MISSING' }

$existing = Get-Service -Name 'ZAIPOSLocalService' -ErrorAction SilentlyContinue
if ($existing) {
  try { Stop-Service -Name 'ZAIPOSLocalService' -Force -ErrorAction SilentlyContinue } catch {}
  & sc.exe delete ZAIPOSLocalService | Out-Null
  Start-Sleep -Seconds 2
}

$dataRoot = 'C:\ProgramData\ZAIPOS'
if (Test-Path -LiteralPath $dataRoot) {
  Remove-Item -LiteralPath $dataRoot -Recurse -Force
}

Write-Host "Installing $($installer.FullName)"
$install = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -PassThru -Wait
if ($install.ExitCode -ne 0) { throw "WINDOWS_ACCEPTANCE_INSTALL_FAILED:$($install.ExitCode)" }

Wait-Until -Seconds 180 -Failure 'WINDOWS_ACCEPTANCE_SERVICE_MISSING' -Condition {
  $null -ne (Get-Service -Name 'ZAIPOSLocalService' -ErrorAction SilentlyContinue)
}
Wait-Until -Seconds 180 -Failure 'WINDOWS_ACCEPTANCE_SERVICE_NOT_RUNNING' -Condition {
  (Get-Service -Name 'ZAIPOSLocalService' -ErrorAction Stop).Status -eq 'Running'
}

$profilePath = Join-Path $dataRoot 'server-profile.json'
Wait-Until -Seconds 240 -Failure 'WINDOWS_ACCEPTANCE_PROFILE_MISSING' -Condition {
  Test-Path -LiteralPath $profilePath
}

$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
if ($profile.origin -ne 'https://127.0.0.1:58321') {
  throw "WINDOWS_ACCEPTANCE_ORIGIN_INVALID:$($profile.origin)"
}
if ($profile.caFingerprint -notmatch '^[a-f0-9]{64}$') {
  throw 'WINDOWS_ACCEPTANCE_FINGERPRINT_INVALID'
}

$health = $null
Wait-Until -Seconds 240 -Failure 'WINDOWS_ACCEPTANCE_HEALTH_NOT_READY' -Condition {
  try {
    $response = Invoke-WebRequest -Uri ($profile.origin + '/v1/health') -SkipCertificateCheck -UseBasicParsing -TimeoutSec 5
    $script:health = $response.Content | ConvertFrom-Json
    return $response.StatusCode -eq 200 -and $script:health.status -eq 'ready' -and $script:health.database -eq 'ready'
  } catch {
    return $false
  }
}

if (-not (Get-Process -Name 'postgres' -ErrorAction SilentlyContinue)) {
  throw 'WINDOWS_ACCEPTANCE_POSTGRES_NOT_RUNNING'
}

$programFiles = [Environment]::GetFolderPath('ProgramFiles')
$appRoot = Join-Path $programFiles 'ZAIPOS'
$runtimeRoot = Join-Path $appRoot 'resources\runtime'
foreach ($required in @(
  (Join-Path $runtimeRoot 'zaipos-local-service.exe'),
  (Join-Path $runtimeRoot 'postgres\bin\postgres.exe'),
  (Join-Path $runtimeRoot 'postgres\bin\initdb.exe'),
  (Join-Path $runtimeRoot 'postgres\bin\pg_ctl.exe')
)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "WINDOWS_ACCEPTANCE_RUNTIME_FILE_MISSING:$required" }
}

$appExe = Join-Path $appRoot 'ZAIPOS.exe'
if (-not (Test-Path -LiteralPath $appExe)) { throw 'WINDOWS_ACCEPTANCE_APP_MISSING' }
$app = Start-Process -FilePath $appExe -ArgumentList '--disable-gpu' -PassThru
Start-Sleep -Seconds 12
if ($app.HasExited) {
  throw "WINDOWS_ACCEPTANCE_APP_EXITED:$($app.ExitCode)"
}

Write-Host 'ZAIPOS Windows installed-runtime acceptance passed.'
Write-Host ("Service: " + (Get-Service -Name 'ZAIPOSLocalService').Status)
Write-Host ("Health: " + ($health | ConvertTo-Json -Compress))
Write-Host ("Profile: " + ($profile | ConvertTo-Json -Compress))

Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
