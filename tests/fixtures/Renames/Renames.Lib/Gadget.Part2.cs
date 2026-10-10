namespace Renames.Lib;

public partial class Gadget
{
    public Gadget Twice() => new() { Size = Size * 2 };
}
