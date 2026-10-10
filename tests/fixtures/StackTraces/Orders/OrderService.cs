namespace Sample.Orders;

public sealed class OrderService
{
    private readonly Repository<int> _repo = new();

    public int Load(int id) => _repo.Get(id, strict: true);

    public int Load(string code) => code.Length;

    public async Task<int> LoadAllAsync(int count)
    {
        await Task.Yield();
        return Enumerable.Range(0, count).Where(i => i % 2 == 0).Sum();
    }

    public int Run(int x)
    {
        return Validate(x) + 1;

        static int Validate(int value) => value < 0 ? throw new ArgumentOutOfRangeException(nameof(value)) : value;
    }

    public sealed class Nested
    {
        public void Inner()
        {
        }
    }
}
