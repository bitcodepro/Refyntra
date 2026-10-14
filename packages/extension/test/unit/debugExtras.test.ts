import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StepIntoTarget } from '@refyntra/contracts';
import {
  NETCOREDBG_CAPABILITIES,
  NETCOREDBG_CAPABILITY_NAMES,
  classifyStop,
  dotnetDebugFeaturesText,
  exceptionBreakpointsWithTypes,
  isExceptionTypeName,
  isRefyntraExceptionRequest,
  samePath,
  stepIntoItems,
} from '../../src/debugExtrasModel';
import { debugSection } from '../../src/healthPageModel';

const range = { start: { line: 3, character: 4 }, end: { line: 3, character: 20 } };
const target = (over: Partial<StepIntoTarget>): StepIntoTarget => ({ label: 'Calc.Add(int, int)', detail: 'Calc.Add(1, 2)', kind: 'method', callRange: range, breakAt: { uri: 'file:///w/Calc.cs', range }, reason: null, isVirtual: false, ...over });

describe('Smart Step Into items', () => {
  it('lists every call in order; calls without source stay listed with the reason and cannot be chosen', () => {
    const items = stepIntoItems({
      targets: [target({}), target({ label: 'Math.Max(int, int)', breakAt: null, reason: 'metadata' }), target({ label: 'Shape.Name()', isVirtual: true }), target({ label: 'Func<int, int>.Invoke', kind: 'delegate', breakAt: null, reason: 'delegate' })],
      snapshotId: 's',
    });
    expect(items.map((i) => i.label)).toEqual(['$(debug-step-into) Calc.Add(int, int)', '$(circle-slash) Math.Max(int, int)', '$(debug-step-into) Shape.Name()', '$(circle-slash) Func<int, int>.Invoke']);
    expect(items.map((i) => i.enabled)).toEqual([true, false, true, false]);
    expect(items[0].description).toBe('Calc.Add(1, 2)');
    expect(items[0].detail).toBeUndefined();
    expect(items[1].detail).toMatch(/no source in the solution/);
    expect(items[2].detail).toMatch(/an override may run instead/);
    expect(items[3].detail).toMatch(/delegate call/);
  });

  it('classifies where the program stopped: the chosen call, the next statement (not called) or elsewhere', () => {
    const t = { path: 'C:\\w\\Calc.cs', line: 7 };
    const g = { path: 'C:\\w\\Program.cs', line: 12 };
    expect(classifyStop({ path: 'c:/w/Calc.cs', line: 7 }, t, g)).toBe('target');
    expect(classifyStop({ path: 'C:\\w\\Program.cs', line: 12 }, t, g)).toBe('returned');
    expect(classifyStop({ path: 'C:\\w\\Other.cs', line: 7 }, t, g)).toBe('elsewhere');
    expect(classifyStop(undefined, t, g)).toBe('elsewhere');
    expect(classifyStop({ path: 'C:\\w\\Program.cs', line: 12 }, t, undefined)).toBe('elsewhere');
    expect(samePath('/w/A.cs', '/w/a.cs')).toBe(false); // case-sensitive outside Windows drive paths
  });
});

describe('Break on Exception Types', () => {
  it('accepts full type names only', () => {
    expect(isExceptionTypeName('System.InvalidOperationException')).toBe(true);
    expect(isExceptionTypeName('MyApp.Outer+InnerException')).toBe(true);
    expect(isExceptionTypeName('InvalidOperationException')).toBe(false);
    expect(isExceptionTypeName('System.*')).toBe(false);
    expect(isExceptionTypeName('System.Foo, Bar')).toBe(false);
  });

  it("adds netcoredbg's `all` filter with the type names as condition to the ticked filters", () => {
    expect(exceptionBreakpointsWithTypes({ filters: ['user-unhandled'] }, ['System.InvalidOperationException', 'System.ArgumentException', 'bad'])).toEqual({
      filters: ['user-unhandled'],
      filterOptions: [{ filterId: 'all', condition: 'System.InvalidOperationException,System.ArgumentException' }],
    });
    // VS Code sends ticked filters as filterOptions when the adapter supports them.
    expect(exceptionBreakpointsWithTypes({ filters: [], filterOptions: [{ filterId: 'user-unhandled' }] }, ['System.FormatException'])).toEqual({ filters: ['user-unhandled'], filterOptions: [{ filterId: 'all', condition: 'System.FormatException' }] });
    // `all` ticked: every exception breaks anyway; no types: nothing to add.
    expect(exceptionBreakpointsWithTypes({ filters: ['all'] }, ['System.FormatException'])).toBeUndefined();
    expect(exceptionBreakpointsWithTypes({ filters: [] }, [])).toBeUndefined();
    expect(exceptionBreakpointsWithTypes(undefined, ['System.FormatException'])).toEqual({ filters: [], filterOptions: [{ filterId: 'all', condition: 'System.FormatException' }] });
  });

  it("recognises Refyntra's own request (so the tracker does not answer it again)", () => {
    expect(isRefyntraExceptionRequest({ filters: [], filterOptions: [{ filterId: 'all', condition: 'System.X' }] })).toBe(true);
    expect(isRefyntraExceptionRequest({ filters: ['all'] })).toBe(false);
    expect(isRefyntraExceptionRequest({ filterOptions: [{ filterId: 'all' }] })).toBe(false);
  });
});

