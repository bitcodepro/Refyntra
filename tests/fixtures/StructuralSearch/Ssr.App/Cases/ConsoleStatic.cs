using static System.Console;
using C = System.Console;

namespace Ssr.App.Cases;

public sealed class ConsoleStatic
{
    public void A(string x)
    {
        WriteLine(x); // m: console
        C.WriteLine(x); // m: console
        Write(x);
    }
}
