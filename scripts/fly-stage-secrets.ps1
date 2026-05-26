param(
  [string]$EnvFile = ".env",
  [string]$FlyToml = "fly.toml",
  [string]$App = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
  return Split-Path -Parent $PSScriptRoot
}

function Get-AppNameFromFlyToml {
  param([string]$Path)

  foreach ($line in Get-Content -Path $Path) {
    if ($line -match '^\s*app\s*=\s*"([^"]+)"\s*$') {
      return $matches[1]
    }
  }

  throw "Could not find app name in $Path."
}

function Get-FlyTomlEnvNames {
  param([string]$Path)

  $names = New-Object System.Collections.Generic.HashSet[string]
  $inEnvBlock = $false

  foreach ($line in Get-Content -Path $Path) {
    if ($line -match '^\s*\[env\]\s*$') {
      $inEnvBlock = $true
      continue
    }

    if ($inEnvBlock -and $line -match '^\s*\[') {
      break
    }

    if ($inEnvBlock -and $line -match '^\s*([A-Z0-9_]+)\s*=') {
      [void]$names.Add($matches[1])
    }
  }

  return $names
}

function Normalize-EnvValue {
  param([string]$Value)

  $normalized = $Value.Trim()

  if (
    $normalized.Length -ge 2 -and
    (
      ($normalized.StartsWith('"') -and $normalized.EndsWith('"')) -or
      ($normalized.StartsWith("'") -and $normalized.EndsWith("'"))
    )
  ) {
    $normalized = $normalized.Substring(1, $normalized.Length - 2)
  }

  $normalized = $normalized.Trim()
  $normalized = $normalized -replace '\\r$', ''
  $normalized = $normalized -replace '\\n$', ''

  return $normalized
}

function Read-EnvPairs {
  param([string]$Path)

  $pairs = [ordered]@{}

  foreach ($rawLine in Get-Content -Path $Path) {
    $line = $rawLine.Trim()

    if (-not $line -or $line.StartsWith("#")) {
      continue
    }

    $separatorIndex = $line.IndexOf("=")
    if ($separatorIndex -lt 1) {
      continue
    }

    $key = $line.Substring(0, $separatorIndex).Trim()
    $value = Normalize-EnvValue($line.Substring($separatorIndex + 1))

    if (-not $key -or -not $value) {
      continue
    }

    $pairs[$key] = $value
  }

  return $pairs
}

$repoRoot = Get-RepoRoot
$envPath = Join-Path $repoRoot $EnvFile
$flyTomlPath = Join-Path $repoRoot $FlyToml
$flyctlPath = Join-Path $env:USERPROFILE ".fly\bin\flyctl.exe"

if (-not (Test-Path -LiteralPath $envPath)) {
  throw "Env file not found: $envPath"
}

if (-not (Test-Path -LiteralPath $flyTomlPath)) {
  throw "Fly config file not found: $flyTomlPath"
}

if (-not (Test-Path -LiteralPath $flyctlPath)) {
  throw "Fly CLI not found at $flyctlPath"
}

if (-not $App) {
  $App = Get-AppNameFromFlyToml -Path $flyTomlPath
}

$flyHostname = "https://$App.fly.dev"
$flyConfigDir = Join-Path $repoRoot ".fly-config"
$flyTomlEnvNames = Get-FlyTomlEnvNames -Path $flyTomlPath
$envPairs = Read-EnvPairs -Path $envPath
$secretsToImport = [ordered]@{}

foreach ($entry in $envPairs.GetEnumerator()) {
  if ($flyTomlEnvNames.Contains($entry.Key)) {
    continue
  }

  $secretsToImport[$entry.Key] = $entry.Value
}

$secretsToImport["WEBHOOK_URL"] = $flyHostname
$secretsToImport["PAJCASH_WEBHOOK_BASE_URL"] = $flyHostname

if ($secretsToImport.Count -eq 0) {
  throw "No secret/env values were selected for import."
}

$env:FLY_CONFIG_DIR = $flyConfigDir

if ($DryRun) {
  Write-Host "Fly app: $App"
  Write-Host "Env source: $envPath"
  Write-Host "FLY_CONFIG_DIR: $flyConfigDir"
  Write-Host ""
  Write-Host "The following keys will be staged as Fly secrets:"
  foreach ($key in $secretsToImport.Keys) {
    if ($key -eq "WEBHOOK_URL" -or $key -eq "PAJCASH_WEBHOOK_BASE_URL") {
      Write-Host "  $key (overridden to Fly hostname)"
    } else {
      Write-Host "  $key"
    }
  }
  exit 0
}

$secretPayload = ($secretsToImport.GetEnumerator() | ForEach-Object {
  "$($_.Key)=$($_.Value)"
}) -join "`n"

$tempFile = Join-Path $flyConfigDir "staged-secrets.txt"

try {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tempFile, $secretPayload, $utf8NoBom)

  $command = "`"$flyctlPath`" secrets import --stage --app $App < `"$tempFile`" 2>&1"
  $output = & cmd.exe /d /c $command
  $exitCode = $LASTEXITCODE

  if ($output) {
    $rendered = ($output | ForEach-Object { "$_" }) -join [Environment]::NewLine
    if ($exitCode -eq 0) {
      Write-Host $rendered.TrimEnd()
    } else {
      Write-Error $rendered.TrimEnd()
    }
  }

  if ($exitCode -ne 0) {
    exit $exitCode
  }
} finally {
  if (Test-Path -LiteralPath $tempFile) {
    Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
  }
}
