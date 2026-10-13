using System.Diagnostics.CodeAnalysis;
using System.Threading.Tasks;

namespace Inspections.App.Cases;

// Suppressions: nothing in this file is reported.
public class Suppressed
{
    private static Task<int> GetAsync() => Task.FromResult(42);

#pragma warning disable OR1002
    public int Pragma() => GetAsync().Result;
#pragma warning restore OR1002

    [SuppressMessage("Usage", "OR1003:Avoid async void", Justification = "test")]
    public async void Attribute()
    {
        await Task.Yield();
    }

    [SuppressMessage("Refyntra", "OR1010")]
    public string Member() => string.Format("x");

#pragma warning disable
    public int All() => GetAsync().GetAwaiter().GetResult();
#pragma warning restore
}
