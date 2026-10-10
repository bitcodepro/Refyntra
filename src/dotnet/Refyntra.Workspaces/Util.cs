using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis.Text;

namespace Refyntra.Workspaces;

/// <summary>Conversions between VS Code file URIs (Uri.toString()) and local paths.</summary>
public static class UriPaths
{
    public static readonly StringComparer PathComparer =
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    /// <summary>Accepts VS Code style (file:///c%3A/x/y.cs) and .NET style (file:///C:/x/y.cs) URIs.</summary>
    public static string ToPath(string uri)
    {
        if (string.IsNullOrEmpty(uri)) throw new ArgumentException("Empty uri");
        if (!uri.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Only file: URIs are supported");
        var rest = uri.Substring(5);
        var authority = "";
        if (rest.StartsWith("//", StringComparison.Ordinal))
        {
            rest = rest.Substring(2);
            var slash = rest.IndexOf('/');
            authority = slash < 0 ? rest : rest.Substring(0, slash);
            rest = slash < 0 ? "/" : rest.Substring(slash);
        }
        var path = Uri.UnescapeDataString(rest);
        if (authority.Length > 0 && OperatingSystem.IsWindows())
            return Path.GetFullPath(@"\\" + authority + path.Replace('/', '\\'));
        if (OperatingSystem.IsWindows())
        {
            if (path.Length >= 3 && path[0] == '/' && char.IsLetter(path[1]) && path[2] == ':')
                path = path.Substring(1);
            path = path.Replace('/', '\\');
            if (path.Length >= 2 && path[1] == ':') path = char.ToUpperInvariant(path[0]) + path.Substring(1);
        }
        return Path.GetFullPath(path);
    }

    /// <summary>Produces the same string as VS Code's <c>Uri.file(path).toString()</c>.</summary>
    public static string ToUri(string path)
    {
        var p = path.Replace('\\', '/');
        var authority = "";
        if (p.StartsWith("//", StringComparison.Ordinal))
        {
            var idx = p.IndexOf('/', 2);
            authority = idx < 0 ? p.Substring(2) : p.Substring(2, idx - 2);
            p = idx < 0 ? "/" : p.Substring(idx);
        }
        else if (p.Length >= 2 && p[1] == ':')
        {
            p = "/" + char.ToLowerInvariant(p[0]) + p.Substring(1);
        }
        else if (!p.StartsWith('/'))
        {
            p = "/" + p;
        }
        return "file://" + Encode(authority.ToLowerInvariant(), false) + Encode(p, true);
    }

    private static string Encode(string s, bool keepSlash)
    {
        var sb = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(s))
        {
            var c = (char)b;
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                c == '-' || c == '.' || c == '_' || c == '~' || (keepSlash && c == '/'))
                sb.Append(c);
            else
                sb.Append('%').Append(b.ToString("X2"));
        }
        return sb.ToString();
    }
}

public static class Hashing
{
    public static string Sha256Text(string text) => Sha256Bytes(Encoding.UTF8.GetBytes(text));
    public static string Sha256Bytes(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    public static string ShortId(string text, int len = 16) => Sha256Text(text).Substring(0, len);

    /// <summary>Hash of a file's bytes, or "absent".</summary>
    public static string FileBytes(string path)
    {
        try { return File.Exists(path) ? Sha256Bytes(File.ReadAllBytes(path)) : "absent"; }
        catch (IOException) { return "unreadable"; }
        catch (UnauthorizedAccessException) { return "unreadable"; }
    }

    /// <summary>Hash of a file's decoded text (BOM stripped, line endings kept), or "absent".</summary>
    public static string FileText(string path)
    {
        try { return File.Exists(path) ? Sha256Text(File.ReadAllText(path)) : "absent"; }
        catch (IOException) { return "unreadable"; }
        catch (UnauthorizedAccessException) { return "unreadable"; }
    }
}

/// <summary>Reading source files from disk the way the loaded snapshot did.</summary>
public static class TextFiles
{
    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    /// <summary>
    /// True when the bytes are valid UTF-8 (optionally with a UTF-8 BOM). UTF-16/UTF-32 BOMs and legacy code pages are
    /// not UTF-8: the extension cannot reproduce such a file's text exactly, so edits are refused.
    /// </summary>
    public static bool IsUtf8(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length >= 2 && ((bytes[0] == 0xFF && bytes[1] == 0xFE) || (bytes[0] == 0xFE && bytes[1] == 0xFF))) return false;
        if (bytes.Length >= 4 && bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 0xFE && bytes[3] == 0xFF) return false;
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) bytes = bytes[3..];
        try
        {
            StrictUtf8.GetCharCount(bytes);
            return true;
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
    }

