// Fixture banner: shapes for the Move Type to File tests.

using System;
using System.Collections.Generic;
using System.Text;
using static System.Math;

namespace MoveType.Lib.Geometry;

/// <summary>A circle.</summary>
[Serializable]
public sealed class Circle
{
    // radius in units
    public double Radius { get; init; }

    public double Area() => PI * Pow(Radius, 2);

    public string Describe() => new StringBuilder().Append("circle ").Append(Radius).ToString();
}

public sealed class Square
{
    public List<int> Sides { get; } = new() { 1, 1, 1, 1 };
}

internal enum Kind
{
    Round,
    Angular,
}
