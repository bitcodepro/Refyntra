using System.Diagnostics;
using System.Runtime.InteropServices;
using Refyntra.Workspaces;

namespace Refyntra.Host;

/// <summary>
/// No orphan child processes. Roslyn starts BuildHost processes (and they start conhost/MSBuild
/// nodes); when the host exits — gracefully or because it was killed — none of them may survive.
/// <list type="bullet">
/// <item>Windows: the host puts itself into a Job Object with KILL_ON_JOB_CLOSE. Children inherit the job; when the
/// host process ends for any reason the OS closes the last job handle and terminates every remaining member.</item>
/// <item>Linux/macOS: there is no Job Object, and the host cannot run code after SIGKILL. Roslyn starts BuildHost itself
/// (BuildHostProcessManager is internal, no hook for PR_SET_PDEATHSIG or a custom start), BuildHost's stdin is
/// /dev/null and, observed with Roslyn 5.9 on Linux, it stays alive re-parented to init when the host is killed.
/// So the host makes itself a process-group leader (children inherit the group) and starts a watchdog:
/// <c>/bin/sh -c 'read _; kill -s KILL 0'</c> (its own group = the host's) whose stdin is a pipe only the host holds (the pipe is close-on-exec,
/// so BuildHost does not inherit it). When the host ends for any reason the kernel closes the write end, <c>read</c>
/// returns and the watchdog kills the whole group (itself included). On a graceful exit <see cref="KillDescendants"/>
/// also walks /proc. Residual cases: a descendant that leaves the group (setsid/setpgid), or the watchdog itself being
/// killed first (e.g. SIGKILL of the whole group by someone else, which then kills the children anyway); the extension
/// additionally kills the host's group when it disposes the host (packages/infrastructure/src/process.ts).</item>
/// </list>
/// </summary>
internal static class ChildProcessGuard
{
    private static IntPtr _job; // kept open for the whole process lifetime on purpose

    private static Process? _watchdog; // its stdin pipe must stay open (held by this process) until the process ends

    public static void Install()
    {
        if (!OperatingSystem.IsWindows())
        {
            InstallWatchdog();
            return;
        }
        try
        {
            var job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                Log.Warn("host", $"child process guard: CreateJobObject failed ({Marshal.GetLastWin32Error()})");
                return;
            }
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            var size = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
            var ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)size))
                {
                    Log.Warn("host", $"child process guard: SetInformationJobObject failed ({Marshal.GetLastWin32Error()})");
                    CloseHandle(job);
                    return;
                }
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
            {
                Log.Warn("host", $"child process guard: AssignProcessToJobObject failed ({Marshal.GetLastWin32Error()})");
                CloseHandle(job);
                return;
            }
            _job = job;
            Log.Info("host", "child process guard: job object installed");
        }
        catch (Exception ex)
        {
            Log.Warn("host", "child process guard unavailable: " + ex.GetType().Name);
        }
    }

    private static void InstallWatchdog()
    {
        try
        {
            var self = Environment.ProcessId;
            // Already a group leader when the extension started us detached (setsid); otherwise become one so the group
            // holds only this host and its descendants. Never kill a group we do not lead (e.g. a test runner's).
            if (getpgid(0) != self && setpgid(0, 0) != 0)
            {
                Log.Warn("host", $"child process guard: setpgid failed ({Marshal.GetLastPInvokeError()})");
                return;
            }
            if (getpgid(0) != self) return;
            var psi = new ProcessStartInfo("/bin/sh")
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            psi.ArgumentList.Add("-c");
            // "kill -s KILL 0" = the caller's own process group (POSIX); dash rejects "kill -KILL -- -PGID".
            psi.ArgumentList.Add("read _; kill -s KILL 0");
            psi.ArgumentList.Add("refyntra-watchdog");
            _watchdog = Process.Start(psi);
            Log.Info("host", $"child process guard: watchdog {_watchdog?.Id} guards process group {self}");
        }
        catch (Exception ex)
        {
            Log.Warn("host", "child process guard (watchdog) unavailable: " + ex.GetType().Name);
        }
    }

    /// <summary>Graceful exit on non-Windows: kill descendants that are still running.</summary>
    public static void KillDescendants()
    {
        if (OperatingSystem.IsWindows() || !Directory.Exists("/proc")) return;
        try
        {
            var self = Environment.ProcessId;
            var parents = new Dictionary<int, int>();
            foreach (var dir in Directory.EnumerateDirectories("/proc"))
            {
                if (!int.TryParse(Path.GetFileName(dir), out var pid)) continue;
                try
                {
                    var stat = File.ReadAllText(Path.Combine(dir, "stat"));
                    var rest = stat[(stat.LastIndexOf(')') + 2)..].Split(' ');
                    parents[pid] = int.Parse(rest[1]);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            var tree = new HashSet<int> { self };
            bool grew;
            do
            {
                grew = false;
                foreach (var (pid, ppid) in parents)
                    if (tree.Contains(ppid) && tree.Add(pid)) grew = true;
            } while (grew);
            tree.Remove(self);
            foreach (var pid in tree)
                try { using var p = Process.GetProcessById(pid); p.Kill(entireProcessTree: true); } catch { }
        }
        catch (Exception ex)
        {
            Log.Warn("host", "killing child processes failed: " + ex.GetType().Name);
        }
    }

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("libc", SetLastError = true)]
    private static extern int setpgid(int pid, int pgid);

    [DllImport("libc", SetLastError = true)]
    private static extern int getpgid(int pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr attributes, string? name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
