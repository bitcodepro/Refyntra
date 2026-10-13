using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace Refactorings.Lib.EditActions;

public enum ConvShade { Red, Green, Blue }

public class ConvertSamples
{
    private int _state;

    private int Next() => ++_state;

    public string Describe(int code)
    {
        if (code == 1) return "one";
        else if (code == 2 || code == 3) return "few";
        else if (code is > 10) return "many";
        else return "other";
    }

    public int Weight(ConvShade s)
    {
        int w;
        if (s == ConvShade.Red) w = 1;
        else if (s == ConvShade.Green) w = 2;
        else w = 3;
        return w;
    }

    public void Log(int code, List<string> log)
    {
        if (code == 1)
        {
            log.Add("one");
        }
        else if (code == 2)
        {
            log.Add("two");
            log.Add("again");
        }
        else
        {
            log.Add("other");
        }
    }

    public string Mixed(int a, int b)
    {
        if (a == 1) return "a";
        else if (b == 2) return "b";
        return "none";
    }

    public string Named(int code)
    {
        switch (code)
        {
            case 1:
                return "one";
            case 2:
            case 3:
                return "few";
            default:
                return "other";
        }
    }

    public string Statement(int code, List<string> log)
    {
        switch (code)
        {
            case 1:
                log.Add("one");
                return "x";
            default:
                return "y";
        }
    }

    public string Arms(ConvShade s) => s switch
    {
        ConvShade.Red => "red",
        ConvShade.Green or ConvShade.Blue => "cool",
        _ => "?",
    };

    public string NoDefault(ConvShade s)
    {
        return s switch { ConvShade.Red => "red", ConvShade.Green => "green", ConvShade.Blue => "blue" };
    }

    public List<string> Names(List<string> items)
    {
        var result = new List<string>();
        foreach (var item in items)
        {
            if (item.Length > 2)
            {
                result.Add(item.ToUpperInvariant());
            }
        }
        return result;
    }

    public bool HasNegative(int[] values)
    {
        foreach (var v in values)
        {
            if (v < 0) return true;
        }
        return false;
    }

    public bool AllPositive(int[] values)
    {
        foreach (var v in values)
            if (v <= 0) return false;
        return true;
    }

    public string? FirstLong(List<string> items)
    {
        foreach (var item in items)
        {
            if (item.Length > 5) return item;
        }
        return null;
    }

    public int CountEven(int[] values)
    {
        var count = 0;
        foreach (var v in values)
        {
            if (v % 2 == 0) count++;
        }
        return count;
    }

    public int Total(int[] values)
    {
        var total = 0;
        foreach (var v in values) total += v * 2;
        return total;
    }

    public void Busy(int[] values, List<int> log)
    {
        foreach (var v in values)
        {
            log.Add(v);
            if (v > 3) break;
        }
    }

    public string Price(string name, decimal price, int qty) => $"{name,-10}: {price:C2} x{qty}";

    public string Formatted(string name, int qty) => string.Format("{0} has {1,5:D3} items ({0})", name, qty);

    public string Ordered() => string.Format("{1} {0}", Next(), Next());

    public ConvOptions MakeOptions()
    {
        var o = new ConvOptions();
        o.Name = "a";
        o.Size = 2;
        o.On = true;
        return o;
    }

    public ConvOptions SplitOptions()
    {
        var p = new ConvOptions { Name = "b", Size = 3 };
        return p;
    }

    public ConvOptions SelfRef()
    {
        var q = new ConvOptions();
        q.Size = q.Name?.Length ?? 0;
        return q;
    }

    public string ReadAll(string path)
    {
        using (var reader = new StringReader(path))
        {
            return reader.ReadToEnd();
        }
    }

    public int ReadThen(string path)
    {
        using (var reader = new StringReader(path))
        {
            reader.Read();
        }
        return path.Length;
    }

    public int Declared(string path)
    {
        using var r = new StringReader(path);
        var line = r.ReadLine();
        return line?.Length ?? 0;
    }

    public int Compute(int v)
    {
        return v * 2;
    }

    public void Fire()
    {
        Console.WriteLine("fire");
    }

    public Task<int> Fetch() => Task.FromResult(4);

    public async Task<int> Forward()
    {
        return await Fetch();
    }

    public async Task Wait()
    {
        await Task.Delay(1);
    }

    public async Task<int> Guarded()
    {
        try
        {
            return await Fetch();
        }
        catch (InvalidOperationException)
        {
            return 0;
        }
    }
}

public class ConvOptions
{
    public string? Name { get; set; }
    public int Size { get; set; }
    public bool On;
}

public class ConvAccount
{
    private readonly string _owner;
    public int Limit { get; }

    public ConvAccount(string owner, int limit)
    {
        _owner = owner;
        Limit = limit;
    }

    public string Owner() => _owner;
}

public class ConvLedger(string title, int size)
{
    private readonly int _size = size;
    public string Title => title.ToUpperInvariant();
    public int Size => _size;
}

public class ConvTwoCtors
{
    private readonly int _a;
    public ConvTwoCtors(int a) { _a = a; }
    public ConvTwoCtors() { _a = 1; }
    public int A => _a;
}

public class ConvPoint
{
    public ConvPoint(int x, int y)
    {
        X = x;
        Y = y;
    }

    public int X { get; }
    public int Y { get; }
}

public class ConvCounter
{
    public int Value { get; set; }
}

public class ConvCustom
{
    public override bool Equals(object? obj) => obj is ConvCustom;
    public override int GetHashCode() => 1;
}

public record ConvTag
{
    public string Name { get; init; } = "";
}

public record ConvLabel
{
    public string Text { get; init; } = "";

    public ConvLabel Renamed() => this with { Text = "x" };
}

public class ConvProps
{
    public string Name { get; set; } = "n";
    public int Id { get; }

    public ConvProps(int id)
    {
        Id = id;
    }

    private int _age;
    public int Age { get => _age; set => _age = value; }

    private int _level = 3;
    public int Level { get { return _level; } }

    public void Raise() => _level++;
}
