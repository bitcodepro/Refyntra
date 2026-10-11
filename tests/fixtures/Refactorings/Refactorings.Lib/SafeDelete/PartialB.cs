using System;

namespace Refactorings.Lib.SafeDelete
{
    public partial class PartialThing
    {
        public int B { get; set; }
    }

    public sealed class Neighbour
    {
        public DateTime When { get; set; }
    }
}
