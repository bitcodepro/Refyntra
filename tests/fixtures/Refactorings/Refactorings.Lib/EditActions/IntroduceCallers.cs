using System;

namespace Refactorings.Lib.EditActions;

internal static class IntroduceCallers
{
    internal static decimal Total(PriceCalculator calc) => calc.Gross(10m) + calc.Gross(20m);

    internal static double Measure(IShape shape) => shape.Size(2.0);
}
