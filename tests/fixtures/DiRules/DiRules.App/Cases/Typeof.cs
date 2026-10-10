namespace DiRules.App.Cases;

// Case "typeof" (positive): the typeof registration forms.
public interface IUserSession { string User { get; } }
public sealed class UserSession : IUserSession { public string User => ""; }
public interface ISessionCache { }
public sealed class SessionCache : ISessionCache
{
    public SessionCache(IUserSession session) => _ = session;
}

public static class TypeofCase
{
    public static IServiceCollection AddTypeofCase(this IServiceCollection services)
    {
        services.AddScoped(typeof(IUserSession), typeof(UserSession));
        services.AddSingleton(typeof(ISessionCache), typeof(SessionCache));
        return services;
    }
}
