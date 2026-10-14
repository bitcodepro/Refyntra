namespace Ssr.App.Cases;

public sealed class Bools
{
    public bool Plain(int x)
    {
        if (x > 0) return true; else return false; // m: bool
    }

    public bool Braced(int x)
    {
        if (x > 0) // m: bool
        {
            return true;
        }
        else
        {
            return false;
        }
    }

    public bool Inverted(int x)
    {
        if (x > 0) return false; else return true;
    }
}
