$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$postgresVersion = '17.11.0'
$postgresZipName = 'postgresql-17.11.0-x86_64-pc-windows-msvc.zip'
$postgresUrl = 'https://github.com/theseus-rs/postgresql-binaries/releases/download/17.11.0/postgresql-17.11.0-x86_64-pc-windows-msvc.zip'
$postgresSha = '85829f743e2697c55f1a5e8b210c53b90dd1f578448fc01cb9c4dc9e0a8e3827'

Push-Location $repo
try {
  cargo build --release -p zaipos-local-service
  if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_SERVICE_BUILD_FAILED' }

  $serviceBinary = Join-Path $repo 'target\release\zaipos-local-service.exe'
  if (-not (Test-Path -LiteralPath $serviceBinary)) { throw 'WINDOWS_SERVICE_BINARY_MISSING' }

  $zip = Join-Path $env:TEMP $postgresZipName
  $existingHash = ''
  if (Test-Path -LiteralPath $zip) {
    $existingHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  if ($existingHash -ne $postgresSha) {
    Invoke-WebRequest -Uri $postgresUrl -OutFile $zip
  }
  $downloadedHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadedHash -ne $postgresSha) { throw 'POSTGRES_BINARY_CHECKSUM_MISMATCH' }

  $extract = Join-Path $env:TEMP "zaipos-pg-$postgresVersion"
  if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $extract
  $source = Join-Path $extract "postgresql-$postgresVersion-x86_64-pc-windows-msvc"
  foreach ($required in @('bin\initdb.exe', 'bin\pg_ctl.exe', 'bin\postgres.exe', 'share')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $required))) { throw 'POSTGRES_RUNTIME_INCOMPLETE' }
  }

  $stage = Join-Path $repo '.runtime-stage'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-Item -LiteralPath $serviceBinary -Destination (Join-Path $stage 'zaipos-local-service.exe')
  Copy-Item -LiteralPath (Join-Path $repo 'installer\scripts\install-local-service.ps1') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $repo 'installer\scripts\uninstall-local-service.ps1') -Destination $stage
  $postgres = Join-Path $stage 'postgres'
  New-Item -ItemType Directory -Force -Path $postgres | Out-Null
  foreach ($directory in @('bin', 'lib', 'share')) {
    Copy-Item -LiteralPath (Join-Path $source $directory) -Destination (Join-Path $postgres $directory) -Recurse
  }
  if (-not (Test-Path -LiteralPath (Join-Path $postgres 'bin\initdb.exe'))) { throw 'POSTGRES_INITDB_MISSING' }
}
finally {
  Pop-Location
}
