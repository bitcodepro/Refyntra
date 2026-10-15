import { describe, expect, it } from 'vitest';
import { activeContext, branchOfHead, gitDirOfFile, contextForBranch, createContext, emptyStore, loadStore, sharedFileName } from '../../src/taskContextModel';

describe('task contexts per git branch and shared in the repository', () => {
  it('reads the branch from .git/HEAD', () => {
    expect(branchOfHead('ref: refs/heads/feature/login\n')).toBe('feature/login');
    expect(branchOfHead('ref: refs/heads/main')).toBe('main');
    expect(branchOfHead('3f2a9c1d0e5b7a8f6c4d2e1b0a9f8e7d6c5b4a3f\n')).toBeUndefined();
  });

  it('a branch gets its own context once, then switching back activates it again; nothing is removed', () => {
    let store = emptyStore();
    const first = createContext(store, 'Task', 'a', 1);
    if (!first.ok) throw new Error(first.message);
    store = first.store;
    const f = contextForBranch(store, 'feature/x', 'b', 2);
    if (!f.ok) throw new Error(f.message);
    expect(f.created).toBe(true);
    expect(activeContext(f.store)).toMatchObject({ id: 'b', name: 'feature/x', branch: 'feature/x' });
    const back = contextForBranch(createContext(f.store, 'Other', 'c', 3).ok ? f.store : f.store, 'feature/x', 'd', 4);
    if (!back.ok) throw new Error(back.message);
    expect(back.created).toBeUndefined();
    expect(back.store.activeId).toBe('b');
    expect(back.store.contexts.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('keeps the branch of a stored context', () => {
    const r = loadStore({ version: 1, activeId: 'b', contexts: [{ id: 'b', name: 'main', createdAt: 1, items: [], branch: 'main' }] });
    expect(r.kind === 'ok' && r.store.contexts[0]?.branch).toBe('main');
  });

  it('reads the git directory of a linked worktree from its .git file', () => {
    expect(gitDirOfFile('gitdir: E:/repo/.git/worktrees/feature\n')).toBe('E:/repo/.git/worktrees/feature');
    expect(gitDirOfFile('gitdir: ../.git/modules/lib')).toBe('../.git/modules/lib');
    expect(gitDirOfFile('ref: refs/heads/main')).toBeUndefined();
  });

  it('names the shared file after the context', () => {
    expect(sharedFileName('Login bug: #123 / API')).toBe('Login-bug-123-API.json');
    expect(sharedFileName('***')).toBe('task.json');
  });
});
