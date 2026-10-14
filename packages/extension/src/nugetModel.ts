// NuGet model (pure: no vscode, no network, no file system). Parses the NuGet V3 API responses the Manage NuGet
// Packages panel reads (service index, search, flat-container versions), the JSON of `dotnet package search`, and the
// file names of a local folder feed; builds the panel's rows. Network policy (ADR-013): only the sources of the user's
// NuGet configuration, only when the user asks (search, versions, check for updates), no credentials handled here.
import { compareVersions } from './projectOpsModel';

export interface ServiceIndex {
  search?: string;
  packageBaseAddress?: string;
}

/** The resources Refyntra uses from a V3 service index (index.json). */
export function parseServiceIndex(json: unknown): ServiceIndex {
  const resources = (json as { resources?: unknown })?.resources;
  const out: ServiceIndex = {};
  if (!Array.isArray(resources)) return out;
  const find = (prefix: string) => {
    const hits = resources.filter((r) => r && typeof r['@id'] === 'string' && typeof r['@type'] === 'string' && (r['@type'] as string).startsWith(prefix));
    // Prefer the plain type, then the highest versioned one (SearchQueryService/3.5.0 …).
    hits.sort((a, b) => (a['@type'] === prefix ? -1 : b['@type'] === prefix ? 1 : String(b['@type']).localeCompare(String(a['@type']))));
    return hits[0]?.['@id'] as string | undefined;
  };
  const search = find('SearchQueryService');
  const base = find('PackageBaseAddress');
  if (search) out.search = search;
  if (base) out.packageBaseAddress = base.endsWith('/') ? base : `${base}/`;
  return out;
}

export interface SearchHit {
  id: string;
  version: string;
  description: string;
  authors: string;
  totalDownloads?: number;
  verified: boolean;
  versions: string[];
  /** Where it came from (a source URL or folder). */
  source: string;
  deprecated?: boolean;
  vulnerable?: boolean;
}

