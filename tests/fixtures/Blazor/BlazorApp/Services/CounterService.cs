namespace BlazorApp.Services;

public class CounterService
{
    public int Count { get; private set; }

    public void Increment() => Count++;

    public string Describe(int step) => $"{Count} (+{step})";
}
