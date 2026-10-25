/**
 * The Git tab's model (pure): the commit graph in lanes, branches with their upstream state, the working tree status.
 * git.ts / gitView.ts run git; this file reads its output.
 */

export interface GraphCommit {
  sha: string;
  parents: string[];
  author: string;
  time: number;
  subject: string;
  /** Branch and tag names on the commit ("HEAD -> main", "origin/main", "tag: v1"). */
  refs: string[];
}

/** `git log --format=GRAPH_FORMAT` (records 0x1e, fields 0x1f). */
export const GRAPH_FORMAT = '%x1e%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s';

export function parseGraphLog(text: string): GraphCommit[] {
  const out: GraphCommit[] = [];
  for (const rec of text.split('\x1e')) {
    const f = rec.replace(/\n$/, '').split('\x1f');
    if (f.length < 6 || !/^[0-9a-f]{40}$/.test(f[0]!)) continue;
    out.push({
      sha: f[0]!,
      parents: f[1]!.split(' ').filter(Boolean),
      refs: f[2]!.split(',').map((r) => r.trim()).filter(Boolean),
      author: f[3]!,
      time: Number(f[4]),
      subject: f.slice(5).join('\x1f'),
    });
  }
  return out;
}

export interface GraphRow {
  commit: GraphCommit;
  /** The commit's lane (column). */
  lane: number;
  /** Lanes that pass this row without touching the commit. */
  pass: number[];
  /** Lanes that end in the commit from above (its children's lines). */
  into: number[];
  /** Lanes that leave the commit downwards (one per parent; the first parent continues in `lane` when possible). */
  out: number[];
  /** Number of lanes in use at this row (for the width). */
  width: number;
}

/**
 * Lays commits (newest first, as `git log --date-order`) out in lanes: each lane waits for one sha. A commit takes the
 * lane that waits for it (the leftmost when several children wait); its first parent continues there, the others take
 * the lane that already waits for them or a free one. Lines: `into` (children above → commit), `out` (commit → parents
 * below), `pass` (straight through).
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  const free = (): number => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const c of commits) {
    const waiting = lanes.map((s, i) => (s === c.sha ? i : -1)).filter((i) => i >= 0);
    const lane = waiting.length > 0 ? waiting[0]! : free();
    const pass = lanes.map((s, i) => (s !== null && s !== c.sha ? i : -1)).filter((i) => i >= 0);
    const into = waiting;
    for (const i of waiting) lanes[i] = null;
    const out: number[] = [];
    c.parents.forEach((p, k) => {
      // The first parent continues in the commit's lane even when another lane already waits for it: the lines then
      // meet in the fork commit itself, which shows where a branch was cut from.
      if (k === 0 && lanes[lane] === null) {
        lanes[lane] = p;
        out.push(lane);
        return;
      }
      const existing = lanes.indexOf(p);
      if (existing >= 0) {
        out.push(existing);
        return;
      }
      const target = free();
      lanes[target] = p;
      out.push(target);
    });
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    const width = Math.max(lane + 1, ...pass.map((x) => x + 1), ...out.map((x) => x + 1), ...into.map((x) => x + 1), 1);
    rows.push({ commit: c, lane, pass, into, out, width });
  }
  return rows;
}

export interface Branch {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** The upstream branch is gone (deleted on the remote). */
  gone: boolean;
  sha: string;
}

/** `git for-each-ref --format=BRANCH_FORMAT refs/heads`. */
export const BRANCH_FORMAT = '%(HEAD)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(objectname)';

export function parseBranches(text: string): Branch[] {
  return text
    .split('\n')
    .filter((l) => l.includes('\x1f'))
    .map((l) => {
      const [head, name, upstream, track, sha] = l.split('\x1f');
      return {
        name: name!,
        current: head === '*',
        ...(upstream ? { upstream } : {}),
        ahead: Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0),
        behind: Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0),
        gone: /gone/.test(track ?? ''),
        sha: sha ?? '',
      };
    });
}

/** What git's configuration says about pushing a local branch (each value from `git config --get`). */
export interface PushConfig {
  branch: string;
  /** branch.<name>.remote and branch.<name>.merge: the upstream (none when either is missing). */
  remote?: string;
  merge?: string;
  /** branch.<name>.pushRemote, then remote.pushDefault: where pushes go instead of the upstream's remote. */
  pushRemote?: string;
  pushDefaultRemote?: string;
  /** push.default (git's default: simple). */
  pushDefault?: string;
  /** `git remote`: the remotes there are. */
  remotes: string[];
}

export type PushPlan = { ok: true; args: string[]; label: string } | { ok: false; reason: string };

