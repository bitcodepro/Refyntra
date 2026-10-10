namespace Renames.Lib;

public sealed class Widget
{
    public const string TypeName = nameof(Widget);
    public string Describe() => "Widget";

    public void Run(int count) { }
    public void Run(string name) { }
}
