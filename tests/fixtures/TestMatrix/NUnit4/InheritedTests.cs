using NUnit.Framework;

namespace NUnit4;

public abstract class ParserTestsBase
{
    [Test]
    public void Parses() => Assert.That(true, Is.True);
}

public class JsonParserTests : ParserTestsBase
{
}
