namespace PreexistingErrors.App;

public interface IStore { }

public sealed class Factory { }

public partial class Holder
{
    // CS8618 (an error with TreatWarningsAsErrors) exists before any rename; renaming Factory must not count it as new.
    private static IStore _store;
    private static Factory _factory = null!;

    public static void Init(IStore store)
    {
        _store = store;
        _factory = new Factory();
    }

    public static Factory Current => _factory;
}
