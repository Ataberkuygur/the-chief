# start-bridge.ps1 — Tab Bridge: one command, idempotent.
#   powershell -ExecutionPolicy Bypass -File start-bridge.ps1
# 1) If a real bridge already answers /health -> reuse it.
# 2) An old copy of the bridge on 127.0.0.1:8765 is replaced; any other program there -> stop with an error.
# 3) Start node server.js hidden, log to bridge.log.
# 4) Wait up to 40s for the Chrome extension to connect (extConnected=true).
$ErrorActionPreference = 'Stop'
$Port = 8765
$Dir  = $PSScriptRoot
$Url  = "http://127.0.0.1:$Port/health"

function Get-Health {
  try { return Invoke-RestMethod -Uri $Url -TimeoutSec 2 } catch { return $null }
}
function Test-IsBridge($h) { # an old bridge (no 'ws' field in /health) has no /ws endpoint, so it counts as not-ours and is replaced
  return ($h -ne $null) -and ($h.PSObject.Properties.Name -contains 'extConnected') -and ($h.PSObject.Properties.Name -contains 'ws') }

$h = Get-Health
if (-not (Test-IsBridge $h)) {
  # Only an old copy of this bridge is replaced; another program on the port is never killed
  $old = ($h -ne $null) -and ($h.PSObject.Properties.Name -contains 'extConnected')
  $owners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
  if ($owners -and -not $old) { Write-Host "FAIL: port $Port is used by another program (PID $($owners -join ', ')). Close it, then run this again."; exit 1 }
  foreach ($procId in $owners) {
    Write-Host "Replacing old bridge PID $procId"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
  Start-Process -FilePath node -ArgumentList "`"$Dir\server.js`"" -WorkingDirectory $Dir -WindowStyle Hidden `
    -RedirectStandardOutput "$Dir\bridge.log" -RedirectStandardError "$Dir\bridge.err.log"
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 300; $h = Get-Health; if (Test-IsBridge $h) { break } }
  if (-not (Test-IsBridge $h)) { Write-Host "FAIL: bridge server did not start. See $Dir\bridge.err.log"; exit 1 }
  Write-Host "Bridge server started on 127.0.0.1:$Port"
} else {
  Write-Host "Bridge server already running."
}

# Wait for the Chrome extension (it polls every <=2s, keepalive alarm every 30s)
for ($i = 0; $i -lt 40; $i++) {
  $h = Get-Health
  if ($h.extConnected) { Write-Host "OK: Chrome extension connected."; exit 0 }
  Start-Sleep -Seconds 1
}
Write-Host @"
WARN: server is up but the Chrome extension is NOT connected.
 -> Open chrome://extensions , find 'Tab Bridge', click the reload (circular arrow) icon.
 -> If it's not installed: Developer mode ON -> Load unpacked -> $Dir\ext
Then run this script again.
"@
exit 2
