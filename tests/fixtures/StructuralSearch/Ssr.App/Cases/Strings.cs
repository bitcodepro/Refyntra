namespace Ssr.App.Cases;

public sealed class Strings
{
    private string? _name;

    public bool A(string? s) => s == null || s == ""; // m: empty
    public bool B(string? s) => (s == null) || (s == ""); // m: empty
    public bool C(string? s, string? t) => s == null || t == "";
    public bool D() => _name == null || _name == ""; // m: empty
    public bool E(string? s) => s == null || this._name == "";
    public bool F(int x, int y) => x + x > y + x; // m: twice
    public bool G(int x, int y) => x + y > 0;
}
