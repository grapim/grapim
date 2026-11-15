# The real benchmark run: Grapim (no notes) vs PR-Agent on all 46 PRs,
# capped at $14 of Anthropic usage. Asks for the API key without showing it;
# the key lives only in this PowerShell window and is never written to disk.
#   powershell -ExecutionPolicy Bypass -File bench\run-real.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$secure = Read-Host 'Paste your Anthropic API key (it will not show)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:ANTHROPIC_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

$env:BENCH_PR_AGENT_CMD = "$env:LOCALAPPDATA\Temp\claude\83a280354eafb2a3\acacf5c2-cad8-45d1-9cd3-dd8a06dcb198\scratchpad\pragent-venv\Scripts\python.exe -m pr_agent.cli"
$tools = 'grapim-noprov,pr-agent'

Write-Host "`nStep 1: trial on 3 PRs (cap `$1)" -ForegroundColor Cyan
node bench/run.mjs --yes --tools $tools --limit 3 --max-usd 1

$go = Read-Host "`nCheck the cost above. Run all 46 PRs, capped at `$14? (y/n)"
if ($go -ne 'y') { Write-Host 'Stopped.'; Remove-Item Env:ANTHROPIC_API_KEY; exit 0 }

Write-Host "`nStep 2: all PRs (the 3 done are skipped; cap `$14)" -ForegroundColor Cyan
node bench/run.mjs --yes --tools $tools --max-usd 14
node bench/score.mjs --tools $tools
Remove-Item Env:ANTHROPIC_API_KEY
Write-Host "`nDone. Report: bench\results\report.md" -ForegroundColor Green
