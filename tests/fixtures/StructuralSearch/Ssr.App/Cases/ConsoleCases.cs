using System;

namespace Ssr.App.Cases;

public sealed class ConsoleCases
{
    public void A(string x)
    {
        Console.WriteLine(x); // m: console
        System.Console.WriteLine(x + "!"); // m: console
        global::System.Console.WriteLine(1); // m: console
        System.Diagnostics.Debug.WriteLine(x);
        Fake.Console.WriteLine(x);
        Console.Write(x);
    }
}
