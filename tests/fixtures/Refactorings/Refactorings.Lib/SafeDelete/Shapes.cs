namespace Refactorings.Lib.SafeDelete;

public interface IShape
{
    double Area();

    string Describe();
}

public sealed class Circle : IShape
{
    public double Area() => 3;

    public string Describe() => "circle";
}

public sealed class Square : IShape
{
    public double Area() => 4;

    public string Describe() => "square";
}

public static class ShapeUse
{
    public static double Total(IShape shape) => shape.Area();
}

public abstract class Animal
{
    public virtual string Sound() => "";
}

public sealed class Dog : Animal
{
    public override string Sound() => "woof";
}