    /// <summary>
    /// The decoded text of a file (BOM honoured, otherwise <paramref name="encoding"/>, UTF-8 by default), or null
    /// when the file is missing or unreadable. Pass the encoding Roslyn detected for the document so that a legacy
    /// encoded file gives the same text as the snapshot.
    /// </summary>
    public static string? TryRead(string path, Encoding? encoding)
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return SourceText.From(stream, encoding ?? new UTF8Encoding(false)).ToString();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            return null;
        }
    }

    /// <summary>"absent" / "unreadable" / SHA-256 of the decoded text (see <see cref="TryRead"/>).</summary>
    public static string HashText(string path, Encoding? encoding)
    {
        if (!File.Exists(path)) return "absent";
        var text = TryRead(path, encoding);
        return text == null ? "unreadable" : Hashing.Sha256Text(text);
    }

    /// <summary>"crlf", "lf", "cr", "mixed" or "none" (no line break).</summary>
    public static string LineEndings(string text)
    {
        bool crlf = false, lf = false, cr = false;
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '\r')
            {
                if (i + 1 < text.Length && text[i + 1] == '\n') { crlf = true; i++; }
                else cr = true;
            }
            else if (text[i] == '\n') lf = true;
        }
        var kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0);
        return kinds > 1 ? "mixed" : crlf ? "crlf" : lf ? "lf" : cr ? "cr" : "none";
    }
}

/// <summary>Structured stderr logging (one JSON object per line). Never put source text in messages.</summary>
public static class Log
{
    private static readonly object Gate = new();
    public static TextWriter Writer { get; set; } = Console.Error;

    public static void Write(string level, string component, string msg, string? traceId = null, string? op = null,
        double? durationMs = null, string? status = null)
    {
        try
        {
            var line = JsonSerializer.Serialize(new Dictionary<string, object?>
            {
                ["ts"] = DateTimeOffset.UtcNow.ToString("O"),
                ["level"] = level,
                ["component"] = component,
                ["traceId"] = traceId,
                ["op"] = op,
                ["durationMs"] = durationMs,
                ["status"] = status,
                ["msg"] = msg,
            });
            lock (Gate) { Writer.WriteLine(line); Writer.Flush(); }
        }
        catch
        {
            // logging must never fail the host
        }
    }

    public static void Info(string component, string msg, string? traceId = null) => Write("info", component, msg, traceId);
    public static void Warn(string component, string msg, string? traceId = null) => Write("warn", component, msg, traceId);
    public static void Error(string component, string msg, string? traceId = null) => Write("error", component, msg, traceId);
}

/// <summary>An error that maps to a JSON-RPC error with <c>data.reasonCode</c>.</summary>
public sealed class EngineException : Exception
{
    public int Code { get; }
    public string ReasonCode { get; }
    public string? Recovery { get; }

    public EngineException(int code, string reasonCode, string message, string? recovery = null) : base(message)
    {
        Code = code;
        ReasonCode = reasonCode;
        Recovery = recovery;
    }
}

public static class ErrorCodes
{
    public const int ParseError = -32700, InvalidRequest = -32600, MethodNotFound = -32601, InvalidParams = -32602,
        InternalError = -32603, Cancelled = -32800, ProtocolMismatch = -33001, NotInitialized = -33002, TrustRequired = -33003,
        StaleSnapshot = -33004, UnknownSymbol = -33005, WorkspaceNotLoaded = -33006, SdkNotFound = -33007, BarrierTimeout = -33008;
}
