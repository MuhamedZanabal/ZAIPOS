param(
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [Parameter(Mandatory = $true)][bool]$PreserveData
)

$ErrorActionPreference = 'Stop'
if ($DataRoot -notmatch '^[A-Za-z]:\\ProgramData\\ZAIPOS(?:\\)?$') {
  throw 'WINDOWS_DATA_ROOT_UNSAFE'
}

$service = Get-Service -Name 'ZAIPOSLocalService' -ErrorAction SilentlyContinue
if ($service) {
  if ($service.Status -ne 'Stopped') {
    Stop-Service -Name 'ZAIPOSLocalService' -Force -ErrorAction SilentlyContinue
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
  }
  & sc.exe delete ZAIPOSLocalService | Out-Null
}

Write-Output 'ZAIPOS business data is preserved by default.'
if ($PreserveData) { return }
if ($DataRoot -and (Test-Path -LiteralPath $DataRoot)) {
  Remove-Item -LiteralPath $DataRoot -Recurse -Force
}
