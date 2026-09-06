param(
    [Parameter(Mandatory=$true)][string]$RuntimeRoot,
    [Parameter(Mandatory=$true)][string]$StoreLevel,
    [string]$DataRoot = "E:\LANTIVO_DENUE_NACIONAL",
    [string]$OutRoot = "E:\LANTIVO_DENUE_NACIONAL\CANNIBALIZATION_EQUIVALENCE_GATE_V1"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Abort([string]$m) { throw "ABORT: $m" }

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Assembler = Join-Path $Here "assemble_sources.py"
$PartsDir = Join-Path $Here "source_parts"
$AssembledDir = Join-Path $OutRoot "SOURCE_ASSEMBLED"
$Prepare = Join-Path $AssembledDir "prepare_snapshot.py"
$Gate = Join-Path $AssembledDir "gate.ts"
$SnapshotDir = Join-Path $OutRoot "SNAPSHOT"
$ResultDir = Join-Path $OutRoot "RESULTS"
$SnapshotIndex = Join-Path $SnapshotDir "SNAPSHOT_INDEX.json"
$Zip = Join-Path $OutRoot "CANNIBALIZATION_EQUIVALENCE_GATE_V1_RESULTS.zip"
$ZipSha = "$Zip.sha256.txt"

foreach ($p in @($Assembler,$PartsDir,$RuntimeRoot,$StoreLevel)) {
    if (-not (Test-Path -LiteralPath $p)) { Abort "falta $p" }
}

$head = (& git -C $RuntimeRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { Abort "git rev-parse HEAD falló" }
if ($head -ne "9409214fb4d003d1a34d5348e5923113f0ef695d") {
    Abort "runtime HEAD=$head; esperaba 9409214fb4d003d1a34d5348e5923113f0ef695d"
}

$py = (Get-Command py -ErrorAction SilentlyContinue)
if ($py) { $Python = $py.Source; $PyArgs = @("-3") }
else {
    $p3 = (Get-Command python -ErrorAction SilentlyContinue)
    if (-not $p3) { Abort "no encontré py ni python" }
    $Python = $p3.Source; $PyArgs = @()
}

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunCmd) {
    $candidate = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    if (Test-Path -LiteralPath $candidate) { $Bun = $candidate }
    else { Abort "no encontré bun; instala/ubica Bun antes de ejecutar el gate" }
} else { $Bun = $bunCmd.Source }

New-Item -ItemType Directory -Force -Path $SnapshotDir,$ResultDir,$AssembledDir | Out-Null

Write-Host "[0/2] Reensamblando fuentes auditadas y verificando SHA256..." -ForegroundColor Yellow
& $Python @PyArgs $Assembler --parts-dir $PartsDir --out-dir $AssembledDir
if ($LASTEXITCODE -ne 0) { Abort "assemble_sources.py terminó con código $LASTEXITCODE" }
foreach ($p in @($Prepare,$Gate)) { if (-not (Test-Path -LiteralPath $p)) { Abort "fuente ensamblada faltante $p" } }

Write-Host "================================================================================================" -ForegroundColor Cyan
Write-Host " LANTIVO — CANNIBALIZATION EQUIVALENCE GATE V1" -ForegroundColor Cyan
Write-Host " READ-ONLY remoto · evidencia local solamente" -ForegroundColor Cyan
Write-Host "================================================================================================" -ForegroundColor Cyan
Write-Host "HEAD       : $head"
Write-Host "Runtime    : $RuntimeRoot"
Write-Host "STORE_LEVEL: $StoreLevel"
Write-Host "Out        : $OutRoot"
Write-Host ""

Write-Host "[1/2] Preparando snapshot local certificado..." -ForegroundColor Yellow
& $Python @PyArgs $Prepare --root $DataRoot --out-dir $SnapshotDir --mode local-certified
if ($LASTEXITCODE -ne 0) { Abort "prepare_snapshot.py terminó con código $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $SnapshotIndex)) { Abort "no se generó SNAPSHOT_INDEX.json" }

Write-Host ""
Write-Host "[2/2] Ejecutando oráculo TS vivo pinned..." -ForegroundColor Yellow
Push-Location $RuntimeRoot
try {
    & $Bun $Gate --runtime-root $RuntimeRoot --snapshot-index $SnapshotIndex --store-level $StoreLevel --out-dir $ResultDir
    if ($LASTEXITCODE -ne 0) { Abort "gate.ts terminó con código $LASTEXITCODE" }
}
finally { Pop-Location }

if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
$toZip = @(
    (Join-Path $ResultDir "REPORT.json"),
    (Join-Path $ResultDir "SUMMARY.txt"),
    (Join-Path $ResultDir "STORE_LEVEL_RUNTIME_EQUIVALENT.csv"),
    (Join-Path $ResultDir "BRAND_SUMMARY.csv"),
    (Join-Path $ResultDir "DENSITY_STRATA.csv"),
    (Join-Path $ResultDir "MATCH_DELTA.csv"),
    (Join-Path $ResultDir "FILTER_DELTA.csv"),
    (Join-Path $ResultDir "DEDUPE_AUDIT.csv"),
    (Join-Path $ResultDir "DEDUPE_CONTEXT_DELTA.csv"),
    (Join-Path $ResultDir "IDENTITY_AUDIT.csv"),
    (Join-Path $ResultDir "COORDINATE_COLLISIONS.csv"),
    (Join-Path $ResultDir "EMPLOYEE_CACHE_AUDIT.csv"),
    (Join-Path $ResultDir "HASHES.txt"),
    (Join-Path $SnapshotDir "SNAPSHOT_REPORT.json"),
    (Join-Path $SnapshotDir "HASHES.txt")
)
foreach ($p in $toZip) { if (-not (Test-Path -LiteralPath $p)) { Abort "resultado faltante $p" } }
Compress-Archive -LiteralPath $toZip -DestinationPath $Zip -CompressionLevel Optimal
$h = (Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash.ToLowerInvariant()
"$h  $([IO.Path]::GetFileName($Zip))" | Set-Content -LiteralPath $ZipSha -Encoding ASCII

Write-Host ""
Write-Host "PASS — ejecución terminada; cero writes externos." -ForegroundColor Green
Write-Host "RESULTS: $ResultDir"
Write-Host "ZIP    : $Zip"
Write-Host "SHA256 : $h"
Write-Host ""
Write-Host "NO ejecutar score/policy después de esto: primero entregar ZIP + SHA a Claude para segunda firma." -ForegroundColor Yellow
