namespace Tiny;

public sealed record GetOrderQuery(int Id);

public static class Program
{
    public static void Main() => System.Console.WriteLine(new GetOrderQuery(1));
}
