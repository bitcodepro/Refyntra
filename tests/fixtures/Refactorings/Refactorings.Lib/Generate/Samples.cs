using System;
using System.Collections.Generic;

namespace Refactorings.Lib.Generate;

// Generate (Alt+Insert) samples; the tests never write these files.
public class Person
{
    private readonly string _name = "";
    private int _age;
    public string? Email { get; set; }
    public List<string> Tags { get; } = new();

    public int Age => _age;
}

public partial class Order
{
    private readonly int _id;
}

public struct Point
{
    public int X;
    public int Y;
}

public record Money(decimal Amount, string Currency);

public class WithCtor
{
    private readonly int _a;

    public WithCtor(int a)
    {
        _a = a;
    }
}

public interface IShape
{
    double Area();
    string Name { get; }
    event EventHandler? Changed;
}

public abstract class ShapeBase
{
    public abstract double Perimeter();
    public virtual string Describe() => "shape";
    protected virtual void OnChanged(int code) { }
}

public class Circle
{
    public double Radius { get; set; }
}

public class Square : ShapeBase
{
    public override double Perimeter() => 4;
}

public class Logger
{
    public void Log(string message) { }
    public int Count { get; set; }
}

public class Service
{
    private readonly Logger _logger = new();
}
