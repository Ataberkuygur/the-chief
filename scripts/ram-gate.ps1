# The Chief RAM gate, the part that must run with no chat open: started at logon by a scheduled task.
# Under 1.8 GB free it ends one heavy tree a step: the newest vitest, else the newest heavy root when there is more
# than one (never ffmpeg, never the last build). The same rule as criticalKill in hooks/heavygate.ts; while this runs
# (hq/ram-gate.json fresh) the chats leave the kill to it and keep only the slot pausing.
# No WMI (the owner's ban after 19.10, when hung Get-CimInstance calls ate the RAM): free RAM and the process list
# come from procsnap.exe, the plugin's own helper in the hq folder; without it, free RAM from GlobalMemoryStatusEx
# and no kill (a list without command lines cannot tell a build from anything else).
# One copy at a time (a named mutex). Log: ~/.claude/the-chief/hq/ram-gate.log
$critMb = 1800
$hq = Join-Path $env:USERPROFILE '.claude\the-chief\hq'
New-Item -ItemType Directory -Force $hq | Out-Null
$beat = Join-Path $hq 'ram-gate.json'
$log = Join-Path $hq 'ram-gate.log'
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\TheChiefRamGate', [ref]$created)
if (-not $created) { exit 0 }
function Log($m) { Add-Content $log ("{0} {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $m) }
$heavyCmd = 'typescript[\\/]bin[\\/]tsc\b|(^|[\s"''\\/])tsc(\.cmd|\.js)?(\s|"|$)|vitest|dependency-cruise|depcruise'
$notHeavy = 'tsserver|typingsInstaller|--watch\b'
function IsHeavy($p) { $p.Name -match '^(node|bun)(\.exe)?$' -and $p.CommandLine -match $heavyCmd -and $p.CommandLine -notmatch $notHeavy }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GateMem {
  [StructLayout(LayoutKind.Sequential)]
  struct MS { public uint dwLength, dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual; }
  [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MS m);
  public static long AvailMb() { MS m = new MS(); m.dwLength = (uint)Marshal.SizeOf(typeof(MS)); return GlobalMemoryStatusEx(ref m) ? (long)(m.ullAvailPhys / 1048576UL) : -1; }
}
'@
# the newest procsnap-<version>.exe (never a half-built procsnap-<version>-<id>.exe)
function Snap() { Get-ChildItem $hq -Filter 'procsnap-*.exe' | Where-Object { $_.Name -match '^procsnap-\d+\.exe$' } | Sort-Object { [int]($_.Name -replace '\D', '') } -Descending | Select-Object -First 1 }
Log "start pid $PID crit $critMb MB (no WMI)"
while ($true) {
  [IO.File]::WriteAllText($beat, ('{{"pid":{0},"at":{1}}}' -f $PID, [DateTimeOffset]::Now.ToUnixTimeMilliseconds()))
  $free = [GateMem]::AvailMb()
  if ($free -ge 0 -and $free -lt $critMb) {
    $exe = Snap
    if (-not $exe) { Log "free $free MB: no procsnap.exe yet, nothing ended"; Start-Sleep 5; continue }
    $all = @(& $exe.FullName | ForEach-Object {
      $f = $_ -split "`t", 7
      if ($f.Count -ge 7 -and $f[0] -ne 'FREE') { [pscustomobject]@{ ProcessId = [int]$f[0]; ParentProcessId = [int]$f[1]; Name = $f[2]; Created = [long]$f[4]; CommandLine = $f[6] } }
    })
    $byId = @{}; foreach ($p in $all) { $byId[$p.ProcessId] = $p }
    $heavy = @($all | Where-Object { IsHeavy $_ })
    $heavyIds = @{}; foreach ($p in $heavy) { $heavyIds[$p.ProcessId] = $true }
    # roots: heavy processes with no heavy ancestor (a vitest's workers go with it)
    $roots = @($heavy | Where-Object {
      $cur = $byId[$_.ParentProcessId]; $seen = @{}; $under = $false
      while ($cur -and -not $seen[$cur.ProcessId]) {
        $seen[$cur.ProcessId] = $true
        if ($heavyIds[$cur.ProcessId]) { $under = $true; break }
        $cur = $byId[$cur.ParentProcessId]
      }
      -not $under
    } | Sort-Object Created -Descending)
    $pick = $roots | Where-Object { $_.CommandLine -match 'vitest' } | Select-Object -First 1
    if (-not $pick -and $roots.Count -gt 1) { $pick = $roots[0] }
    if ($pick) {
      taskkill /PID $pick.ProcessId /T /F | Out-Null
      $cmd = ($pick.CommandLine -replace '\s+', ' ')
      Log ("free {0} MB: ended {1} {2}" -f $free, $pick.ProcessId, $cmd.Substring(0, [Math]::Min(140, $cmd.Length)))
    }
    Start-Sleep 4
  } else { Start-Sleep 5 }
}
