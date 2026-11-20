# Takes a lock directory with its `owner` file already inside: built under a temporary name, then renamed to the lock
# name (a rename onto an existing directory fails), so a lock never exists without an owner.
# Usage: take-lock.ps1 -Lock C:/repo/locks/tsc [-Owner text]; exit 0 = taken, 1 = held by someone else.
param([Parameter(Mandatory)][string]$Lock, [string]$Owner = "pid $PID $([DateTimeOffset]::Now.ToUnixTimeSeconds()) $env:CLAUDE_CODE_SESSION_ID")
$tmp = "$Lock.tmp.$PID"
New-Item -ItemType Directory -Path $tmp -ErrorAction Stop | Out-Null
Set-Content -LiteralPath (Join-Path $tmp 'owner') -Value $Owner
try { [System.IO.Directory]::Move($tmp, $Lock); exit 0 }
catch { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue; exit 1 }