const shortHead = (ref: string) => ref.replace(/^refs\/heads\//, '');

/**
 * The push of one branch as git would do it for that branch checked out, as an explicit refspec (so a branch that is not
 * checked out goes to the same place): the remote from pushRemote / remote.pushDefault / the upstream, the remote branch
 * from push.default. A branch without an upstream is published (-u) to that remote, else origin or the only remote:
 * Publish names its target, as `git push -u <remote> <branch>` does, so push.default (which applies to a push without
 * one) does not stop it. Refused where git refuses (push.default nothing; simple or upstream with a target git would
 * not choose).
 */
export function pushPlan(c: PushConfig): PushPlan {
  const mode = (c.pushDefault ?? 'simple').toLowerCase();
  const own = `refs/heads/${c.branch}`;
  const pushTo = c.pushRemote ?? c.pushDefaultRemote;
  if (!c.remote || !c.merge) {
    const remote = pushTo ?? (c.remotes.includes('origin') ? 'origin' : c.remotes.length === 1 ? c.remotes[0] : undefined);
    if (!remote) return { ok: false, reason: c.remotes.length ? `${c.branch} has no upstream and there is no origin; choose a remote with git push -u <remote> ${c.branch}.` : 'The repository has no remote to push to.' };
    return { ok: true, args: ['push', '-u', remote, `${own}:${own}`], label: `Publish ${c.branch} to ${remote}` };
  }
  if (mode === 'nothing') return { ok: false, reason: 'push.default is "nothing": git pushes only with an explicit target. Push from a terminal.' };
  const remote = pushTo ?? c.remote;
  const triangular = remote !== c.remote;
  let target: string;
  if (mode === 'current' || mode === 'matching') target = own;
  else if (mode === 'upstream' || mode === 'tracking') {
    if (triangular) return { ok: false, reason: `push.default is "upstream" but pushes go to ${remote}, not to the upstream's remote ${c.remote}; git refuses this push.` };
    target = c.merge;
  } else if (triangular) target = own;
  else if (c.merge === own) target = c.merge;
  else {
    return { ok: false, reason: `${c.branch} tracks ${c.remote}/${shortHead(c.merge)}, which has another name; with push.default "simple" git refuses this push. Set push.default to "upstream" to push to it, or push from a terminal.` };
  }
  return { ok: true, args: ['push', remote, `${own}:${target}`], label: `Push ${c.branch} to ${remote}/${shortHead(target)}` };
}

export interface FileChange {
  path: string;
  /** For a rename: the old path. */
  from?: string;
  /** One letter: M modified, A added, D deleted, R renamed, U conflict, ? untracked. */
  status: string;
  staged: boolean;
}

/** `git status --porcelain=v1 -z` → staged and unstaged entries (a file changed in both appears twice). */
export function parseStatus(text: string): FileChange[] {
  const parts = text.split('\0');
  const out: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const x = e[0]!;
    const y = e[1]!;
    const file = e.slice(3);
    let from: string | undefined;
    if (x === 'R' || x === 'C') from = parts[++i];
    if (x === '?' && y === '?') {
      out.push({ path: file, status: '?', staged: false });
      continue;
    }
    const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    if (conflict) {
      out.push({ path: file, status: 'U', staged: false });
      continue;
    }
    if (x !== ' ') out.push({ path: file, ...(from ? { from } : {}), status: x, staged: true });
    if (y !== ' ') out.push({ path: file, status: y, staged: false });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- commit details

export interface FileStat {
  path: string;
  /** For a rename: the old path. */
  from?: string;
  added: number;
  deleted: number;
  /** A binary file (git prints "-"). */
  binary: boolean;
}

/** `git show --numstat -z --format= <sha>` (or `git diff --numstat -z`) → files with added / deleted line counts. */
export function parseNumstat(text: string): FileStat[] {
  const out: FileStat[] = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]!.replace(/^\n+/, '');
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    const binary = m[1] === '-';
    let file = m[3]!;
    let from: string | undefined;
    // A rename: the path field is empty and the old and new paths follow as two more entries.
    if (file === '') {
      from = parts[++i];
      file = parts[++i] ?? '';
    }
    out.push({ path: file, ...(from ? { from } : {}), added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary });
  }
  return out;
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  /** Line numbers in the old and new file (absent for the other side). */
  old?: number;
  new?: number;
}

/** A unified diff of one file → lines with their kind and numbers (headers before the first hunk dropped). */
export function parsePatch(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of text.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      out.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+')) out.push({ kind: 'add', text: raw.slice(1), new: newNo++ });
    else if (raw.startsWith('-')) out.push({ kind: 'del', text: raw.slice(1), old: oldNo++ });
    else if (raw.startsWith(' ')) out.push({ kind: 'ctx', text: raw.slice(1), old: oldNo++, new: newNo++ });
    else if (raw.startsWith('diff --git')) inHunk = false;
  }
  return out;
}

/** owner/repo of a GitHub remote URL (https or ssh); undefined for another host. */
export function gitHubRepoOf(url: string): { owner: string; repo: string } | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : undefined;
}

export type SearchMode = 'message' | 'code' | 'author';

/** The git log arguments of a search: in commit messages (--grep), in code changes (-S, pickaxe) or by author. */
export function searchArgs(text: string, mode: SearchMode, branch: string | undefined): string[] {
  const where = branch ? [branch] : ['--all'];
  const what = mode === 'message' ? ['-i', `--grep=${text}`, '--fixed-strings'] : mode === 'author' ? ['-i', `--author=${text}`, '--fixed-strings'] : [`-S${text}`];
  return ['log', ...where, '--date-order', ...what, '-n', '200'];
}
