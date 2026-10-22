import { describe, expect, it } from 'vitest';
import { type FetchLike, GitHubClient, GitHubError } from '../../src/github';

function fake(responses: Record<string, { status: number; body?: unknown }>) {
  const calls: { method: string; url: string; body?: unknown; auth?: string }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, ...(init.body ? { body: JSON.parse(init.body) } : {}), auth: init.headers.Authorization });
    const r = responses[`${init.method} ${url.replace('https://api.github.com', '')}`] ?? { status: 404, body: { message: 'Not Found' } };
    return { ok: r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
  return { calls, fetchFn };
}

const raw = (n: number) => ({ number: n, title: `PR ${n}`, html_url: `https://github.com/o/r/pull/${n}`, user: { login: 'alice' }, head: { ref: 'feature' }, base: { ref: 'main' } });

describe('GitHub pull requests', () => {
  it('lists open pull requests with the token', async () => {
    const f = fake({ 'GET /repos/o/r/pulls?state=open&per_page=50': { status: 200, body: [raw(1), raw(2)] } });
    const prs = await new GitHubClient('o', 'r', 't0k', f.fetchFn).openPulls();
    expect(prs.map((p) => [p.number, p.author, p.head, p.base])).toEqual([[1, 'alice', 'feature', 'main'], [2, 'alice', 'feature', 'main']]);
    expect(f.calls[0]!.auth).toBe('Bearer t0k');
  });

  it('creates and merges a pull request', async () => {
    const f = fake({ 'POST /repos/o/r/pulls': { status: 201, body: raw(7) }, 'PUT /repos/o/r/pulls/7/merge': { status: 200, body: { sha: 'abc', merged: true, message: 'ok' } } });
    const c = new GitHubClient('o', 'r', 't', f.fetchFn);
    expect((await c.createPull('feature', 'main', 'Title', 'Body')).number).toBe(7);
    expect(f.calls[0]!.body).toEqual({ head: 'feature', base: 'main', title: 'Title', body: 'Body', draft: false });
    expect(await c.mergePull(7, 'squash')).toBe('abc');
    expect(f.calls[1]!.body).toEqual({ merge_method: 'squash' });
  });

  it('reports GitHub errors with their message', async () => {
    const f = fake({ 'POST /repos/o/r/pulls': { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] } } });
    const err = await new GitHubClient('o', 'r', 't', f.fetchFn).createPull('f', 'main', 't', '').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.message).toBe('Validation Failed: A pull request already exists');
    expect(err.status).toBe(422);
  });
});
