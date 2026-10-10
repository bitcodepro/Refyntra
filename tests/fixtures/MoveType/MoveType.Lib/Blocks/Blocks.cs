using System;

namespace MoveType.Lib.Blocks
{
    using System.Text;

    public class Alpha
    {
        public string Name() => new StringBuilder("alpha").ToString();
    }

    public class Beta
    {
        public Guid Id { get; } = Guid.NewGuid();
    }
}
