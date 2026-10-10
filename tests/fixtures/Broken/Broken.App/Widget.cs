namespace Broken.App;

public sealed class Widget
{
    public string Describe() => "widget";
}

public static class WidgetUser
{
    public static string Use() => new Widget().Describe();
}
