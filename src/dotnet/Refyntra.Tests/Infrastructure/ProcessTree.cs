using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Refyntra.Tests.Infrastructure;

/// <summary>Lists the live descendants of a process (Windows: Toolhelp snapshot; Linux: /proc).</summary>
public static class ProcessTree
{
    public sealed record Proc(int Pid, int ParentPid, string Name);

    public static IReadOnlyList<Proc> All()
    {
        if (OperatingSystem.IsWindows()) return WindowsAll();
        var list = new List<Proc>();
        foreach (var dir in Directory.EnumerateDirectories("/proc"))
        {
            if (!int.TryParse(Path.GetFileName(dir), out var pid)) continue;
            try
            {
                var stat = File.ReadAllText(Path.Combine(dir, "stat"));
                var close = stat.LastIndexOf(')');
                var name = stat[(stat.IndexOf('(') + 1)..close];
                var rest = stat[(close + 2)..].Split(' ');
                list.Add(new Proc(pid, int.Parse(rest[1]), name));
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        return list;
    }

    /// <summary>Descendants of <paramref name="rootPid"/> (transitively) that are alive now.</summary>
    public static IReadOnlyList<Proc> Descendants(int rootPid)
    {
        var all = All();
        var starts = new Dictionary<int, DateTime?>();
        var result = new List<Proc>();
        var frontier = new HashSet<int> { rootPid };
        bool grew;
        do
        {
            grew = false;
            foreach (var p in all)
                if (p.Pid != rootPid && frontier.Contains(p.ParentPid) && !result.Contains(p) && !StartedBefore(p.Pid, p.ParentPid, starts))
                {
                    result.Add(p);
                    frontier.Add(p.Pid);
                    grew = true;
                }
        } while (grew);
        return result;
    }

    /// <summary>
    /// True when <paramref name="pid"/> started before its recorded parent: Windows keeps a parent pid after the parent
    /// exits, and that pid can be reused by a newer process (e.g. our host), which would adopt an unrelated older
    /// process (seen in CI: a PING.EXE "orphaned after the host exited"). A child never starts before its parent.
    /// </summary>
    private static bool StartedBefore(int pid, int parentPid, Dictionary<int, DateTime?> starts)
    {
        var child = StartOf(pid, starts);
        var parent = StartOf(parentPid, starts);
        return child != null && parent != null && child < parent;
    }

    private static DateTime? StartOf(int pid, Dictionary<int, DateTime?> starts)
    {
        if (starts.TryGetValue(pid, out var known)) return known;
        DateTime? start;
        try
        {
            using var p = Process.GetProcessById(pid);
            start = p.StartTime;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            start = null;
        }
        starts[pid] = start;
        return start;
    }

    /// <summary>True when a process with this pid is still running (and has not been replaced by an unrelated one started later).</summary>
    public static bool IsAlive(int pid, DateTime startedBefore)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            if (p.HasExited) return false;
            return p.StartTime <= startedBefore;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static IReadOnlyList<Proc> WindowsAll()
    {
        var list = new List<Proc>();
        var snap = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
        if (snap == new IntPtr(-1)) return list;
        try
        {
            var e = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
            if (!Process32FirstW(snap, ref e)) return list;
            do list.Add(new Proc((int)e.th32ProcessID, (int)e.th32ParentProcessID, e.szExeFile));
            while (Process32NextW(snap, ref e));
        }
        finally
        {
            CloseHandle(snap);
        }
        return list;
    }
}
