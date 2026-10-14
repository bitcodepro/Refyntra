namespace Ssr.App.Cases;

public sealed class Formats
{
    public string A(int a, int b, int c, int d) =>
        string.Format("{0}", a) // m: format
        + string.Format("{0}{1}{2}", a, b, c) // m: format
        + string.Format("{0}{1}{2}{3}", a, b, c, d)
        + string.Format("x");
}
