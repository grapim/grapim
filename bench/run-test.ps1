# Step 2 of the re-run: the same frozen Grapim (grapim-lean, nothing changed
# since the dev run) on the held-out half: 23 PRs nobody looked at while
# tuning. This is the honest score. About $2 to $3 of Anthropic usage, hard
# stop at $4. PR-Agent is not run again: its answers from the first run are reused.
# The key is asked for without showing it, lives only in this window, and is
# never written to disk.
#   powershell -ExecutionPolicy Bypass -File bench\run-test.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$secure = Read-Host 'Paste your Anthropic API key (it will not show)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

try {
  node bench/run.mjs --yes --tools grapim-lean --split test --results bench/results-v2 --max-usd 4
  node bench/score.mjs --results bench/results-v2 --split test
  Write-Host "`n--- All 46 PRs (dev + held-out) ---" -ForegroundColor Cyan
  node bench/score.mjs --results bench/results-v2
} finally {
  Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
}
Write-Host "`nDone. Reports: bench\results-v2\report-test.md and report.md" -ForegroundColor Green