/** A V3 search URL (SearchQueryService): q, skip, take, prerelease, semVerLevel 2.0.0. */
export function searchUrl(base: string, term: string, opts: { skip?: number; take?: number; prerelease?: boolean } = {}): string {
  const q = new URLSearchParams({ q: term, skip: String(opts.skip ?? 0), take: String(opts.take ?? 30), prerelease: String(!!opts.prerelease), semVerLevel: '2.0.0' });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

export function parseSearch(json: unknown, source: string): SearchHit[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: SearchHit[] = [];
  for (const d of data) {
    if (!d || typeof d.id !== 'string' || typeof d.version !== 'string') continue;
    const authors = Array.isArray(d.authors) ? d.authors.filter((a: unknown) => typeof a === 'string').join(', ') : typeof d.authors === 'string' ? d.authors : '';
    const versions = Array.isArray(d.versions) ? d.versions.map((v: { version?: unknown }) => v?.version).filter((v: unknown): v is string => typeof v === 'string') : [];
    out.push({
      id: d.id,
      version: d.version,
      description: typeof d.description === 'string' ? d.description : '',
      authors,
      ...(typeof d.totalDownloads === 'number' ? { totalDownloads: d.totalDownloads } : {}),
      verified: d.verified === true,
      versions: versions.sort((a: string, b: string) => compareVersions(b, a)),
      source,
      ...(Array.isArray(d.vulnerabilities) && d.vulnerabilities.length ? { vulnerable: true } : {}),
      ...(d.deprecation ? { deprecated: true } : {}),
    });
  }
  return out;
}

/** {base}/{id-lower}/index.json of the flat container (PackageBaseAddress/3.0.0). */
export function versionsUrl(packageBaseAddress: string, id: string): string {
  return `${packageBaseAddress}${encodeURIComponent(id.toLowerCase())}/index.json`;
}

export function parseVersions(json: unknown): string[] {
  const v = (json as { versions?: unknown })?.versions;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').sort((a, b) => compareVersions(b, a)) : [];
}

/** `dotnet package search --format json`: { searchResult: [{ sourceName, packages: [{ id, latestVersion, totalDownloads, owners }] }] }. */
export function parsePackageSearchJson(text: string): { hits: SearchHit[]; problems: string[] } {
  let doc: unknown;
  try {
    const start = text.indexOf('{');
    doc = JSON.parse(start > 0 ? text.slice(start) : text);
  } catch {
    return { hits: [], problems: ['The output of dotnet package search was not JSON.'] };
  }
  const hits: SearchHit[] = [];
  const problems: string[] = [];
  const results = (doc as { searchResult?: unknown })?.searchResult;
  for (const r of Array.isArray(results) ? results : []) {
    const source = typeof r?.sourceName === 'string' ? r.sourceName : '';
    if (Array.isArray(r?.problems)) for (const p of r.problems) problems.push(`${source}: ${String(p?.text ?? p)}`);
    for (const p of Array.isArray(r?.packages) ? r.packages : []) {
      if (!p || typeof p.id !== 'string') continue;
      const version = typeof p.latestVersion === 'string' ? p.latestVersion : typeof p.version === 'string' ? p.version : '';
      hits.push({ id: p.id, version, description: typeof p.description === 'string' ? p.description : '', authors: typeof p.owners === 'string' ? p.owners : '', ...(typeof p.totalDownloads === 'number' ? { totalDownloads: p.totalDownloads } : {}), verified: false, versions: version ? [version] : [], source });
    }
  }
  return { hits, problems };
}

/**
 * A local folder feed: file paths relative to the folder ("x.1.0.0.nupkg" flat, or "x/1.0.0/x.1.0.0.nupkg"
 * hierarchical) → packages and their versions. Ids come from the hierarchical folder when present; in a flat folder the
 * split between id and version is the first ".<digit>" group that parses as a version.
 */
export function parseLocalFeed(relativePaths: readonly string[], source: string): SearchHit[] {
  const byId = new Map<string, { id: string; versions: Set<string> }>();
  const add = (id: string, version: string) => {
    const key = id.toLowerCase();
    const e = byId.get(key) ?? { id, versions: new Set<string>() };
    byId.set(key, e);
    e.versions.add(version);
  };
  for (const raw of relativePaths) {
    const p = raw.replace(/\\/g, '/');
    if (!/\.nupkg$/i.test(p) || /\.symbols\.nupkg$/i.test(p)) continue;
    const parts = p.split('/');
    if (parts.length >= 3) {
      add(parts[parts.length - 3]!, parts[parts.length - 2]!);
      continue;
    }
    const stem = parts[parts.length - 1]!.replace(/\.nupkg$/i, '');
    const m = /^(.+?)\.(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?)$/.exec(stem);
    if (m) add(m[1]!, m[2]!);
  }
  return [...byId.values()]
    .map((e) => {
      const versions = [...e.versions].sort((a, b) => compareVersions(b, a));
      return { id: e.id, version: versions[0]!, description: '', authors: '', verified: false, versions, source };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function filterHits(hits: readonly SearchHit[], term: string): SearchHit[] {
  const t = term.trim().toLowerCase();
  if (!t) return [...hits];
  return hits.filter((h) => h.id.toLowerCase().includes(t) || h.description.toLowerCase().includes(t));
}

/** Merges hits of several sources: one row per id, the highest version wins, versions united. */
export function mergeHits(lists: readonly SearchHit[][]): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  for (const list of lists)
    for (const h of list) {
      const key = h.id.toLowerCase();
      const cur = byId.get(key);
      if (!cur) {
        byId.set(key, { ...h, versions: [...h.versions] });
        continue;
      }
      const versions = [...new Set([...cur.versions, ...h.versions])].sort((a, b) => compareVersions(b, a));
      const newer = compareVersions(h.version, cur.version) > 0;
      byId.set(key, { ...(newer ? h : cur), versions, description: cur.description || h.description, source: newer ? h.source : cur.source });
    }
  return [...byId.values()];
}

export function formatDownloads(n: number | undefined): string {
  if (n === undefined) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** HTTP status → whether the source needs credentials (then `dotnet package search` with the user's credential providers). */
export function needsCredentials(status: number): boolean {
  return status === 401 || status === 403;
}
