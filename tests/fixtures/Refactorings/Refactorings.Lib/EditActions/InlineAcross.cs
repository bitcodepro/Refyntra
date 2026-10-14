namespace Refactorings.Lib.EditActions;

/// <summary>Inline Method across files: the declarations here, the calls in InlineAcrossCallers.cs and the App project.</summary>
public static class Pricing
{
    public const decimal Rate = 0.2m;

    public static decimal WithTax(decimal net) => net * (1 + Rate);

    public static decimal Doubled(decimal x) => x * 2;

    internal static decimal Hidden(decimal x) => x + Secret;

    private static readonly decimal Secret = 1m;
}
