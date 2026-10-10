using Shop.Api.Generated;

namespace Shop.Api.Services;

public static class OrderMetricsUser
{
    public static int Count() => OrderMetrics.Requests;
}
