<#
.SYNOPSIS
  给 claude-bridge 递一个任务并等结果。
.DESCRIPTION
  先试 HTTP（POST /run）；桥没起来时会自动拉起 standalone\bridge.cjs 再重试。
.EXAMPLE
  .\ask.ps1 "把 README 里的示例改成可运行"
  .\ask.ps1 -Resume -SessionId 6bede325-c04e-405a-8681-85a1e060931d "继续上一轮的改动"
#>
param(
  [Parameter(Position = 0, Mandatory = $true)][string]$Prompt,
  [string]$Cwd,
  [string]$Model,
  [int]$TimeoutSec = 900,
  [switch]$Resume,
  [string]$SessionId,
  [switch]$Last,
  [switch]$Json
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 8788
$Base = "http://127.0.0.1:$Port"

function Test-Bridge {
  try { $null = Invoke-RestMethod -Uri "$Base/health" -TimeoutSec 3; return $true } catch { return $false }
}

if (-not (Test-Bridge)) {
  Write-Host "[ask] 桥没在跑，拉起 standalone\bridge.cjs ..."
  Start-Process -FilePath 'node' -ArgumentList @((Join-Path $BridgeDir 'bridge.cjs')) `
    -WorkingDirectory $BridgeDir -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (Test-Bridge) { break } }
  if (-not (Test-Bridge)) { throw "claude-bridge 起不来：先手动跑 node `"$BridgeDir\bridge.cjs`" 看报错" }
}

$payload = @{ prompt = $Prompt; timeoutMs = $TimeoutSec * 1000 }
if ($Cwd) { $payload.cwd = (Resolve-Path $Cwd).Path }
if ($Model) { $payload.model = $Model }
if ($Last) { $payload.last = $true }
if ($SessionId) { $payload.sessionId = $SessionId }
$path = if ($Resume -or $SessionId -or $Last) { '/resume' } else { '/run' }

$body = $payload | ConvertTo-Json -Compress
$resp = Invoke-RestMethod -Uri "$Base$path" -Method Post -Body $body -ContentType 'application/json; charset=utf-8' -TimeoutSec ($TimeoutSec + 60)

if ($Json) { $resp | ConvertTo-Json -Depth 8; return }
Write-Host ("[ask] status={0}  {1:N1}s  turns={2}  cost=`${3}" -f $resp.status, (($resp.durationMs)/1000), $resp.numTurns, $resp.costUsd)
if ($resp.sessionId) { Write-Host "[ask] sessionId=$($resp.sessionId)   （续接：.\ask.ps1 -SessionId $($resp.sessionId) `"...`"）" }
if ($resp.error) { Write-Host "[ask] error: $($resp.error)" }
Write-Host '---- result ----'
if ($resp.result) { $resp.result } else { $resp.stdout; $resp.stderr }