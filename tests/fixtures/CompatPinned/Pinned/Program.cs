namespace Pinned;

public static class Program
{
    public static int Main()
    {
        Console.WriteLine(Describe(8));
        return 0;
    }

    public static string Describe(int major) => "SDK pinned to " + major;
}
