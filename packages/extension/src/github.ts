/**
 * Pull requests on GitHub through its REST API (list, create, merge). The token comes from VS Code's own GitHub sign-in
 * (vscode.authentication, the built-in GitHub provider): no other extension, no token stored by Refyntra. Network only
 * when the user opens the pull requests or acts on one.
 */

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  head: string;
  base: string;
  url: string;
  draft: boolean;
  /** "clean", "dirty" (conflicts), "blocked", "unstable", "unknown"… as GitHub reports it. */
  mergeableState?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class GitHubClient {
  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly token: string,
    private readonly fetchFn: FetchLike,
    private readonly api = 'https://api.github.com',
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.fetchFn(`${this.api}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Refyntra', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) {
      let message = `GitHub answered ${r.status}`;
      try {
        const j = (await r.json()) as { message?: string; errors?: { message?: string }[] };
        message = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(': ') || message;
      } catch {
        // No JSON body.
      }
      throw new GitHubError(message, r.status);
    }
    return (r.status === 204 ? undefined : await r.json()) as T;
  }

  async openPulls(): Promise<PullRequest[]> {
    const list = await this.call<RawPull[]>('GET', '/pulls?state=open&per_page=50');
    return list.map(toPull);
  }

  /** `headRepo`: the repository of a cross-repository head (owner:branch), so GitHub does not have to guess it. */
  async createPull(head: string, base: string, title: string, body: string, draft = false, headRepo?: string): Promise<PullRequest> {
    return toPull(await this.call<RawPull>('POST', '/pulls', { head, base, title, body, draft, ...(headRepo ? { head_repo: headRepo } : {}) }));
  }

  /** Merges a pull request (merge commit, squash or rebase); the merge commit's sha. */
  async mergePull(number: number, method: 'merge' | 'squash' | 'rebase' = 'merge'): Promise<string> {
    const r = await this.call<{ sha: string; merged: boolean; message: string }>('PUT', `/pulls/${number}/merge`, { merge_method: method });
    if (!r.merged) throw new GitHubError(r.message || 'not merged', 405);
    return r.sha;
  }

  async defaultBranch(): Promise<string> {
    return (await this.call<{ default_branch: string }>('GET', '')).default_branch;
  }

  /** The repository and its fork network (the root of its forks: `source`, or itself when it is not a fork). */
  async repository(): Promise<{ fullName: string; network: string }> {
    const r = await this.call<{ full_name: string; source?: { full_name: string } }>('GET', '');
    return { fullName: r.full_name, network: r.source?.full_name ?? r.full_name };
  }
}

interface RawPull {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  user?: { login?: string };
  head: { ref: string };
  base: { ref: string };
  mergeable_state?: string;
}

function toPull(p: RawPull): PullRequest {
  return {
    number: p.number,
    title: p.title,
    author: p.user?.login ?? '',
    head: p.head.ref,
    base: p.base.ref,
    url: p.html_url,
    draft: !!p.draft,
    ...(p.mergeable_state ? { mergeableState: p.mergeable_state } : {}),
  };
}
