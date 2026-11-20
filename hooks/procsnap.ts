// The machine's process list without WMI. Get-CimInstance calls can pile up (dozens of hung
// powershells eat the RAM), so WMI is not used here. procsnap is a small C# program the plugin compiles once
// with the csc of .NET Framework 4 (every Windows has it): Toolhelp32 for ids, parents and names, the process's own
// handle for CPU, working set, start time and command line, GlobalMemoryStatusEx for available RAM. Nothing it calls
// can hang on a service the way WMI does.

/** Bumped whenever PROCSNAP_CS changes: the exe is rebuilt under the new name. */
export const PROCSNAP_VERSION = '1'

/** C# 5 (what csc 4 and PowerShell 5.1 Add-Type compile). Output: "FREE\t<MB>" then pid ppid name MB startMs cpuMs cmd, tab separated. */
export const PROCSNAP_CS = String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ProcSnap {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PE { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [StructLayout(LayoutKind.Sequential)]
  struct PMC { public uint cb, PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage; }
  [StructLayout(LayoutKind.Sequential)]
  struct MS { public uint dwLength, dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PE e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h, out PMC c, uint cb);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MS m);

  /** Available physical memory in MB (free + standby: Task Manager's Available). */
  public static long AvailMb() {
    MS m = new MS();
    m.dwLength = (uint)Marshal.SizeOf(typeof(MS));
    return GlobalMemoryStatusEx(ref m) ? (long)(m.ullAvailPhys / 1048576UL) : -1;
  }

  static string CommandLine(IntPtr h) {
    int ret;
    IntPtr buf = Marshal.AllocHGlobal(65536);
    try {
      // 60 = ProcessCommandLineInformation: a UNICODE_STRING (Length, MaximumLength, Buffer) and its text
      if (NtQueryInformationProcess(h, 60, buf, 65536, out ret) != 0) return "";
      int len = Marshal.ReadInt16(buf) & 0xffff;
      IntPtr s = Marshal.ReadIntPtr(buf, IntPtr.Size);
      return s == IntPtr.Zero ? "" : Marshal.PtrToStringUni(s, len / 2);
    } finally {
      Marshal.FreeHGlobal(buf);
    }
  }

  public static string List() {
    StringBuilder o = new StringBuilder();
    o.Append("FREE\t").Append(AvailMb()).Append('\n');
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == new IntPtr(-1)) return o.ToString();
    PE e = new PE();
    e.dwSize = (uint)Marshal.SizeOf(typeof(PE));
    if (Process32FirstW(snap, ref e)) {
      do {
        long cpu = -1, start = 0, mb = 0;
        string cmd = "";
        IntPtr h = OpenProcess(0x1000, false, e.th32ProcessID); // PROCESS_QUERY_LIMITED_INFORMATION
        if (h != IntPtr.Zero) {
          long c, x, k, u;
          if (GetProcessTimes(h, out c, out x, out k, out u)) { cpu = (k + u) / 10000; start = c > 0 ? (c - 116444736000000000L) / 10000 : 0; }
          PMC p;
          if (GetProcessMemoryInfo(h, out p, (uint)Marshal.SizeOf(typeof(PMC)))) mb = (long)(p.WorkingSetSize.ToUInt64() / 1048576UL);
          cmd = CommandLine(h);
          CloseHandle(h);
        }
        cmd = cmd.Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ');
        o.Append(e.th32ProcessID).Append('\t').Append(e.th32ParentProcessID).Append('\t').Append(e.szExeFile).Append('\t')
          .Append(mb).Append('\t').Append(start).Append('\t').Append(cpu).Append('\t').Append(cmd).Append('\n');
      } while (Process32NextW(snap, ref e));
    }
    CloseHandle(snap);
    return o.ToString();
  }

  public static void Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.Out.Write(args.Length > 0 && args[0] == "--mem" ? AvailMb().ToString() : List());
  }
}
`

export type SnapProc = { pid: number; ppid: number; name: string; mb: number; created: number; cpuMs: number; cmd: string }

/** procsnap's output; null when it is cut off (a short list would make every parent look gone). */
export function parseSnap(out: string): { freeMb: number; procs: SnapProc[] } | null {
  let freeMb = -1
  const procs: SnapProc[] = []
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split('\t')
    if (parts[0] === 'FREE') {
      freeMb = Number(parts[1])
      continue
    }
    const [pid, ppid, name, mb, created, cpu, ...cmd] = parts
    const id = Number(pid)
    if (!pid || !Number.isFinite(id) || id <= 0) continue
    const cpuMs = Number(cpu)
    procs.push({ pid: id, ppid: Number(ppid) || 0, name: (name ?? '').trim(), mb: Number(mb) || 0, created: Number(created) || 0, cpuMs: Number.isFinite(cpuMs) ? cpuMs : -1, cmd: cmd.join(' ').trim() })
  }
  return freeMb >= 0 && procs.length >= 10 ? { freeMb, procs } : null
}

/** `tasklist /FO CSV /NH` (no WMI) as a last resort: ids and names only, no parents or command lines. */
export function parseTasklist(out: string): SnapProc[] {
  const procs: SnapProc[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"([^"]*)","(\d+)"/)
    if (m) procs.push({ pid: Number(m[2]), ppid: 0, name: m[1]!, mb: 0, created: 0, cpuMs: -1, cmd: '' })
  }
  return procs
}
