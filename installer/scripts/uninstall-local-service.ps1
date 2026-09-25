param(
  [Parameter(Mandatory = $true)][string]$DataRoot,
  [Parameter(Mandatory = $true)][bool]$PreserveData
)

$ErrorActionPreference = 'Stop'
if ($DataRoot -notmatch '^[A-Za-z]:\\ProgramData\\ZAIPOS(?:\\)?$') {
  throw 'WINDOWS_DATA_ROOT_UNSAFE'
}

Write-Output 'Preserve ZAIPOS business data unless the operator explicitly declines.'
& sc.exe stop ZAIPOSLocalService
& sc.exe delete ZAIPOSLocalService

if ($PreserveData) { return }
$target = $DataRoot
if ($target -and (Test-Path -LiteralPath $target)) {
  Remove-Item -LiteralPath $target -Recurse -Force
}