describe('netcoredbg capabilities', () => {
  it('records what netcoredbg 3.2.0 cannot do itself', () => {
    expect(NETCOREDBG_CAPABILITIES.supportsConditionalBreakpoints).toBe(true);
    for (const k of ['supportsStepInTargetsRequest', 'supportsGotoTargetsRequest', 'supportsLogPoints', 'supportsHitConditionalBreakpoints', 'supportsRestartFrame', 'supportsDataBreakpoints'] as const) expect(NETCOREDBG_CAPABILITIES[k]).toBe(false);
    expect(NETCOREDBG_CAPABILITY_NAMES).toContain('supportsExceptionFilterOptions');
  });

  it('Health names the .NET debugger features and what netcoredbg cannot do', () => {
    expect(dotnetDebugFeaturesText()).toMatch(/Set Next Statement \(Jump to Cursor\)/);
    const s = debugSection({ netcoredbg: { path: '/x/netcoredbg', version: 'netcoredbg 3.2.0-1092' }, debugpy: { path: '/x' } }, true);
    expect(s.meaning).toContain('Smart Step Into');
    expect(s.meaning).toContain('hit counts and logpoints (Refyntra emulates');
    expect(s.meaning).toContain('Edit and Continue');
    expect(debugSection({ netcoredbg: { reason: 'no build' }, debugpy: { path: '/x' } }, true).meaning).not.toContain('Smart Step Into');
  });
});

describe('debugger keybindings and commands', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { keybindings: { command: string; key: string; mac?: string; when: string }[]; commands: { command: string; title: string; enablement?: string }[]; configuration: { properties?: Record<string, unknown> }[] | { properties?: Record<string, unknown> } };
  };
  const keys = pkg.contributes.keybindings;

  it('Smart Step Into: Alt+Shift+F11 (Visual Studio preset), Shift+F7 (ReSharper preset), only while a refyntra-dotnet session is stopped', () => {
    const k = keys.filter((x) => x.command === 'refyntra.smartStepInto');
    expect(k.map((x) => [x.key, /preset == '(\w+)'/.exec(x.when)?.[1]])).toEqual([
      ['alt+shift+f11', 'visualStudio'],
      ['shift+f7', 'resharper'],
    ]);
    expect(k.every((x) => x.when.includes("debugType == 'refyntra-dotnet'") && x.when.includes("debugState == 'stopped'"))).toBe(true);
    expect(pkg.contributes.commands.find((c) => c.command === 'refyntra.smartStepInto')?.title).toBe('Smart Step Into');
  });

  it("Run to Cursor: Ctrl+F10 in the Visual Studio preset runs VS Code's own command in stopped C# editors; no Jump to Cursor binding", () => {
    const k = keys.filter((x) => x.command === 'editor.debug.action.runToCursor');
    expect(k).toHaveLength(1);
    expect(k[0].key).toBe('ctrl+f10');
    expect(k[0].when).toContain("preset == 'visualStudio'");
    expect(k[0].when).toContain('editorLangId == csharp');
    expect(keys.some((x) => x.command === 'editor.debug.action.jumpToCursor')).toBe(false);
  });

  it('no other Refyntra binding uses these keys', () => {
    const mine = new Set(['refyntra.smartStepInto', 'editor.debug.action.runToCursor']);
    expect(keys.filter((x) => !mine.has(x.command) && ['alt+shift+f11', 'shift+f7', 'ctrl+f10'].includes(x.key))).toEqual([]);
  });
});
