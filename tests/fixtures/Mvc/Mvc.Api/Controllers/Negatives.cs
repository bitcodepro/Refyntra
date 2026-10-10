namespace Foreign
{
    /// <summary>Same name as ASP.NET Core's attribute, different identity.</summary>
    public sealed class HttpGetAttribute : System.Attribute
    {
        public HttpGetAttribute(string template) => Template = template;
        public string Template { get; }
    }
}

namespace Mvc.Api.Controllers
{
    /// <summary>Not a controller: a class with Get methods and a foreign HttpGet attribute.</summary>
    public sealed class ReportService
    {
        [Foreign.HttpGet("/foreign/report")]
        public string GetReport() => "";

        public string Get() => "";
    }
}
