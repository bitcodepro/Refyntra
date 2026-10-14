namespace Ssr.App.Cases;

public sealed class Repo
{
    public int GetCount() => 0; // m: member
    public int Fetch() => 0;
    public int Use(Repo r) => r.GetCount() + r.Fetch(); // m: getter
}
