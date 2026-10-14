namespace Refactorings.Lib.EditActions;

internal static class InlineAcrossCallers
{
    public static decimal Total(decimal a, decimal b) => Pricing.WithTax(a) + Pricing.WithTax(b);

    public static decimal Twice(decimal a) => Pricing.Doubled(a);

    public static decimal UsesHidden(decimal a) => Pricing.Hidden(a);
}
