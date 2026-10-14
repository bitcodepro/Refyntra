using Xunit;

namespace XUnit3;

// Tests declared in an abstract and in a generic base class run in each concrete derived class.
public abstract class StoreTestsBase
{
    [Fact]
    public void Opens() => Assert.True(true);

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public void Counts(int n) => Assert.True(n > 0);
}

public class SqlStoreTests : StoreTestsBase
{
    [Fact]
    public void OwnTest() => Assert.True(true);
}

public class MemoryStoreTests : StoreTestsBase
{
}

public abstract class RepositoryTests<T>
{
    [Fact]
    public void Creates() => Assert.NotNull(typeof(T));
}

public class IntRepositoryTests : RepositoryTests<int>
{
}
