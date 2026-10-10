using System.Collections.Generic;
using System;

namespace Cleanup.App.Services;

public static class Tidy
{
    public static List<int> Empty() => new();

    public static DateTime Epoch => DateTime.UnixEpoch;
}
