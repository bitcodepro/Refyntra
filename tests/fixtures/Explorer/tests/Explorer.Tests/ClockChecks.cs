namespace Explorer.Tests;

public class ClockChecks
{
    public bool Works() => new Explorer.Core.Services.Clock().Now().Year > 2000;
}
