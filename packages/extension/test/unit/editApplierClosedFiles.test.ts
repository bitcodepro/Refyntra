import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlannedTextChange } from '@refyntra/contracts';

// Closed targets: capture() reads them one after another (awaits); the final synchronous check must use the text on disk
// at that moment, not a copy read earlier — otherwise a file changed while the others were read gets old positions.

const io = vi.hoisted(() => ({ applied: 0, onRead: undefined as ((fsPath: string) => void) | undefined }));

vi.mock('vscode', () => {
  const uri = (s: string) => ({ scheme: 'file', fsPath: fileURLToPath(s), toString: () => s });
  class WorkspaceEdit {
    readonly edits: unknown[] = [];
    replace(...a: unknown[]) {
      this.edits.push(a);
    }
    insert(...a: unknown[]) {
      this.edits.push(a);
    }
  }
  class Range {
    constructor(...a: number[]) {
      void a;
    }
  }
  class Position {
    constructor(...a: number[]) {
      void a;
    }
  }
  class ThemeIcon {
    constructor(public id: string) {}
  }
  return {
    Uri: { parse: (s: string) => uri(s) },
    WorkspaceEdit,
    Range,
    Position,
    ThemeIcon,
    workspace: {
      textDocuments: [],
      asRelativePath: (u: { fsPath: string }) => path.basename(u.fsPath),
      fs: {
        readFile: async (u: { fsPath: string }) => {
          const bytes = fs.readFileSync(u.fsPath);
          io.onRead?.(u.fsPath);
          return bytes;
        },
      },
      applyEdit: async () => (io.applied++, true),
    },
  };
});

import { VsCodeEditApplier } from '../../src/editApplier';
import { applyTextEditsToText, sha256 } from '../../src/textEdits';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-applier-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A closed file and the plan's change of it: the name Old becomes New on line 0. */
function target(name: string, text: string): { file: string; change: PlannedTextChange } {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  const edits = [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'New' }];
  return { file, change: { kind: 'text', uri: pathToFileURL(file).toString(), expectedHash: sha256(text), resultHash: sha256(applyTextEditsToText(text, edits)), edits } };
}

beforeEach(() => {
  io.applied = 0;
  io.onRead = undefined;
});

describe('EditApplier: closed targets are checked against the disk right before the edit', () => {
  it('the first file changes while the second is read: refused, no edit started', async () => {
    const a = target('A.cs', 'class Old {}\n');
    const b = target('B.cs', 'class Old2 {}\n');
    io.onRead = (p) => {
      // Someone inserts a line at the top of A.cs while B.cs is being read: the planned positions are old for A.
      if (p === b.file) fs.writeFileSync(a.file, '// header\nclass Old {}\n');
    };
    const applier = new VsCodeEditApplier();
    const captured = await applier.capture([a.change, b.change]);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const commit = captured.commit();
    expect(commit.started).toBe(false);
    expect(!commit.started && commit.reason).toMatch(/A\.cs changed/);
    expect(io.applied).toBe(0);
  });

  it('a file changed between capture and commit is refused too', async () => {
    const a = target('C.cs', 'class Old {}\n');
    const applier = new VsCodeEditApplier();
    const captured = await applier.capture([a.change]);
    if (!captured.ok) throw new Error(captured.reason);
    fs.writeFileSync(a.file, 'class Old {} // edited\n');
    const commit = captured.commit();
    expect(commit.started).toBe(false);
    expect(io.applied).toBe(0);
  });

  it('a file that already differs when it is read is refused at capture', async () => {
    const a = target('D.cs', 'class Old {}\n');
    fs.writeFileSync(a.file, 'class Other {}\n');
    const captured = await new VsCodeEditApplier().capture([a.change]);
    expect(captured.ok).toBe(false);
    expect(!captured.ok && captured.reason).toMatch(/D\.cs changed/);
  });

  it('unchanged closed files: the edit starts', async () => {
    const a = target('E.cs', 'class Old {}\n');
    const b = target('F.cs', 'class Old2 {}\n');
    const captured = await new VsCodeEditApplier().capture([a.change, b.change]);
    if (!captured.ok) throw new Error(captured.reason);
    expect(captured.commit().started).toBe(true);
    expect(io.applied).toBe(1);
  });
});
