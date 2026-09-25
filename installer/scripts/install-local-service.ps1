param(
  [Parameter(Mandatory = $true)][ValidateSet('server+terminal', 'terminal')][string]$Role,
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [Parameter(Mandatory = $true)][string]$ServiceBinary
)

$ErrorActionPreference = 'Stop'
if ($DataRoot -notmatch '^[A-Za-z]:\\ProgramData\\ZAIPOS(?:\\)?$') {
  throw 'WINDOWS_DATA_ROOT_UNSAFE'
}
if (-not (Test-Path -LiteralPath $ServiceBinary)) {
  throw 'WINDOWS_SERVICE_BINARY_MISSING'
}

New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
& icacls.exe $DataRoot /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_DATA_ACL_FAILED' }

if ($Role -eq 'terminal') { return }

$quotedBinary = '"' + $ServiceBinary + '"'
$existing = Get-Service -Name 'ZAIPOSLocalService' -ErrorAction SilentlyContinue
if (-not $existing) {
  & sc.exe create ZAIPOSLocalService binPath= $quotedBinary start= auto DisplayName= 'ZAIPOS Local Service' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_SERVICE_CREATE_FAILED' }
} else {
  & sc.exe config ZAIPOSLocalService binPath= $quotedBinary start= auto | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_SERVICE_CONFIG_FAILED' }
}
& sc.exe description ZAIPOSLocalService 'ZAIPOS local PostgreSQL and application service' | Out-Null
& sc.exe failure ZAIPOSLocalService reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null

$service = Get-Service -Name 'ZAIPOSLocalService'
if ($service.Status -ne 'Running') {
  Start-Service -Name 'ZAIPOSLocalService'
}
$deadline = (Get-Date).AddMinutes(2)
do {
  Start-Sleep -Milliseconds 750
  $service = Get-Service -Name 'ZAIPOSLocalService'
  if ($service.Status -eq 'Running') { break }
} while ((Get-Date) -lt $deadline)
if ($service.Status -ne 'Running') { throw 'WINDOWS_SERVICE_START_FAILED' }
