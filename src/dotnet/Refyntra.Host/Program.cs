using System.Text;
using Refyntra.Host;
using Refyntra.Host.Rpc;
using Refyntra.Workspaces;

// stdout carries protocol frames only: take the raw stream first, then route every Console.Out write to stderr
// so that nothing (our code, MSBuild, Roslyn) can corrupt the protocol stream.
var stdout = Console.OpenStandardOutput();
var stdin = Console.OpenStandardInput();
var stderr = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true };
Console.SetOut(stderr);
Console.SetError(stderr);
Log.Writer = stderr;
Log.Info("host", $"Refyntra.Host {Engine.EngineVersion} starting (pid {Environment.ProcessId})");
ChildProcessGuard.Install();

using var engine = new Engine();
var server = new RpcServer(stdin, stdout, engine);
int code;
try
{
    code = await server.RunAsync();
}
catch (Exception ex)
{
    Log.Error("host", "fatal: " + ex.GetType().Name + ": " + ex.Message);
    code = 2;
}
engine.Dispose();
ChildProcessGuard.KillDescendants();
Log.Info("host", $"exiting with code {code}");
return code;
