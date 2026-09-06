$ErrorActionPreference = "Stop"

$ExpectedStudySha256 = "c9a79e291a95770517df00c7f1f8dc5bf754a1d8bf5036c8a8013bed2d5494bf"
$Study = Join-Path $PSScriptRoot "CANNIBALIZATION_SPACING_STUDY_V1_3_FAST_EXACT_AUDIT_CANDIDATE.py"
$Root = "E:\LANTIVO_DENUE_NACIONAL"
$OutDir = Join-Path $Root "CANNIBALIZATION_SPACING_STUDY_V1_3"
$ScriptVersion = "CANNIBALIZATION_SPACING_STUDY_V1_3_FAST_EXACT"
$Report = Join-Path $OutDir ($ScriptVersion + "_REPORT.json")
$Hashes = Join-Path $OutDir ($ScriptVersion + "_HASHES.txt")

function Fail([string]$Message) {
    Write-Host "NO-GO: $Message" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path -LiteralPath $Study)) { Fail "no existe study V1.3: $Study" }
$ActualStudySha256 = (Get-FileHash -LiteralPath $Study -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualStudySha256 -ne $ExpectedStudySha256) {
    Fail "SHA256 study drift actual=$ActualStudySha256 expected=$ExpectedStudySha256"
}
if (Test-Path -LiteralPath $OutDir) {
    Fail "anti-stale: OUT_DIR ya existe y V1.3 no reutiliza outputs: $OutDir"
}

$UsePyLauncher = [bool](Get-Command py -ErrorAction SilentlyContinue)
if (-not $UsePyLauncher -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
    Fail "no encuentro py ni python en PATH"
}

Write-Host "================================================================================================" -ForegroundColor Cyan
Write-Host " LANTIVO — CANNIBALIZATION SPACING STUDY V1.3 FAST EXACT" -ForegroundColor Cyan
Write-Host " SHA256 SOURCE PASS: $ActualStudySha256" -ForegroundColor Green
Write-Host " DESCRIPTIVE ONLY | NO R/C/Pmax | NO SCORE | NO PRODUCTION WRITES" -ForegroundColor Yellow
Write-Host "================================================================================================" -ForegroundColor Cyan

# Native exit code is authoritative. PASS is printed ONLY after a zero exit and postconditions.
if ($UsePyLauncher) {
    & py -3 $Study
} else {
    & python $Study
}
$StudyExit = $LASTEXITCODE
if ($StudyExit -ne 0) {
    Fail "V1.3 Python exit=$StudyExit. PASS del runner queda bloqueado."
}

if (-not (Test-Path -LiteralPath $Report)) { Fail "Python terminó 0 pero falta REPORT: $Report" }
if (-not (Test-Path -LiteralPath $Hashes)) { Fail "Python terminó 0 pero falta HASHES: $Hashes" }

try {
    $R = Get-Content -LiteralPath $Report -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Fail "REPORT JSON ilegible: $($_.Exception.Message)"
}

if ($R.schema -ne $ScriptVersion) { Fail "REPORT schema drift: $($R.schema)" }
if ($R.verdict -ne "DESCRIPTIVE_STUDY_COMPLETE_NOT_POLICY_AUTHORIZATION") {
    Fail "REPORT verdict inesperado: $($R.verdict)"
}
if ([int64]$R.source.official_denue_zip_rows_scanned -ne 6138075) {
    Fail "RAW ZIP scan != 6,138,075: $($R.source.official_denue_zip_rows_scanned)"
}
if ($R.policy_authorization -ne $false -or $R.score_change_authorized -ne $false) {
    Fail "REPORT autorizó policy/score inesperadamente"
}

Write-Host ""
Write-Host "================================================================================================" -ForegroundColor Green
Write-Host " PASS — V1.3 RUNNER — ESTUDIO DESCRIPTIVO COMPLETO" -ForegroundColor Green
Write-Host "================================================================================================" -ForegroundColor Green
Write-Host "REPORT : $Report"
Write-Host "HASHES : $Hashes"
Write-Host "RAW     : 6,138,075"
Write-Host "NEXT    : compartir REPORT/CSV/HASHES con Claude. NO tocar policy/score todavía." -ForegroundColor Yellow
exit 0
