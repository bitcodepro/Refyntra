namespace Inspections.App.Cases;

public class Format
{
    private const string Fixed = "fixed";

    public string Plain() => string.Format("hello"); // expect: OR1010

    public string Braces() => string.Format("{{x}}"); // expect: OR1010

    public string Constant() => string.Format(Fixed); // expect: OR1010

    public string Throws() => string.Format("{0}"); // expect: OR1010

    // ---- false-positive guards

    public string WithArgument(int x) => string.Format("{0}", x);

    public string Variable(string f) => string.Format(f);

    public string Provider() => string.Format(System.Globalization.CultureInfo.InvariantCulture, "{0}", 1);
}
