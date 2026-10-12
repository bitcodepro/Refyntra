namespace AppTests;

public static class GreeterChecks
{
    public static bool Works() => Lib.Greeter.Greeting("x").Length > 0;
}
