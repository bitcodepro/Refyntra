using System.Runtime.CompilerServices;
using Refyntra.Workspaces;

namespace Refyntra.Tests.Infrastructure;

/// <summary>The persistent project index of the tests lives in a temp folder of the test process, never in the user's cache.</summary>
internal static class ProjectCacheSetup
{
    [ModuleInitializer]
    internal static void Init() => ProjectCache.FolderOverride = Path.Combine(Path.GetTempPath(), "refyntra-test-project-index-" + Environment.ProcessId);
}
