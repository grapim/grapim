# Step 1 of the re-run: the improved Grapim on the dev half (23 PRs), diff-only
# variant (grapim-lean). About $3 to $4 of Anthropic usage, hard stop at $5. PR-Agent is not run
# again: its answers from the first run are reused.
# The key is asked for without showing it, lives only in this window, and is
# never written to disk.
#   powershell -ExecutionPolicy Bypass -File bench\run-dev.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$secure = Read-Host 'Paste your Anthropic API key (it will not show)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

try {
  node bench/run.mjs --yes --tools grapim-lean --split dev --results bench/results-v2 --max-usd 5
  node bench/score.mjs --results bench/results-v2 --split dev
} finally {
  Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
}
Write-Host "`nDone. Report: bench\results-v2\report-dev.md" -ForegroundColor Green
