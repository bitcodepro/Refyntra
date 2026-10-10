using MoveType.Lib.Blocks;
using MoveType.Lib.Geometry;

namespace MoveType.App;

public static class Uses
{
    public static double Area() => new Circle { Radius = 2 }.Area();
    public static string Name() => new Alpha().Name();
    public static int Sides() => new Square().Sides.Count;
}
