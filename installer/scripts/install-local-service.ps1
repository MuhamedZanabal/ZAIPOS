param(
  [Parameter(Mandatory = $true)][ValidateSet('server+terminal', 'terminal')][string]$Role,
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [Parameter(Mandatory = $true)][string]$ServiceBinary
)

$ErrorActionPreference = 'Stop'
if ($DataRoot -notmatch '^[A-Za-z]:\\ProgramData\\ZAIPOS(?:\\)?$') {
  throw 'WINDOWS_DATA_ROOT_UNSAFE'
}
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
if ($Role -eq 'terminal') { return }

$existing = Get-Service -Name 'ZAIPOSLocalService' -ErrorAction SilentlyContinue
if (-not $existing) {
  & sc.exe create ZAIPOSLocalService binPath= $ServiceBinary start= auto DisplayName= "ZAIPOS Local Service"
  if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_SERVICE_CREATE_FAILED' }
}
& sc.exe start ZAIPOSLocalService
