import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  documents: [] as { uri: { scheme: string; fsPath: string }; isDirty: boolean }[],
  errors: [] as string[],
  warnings: [] as string[],
  restore: vi.fn<() => Promise<number | undefined>>(),
}));

vi.mock('vscode', () => ({
  Uri: { parse: (s: string) => ({ scheme: 'file', fsPath: fileURLToPath(s), toString: () => s }) },
  workspace: { get textDocuments() { return io.documents; } },
  window: {
    showInformationMessage: async () => undefined,
    showErrorMessage: async (message: string) => { io.errors.push(message); },
    showWarningMessage: async (message: string) => { io.warnings.push(message); },
  },
}));
vi.mock('../../src/dotnetCli', () => ({ runVisible: () => io.restore(), runCapture: vi.fn() }));

import { NuGetPanel } from '../../src/nugetPanel';
import { SolutionExplorer } from '../../src/solutionExplorer';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-nuget-safety-'));
const props = path.join(directory, 'Directory.Packages.props');
const original = '<Project><ItemGroup><PackageVersion Include="Example" Version="1.0.0" /></ItemGroup></Project>\n';
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

function setup(): { panel: NuGetPanel; explorer: SolutionExplorer } {
  const explorer: SolutionExplorer = Object.assign(Object.create(SolutionExplorer.prototype), {
    reloadAndRefresh: vi.fn(async () => {}),
    structure: () => ({ solutionUri: pathToFileURL(path.join(directory, 'Example.sln')).href }),
  });
  const panel: NuGetPanel = Object.assign(Object.create(NuGetPanel.prototype), {
    explorer,
    scope: () => [{ centralPackageManagement: true, packagesPropsUri: pathToFileURL(props).href,
      projectUri: pathToFileURL(path.join(directory, 'Example.csproj')).href, packages: [{ id: 'Example', central: true }] }],
    set: () => {},
    afterChange: vi.fn(),
  });
  return { panel, explorer };
}

beforeEach(() => {
  fs.writeFileSync(props, original);
  io.documents.length = 0;
  io.errors.length = 0;
  io.warnings.length = 0;
  io.restore.mockReset().mockResolvedValue(0);
});

describe('Central NuGet package updates', () => {
  it('preserves edits made while restore runs and refuses to undo over them', async () => {
    const { panel, explorer } = setup();
    io.restore.mockImplementation(async () => {
      fs.appendFileSync(props, '<!-- concurrent edit -->\n');
      return 0;
    });
    expect(await panel.install('Example', '2.0.0')).toBe(false);
    const after = fs.readFileSync(props, 'utf8');
    expect(after).toContain('Version="2.0.0"');
    expect(after).toContain('concurrent edit');
    expect(await explorer.undo()).toEqual([]);
    expect(fs.readFileSync(props, 'utf8')).toBe(after);
  });

  it.each([1, undefined])('reports an unsuccessful restore (%s), keeps the file edit and allows a checked Undo', async (exitCode) => {
    const { panel, explorer } = setup();
    io.restore.mockResolvedValue(exitCode);
    expect(await panel.install('Example', '2.0.0')).toBe(false);
    expect(io.errors.join(' ')).toMatch(/restore.*(failed|did not finish)/i);
    expect(fs.readFileSync(props, 'utf8')).toContain('Version="2.0.0"');
    expect(await explorer.undo()).toEqual([props]);
    expect(fs.readFileSync(props, 'utf8')).toBe(original);
  });

  it('restores after writing the new version and offers Undo of exactly that edit', async () => {
    const { panel, explorer } = setup();
    io.restore.mockImplementation(async () => {
      expect(fs.readFileSync(props, 'utf8')).toContain('Version="2.0.0"');
      return 0;
    });
    expect(await panel.install('Example', '2.0.0')).toBe(true);
    expect(io.restore).toHaveBeenCalledTimes(1);
    expect(await explorer.undo()).toEqual([props]);
    expect(fs.readFileSync(props, 'utf8')).toBe(original);
  });

  it('refuses an update while the props document has unsaved edits', async () => {
    const { panel } = setup();
    io.documents.push({ uri: { scheme: 'file', fsPath: props }, isDirty: true });
    expect(await panel.install('Example', '2.0.0')).toBe(false);
    expect(io.restore).not.toHaveBeenCalled();
    expect(fs.readFileSync(props, 'utf8')).toBe(original);
    expect(io.warnings.join(' ')).toMatch(/unsaved/i);
  });

  it('refuses a stale before-text instead of overwriting the disk', async () => {
    const { explorer } = setup();
    expect(await explorer.editFiles('update', [{ path: props, text: 'new text' }], 'old text')).toBe(false);
    expect(fs.readFileSync(props, 'utf8')).toBe(original);
  });

  it('refuses Undo while the props document has unsaved edits', async () => {
    const { panel, explorer } = setup();
    expect(await panel.install('Example', '2.0.0')).toBe(true);
    io.documents.push({ uri: { scheme: 'file', fsPath: props }, isDirty: true });
    expect(await explorer.undo()).toEqual([]);
    expect(fs.readFileSync(props, 'utf8')).toContain('Version="2.0.0"');
  });
});
