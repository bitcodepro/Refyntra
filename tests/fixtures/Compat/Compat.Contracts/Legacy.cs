using System;
using System.Collections.Generic;
using System.IO;

namespace Compat.Contracts
{
    // C# 7.3 code (netstandard2.0, default LangVersion): edit actions, postfix templates and conversions must not
    // produce syntax that this language version does not have.
    public class LegacyService
    {
        private readonly IClock _clock;
        private readonly string _name;

        public LegacyService(IClock clock, string name)
        {
            _clock = clock;
            _name = name;
        }

        public string Describe(object value)
        {
            if (value == null)
            {
                return "none";
            }
            string kind;
            switch (value)
            {
                case int i:
                    kind = "int " + i;
                    break;
                case string s:
                    kind = "string " + s;
                    break;
                default:
                    kind = "other";
                    break;
            }
            return _name + ": " + kind + " at " + _clock.Now.Year;
        }

        public List<int> Numbers()
        {
            var list = new List<int> { 1, 2, 3 };
            List<int> copy = new List<int>(list);
            return copy;
        }

        public int Length(string path)
        {
            using (var reader = new StreamReader(path))
            {
                return reader.ReadToEnd().Length;
            }
        }

        public string Label(string text)
        {
            if (text != null)
            {
                if (text.Length > 3)
                {
                    return text.Substring(0, 3);
                }
            }
            return text ?? "";
        }

        public string Cached(Dictionary<string, string> cache, string key)
        {
            string value;
            if (!cache.TryGetValue(key, out value))
            {
                value = key.ToUpperInvariant();
                cache[key] = value;
            }
            return value;
        }

        public int Count(IEnumerable<string> items)
        {
            int n = 0;
            foreach (var item in items)
            {
                if (item != null) n++;
            }
            return n;
        }

        public string Code(int code)
        {
            if (code == 1) return "one";
            else if (code == 2) return "two";
            else return "many";
        }

        public bool IsEmpty(string text)
        {
            if (text is null)
            {
                return true;
            }
            else
            {
                return text.Length == 0;
            }
        }

        public int ReadAll(string path)
        {
            var reader = new StreamReader(path);
            return reader.ReadToEnd().Length;
        }
    }

    public class LegacyPoint
    {
        public int X { get; set; }
        public int Y { get; set; }
    }
}
