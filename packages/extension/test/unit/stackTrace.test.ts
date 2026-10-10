import { describe, expect, it } from 'vitest';
import { decodeDotnetName, dotnetParameterTypes, parseStackTrace, cleanScriptPath, type StackFrame } from '../../src/stackTraceParse';
import { basenameOf, caseRuleFor, lineMayHaveMoved, matchFramePath, normalizeFramePath } from '../../src/stackTracePaths';
import { frameAccessibleLabel, frameDescription } from '../../src/stackTracePresentation';

const frames = (text: string): StackFrame[] => parseStackTrace(text).groups.flatMap((g) => g.frames);

describe('.NET (CoreCLR) traces', () => {
  const trace = [
    'Unhandled exception. System.InvalidOperationException: Order 42 was not found',
    '   at Sample.Orders.OrderService.Load(Int32 id, String region) in C:\\build\\src\\Sample.Orders\\OrderService.cs:line 42',
    '   at Sample.Orders.OrderService.<LoadAllAsync>d__5.MoveNext() in C:\\build\\src\\Sample.Orders\\OrderService.cs:line 57',
    '--- End of stack trace from previous location ---',
    '   at System.Runtime.ExceptionServices.ExceptionDispatchInfo.Throw()',
    '   at Sample.Orders.OrderService.<>c__DisplayClass6_0.<Filter>b__0(Order o) in /home/dev/src/Sample.Orders/OrderService.cs:line 70',
    '   at Sample.Orders.OrderService.<Run>g__Validate|7_0(Int32 x) in /home/dev/src/Sample.Orders/OrderService.cs:line 81',
    '   at Sample.Orders.Repository`1.Get[TKey](TKey key, Boolean strict)',
    '   at Sample.Orders.OrderService..ctor(IRepository repo)',
    '   at Sample.Orders.Program.<Main>$(String[] args)',
  ].join('\n');

  it('reads the exception type and message', () => {
    const p = parseStackTrace(trace);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]).toMatchObject({ exceptionType: 'System.InvalidOperationException', message: 'Order 42 was not found', language: 'dotnet', depth: 0 });
  });

  it('reads type, method, parameters, file and line', () => {
    const f = frames(trace)[0]!;
    expect(f).toMatchObject({ typeName: 'Sample.Orders.OrderService', methodName: 'Load', parameterTypes: ['Int32', 'String'], file: 'C:\\build\\src\\Sample.Orders\\OrderService.cs', line: 42, external: false });
  });

  it('decodes async state machines, lambdas and local functions to the user method', () => {
    const [, asyncF, , lambda, local] = frames(trace);
    expect(asyncF).toMatchObject({ typeName: 'Sample.Orders.OrderService', methodName: 'LoadAllAsync', compilerKind: 'async', line: 57 });
    expect(asyncF!.parameterTypes).toBeUndefined();
    expect(lambda).toMatchObject({ typeName: 'Sample.Orders.OrderService', methodName: 'Filter', compilerKind: 'lambda', file: '/home/dev/src/Sample.Orders/OrderService.cs', line: 70 });
    expect(local).toMatchObject({ methodName: 'Run', localFunctionName: 'Validate', compilerKind: 'localFunction' });
  });

  it('marks the frame after an await boundary and System frames as external', () => {
    const fs = frames(trace);
    expect(fs[2]).toMatchObject({ typeName: 'System.Runtime.ExceptionServices.ExceptionDispatchInfo', external: true, afterAsyncBoundary: true });
    expect(fs[3]!.afterAsyncBoundary).toBeUndefined();
  });

  it('generic arity, constructors and frames without file information', () => {
    const fs = frames(trace);
    expect(fs[5]).toMatchObject({ typeName: 'Sample.Orders.Repository`1', methodName: 'Get', methodArity: 1, parameterTypes: ['TKey', 'Boolean'], external: false });
    expect(fs[5]!.file).toBeUndefined();
    expect(fs[6]).toMatchObject({ typeName: 'Sample.Orders.OrderService', methodName: '.ctor', parameterTypes: ['IRepository'] });
    expect(fs[7]).toMatchObject({ typeName: 'Sample.Orders.Program', methodName: '<Main>$' });
  });

  it('inner exceptions ("--->") become nested groups; frames after "End of inner exception" go back to the outer one', () => {
    const p = parseStackTrace(
      [
        'System.ApplicationException: Import failed ---> System.FormatException: Bad number',
        '   at Sample.Import.Parser.ParseLine(String line) in C:\\src\\Parser.cs:line 10',
        '   --- End of inner exception stack trace ---',
        '   at Sample.Import.Importer.Run() in C:\\src\\Importer.cs:line 20',
      ].join('\r\n'),
    );
    expect(p.groups.map((g) => [g.exceptionType, g.message, g.depth, g.frames.map((f) => f.methodName)])).toEqual([
      ['System.ApplicationException', 'Import failed', 0, ['Run']],
      ['System.FormatException', 'Bad number', 1, ['ParseLine']],
    ]);
  });

  it('.NET Framework style inner exception on its own line', () => {
    const p = parseStackTrace(['System.Exception: Outer', ' ---> System.IO.IOException: Disk full', '   at Sample.Io.Writer.Flush()', '   --- End of inner exception stack trace ---', '   at Sample.Io.Job.Run()'].join('\n'));
    expect(p.groups.map((g) => [g.exceptionType, g.depth, g.frames.length])).toEqual([
      ['System.Exception', 0, 1],
      ['System.IO.IOException', 1, 1],
    ]);
  });

  it('messy copy/paste: timestamps, log levels, ANSI colours, CRLF', () => {
    const fs = frames(
      [
        '2024-05-01 10:00:00.123 +02:00 [ERR] \u001b[31mSystem.NullReferenceException: Object reference not set\u001b[0m',
        '2024-05-01 10:00:00.124 +02:00 [ERR]    at Sample.Web.Controllers.OrdersController.Get(Int32 id) in D:\\a\\1\\s\\Sample.Web\\Controllers\\OrdersController.cs:line 33\r',
        'info: Microsoft.Hosting.Lifetime[0]   at Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.Execute(ActionContext context)',
      ].join('\n'),
    );
    expect(fs).toHaveLength(2);
    expect(fs[0]).toMatchObject({ methodName: 'Get', line: 33, file: 'D:\\a\\1\\s\\Sample.Web\\Controllers\\OrdersController.cs' });
    expect(fs[1]!.external).toBe(true);
  });

  it('Mono: [0x...] offsets, ":N" lines, "<filename unknown>" and IL nested types', () => {
    const fs = frames(
      [
        '  at Sample.Game.Player.Move (System.Single dx) [0x0001c] in /Users/dev/Game/Assets/Player.cs:42 ',
        '  at Sample.Game.Player/<Spawn>d__3.MoveNext () [0x00000] in <filename unknown>:0 ',
        '  at Sample.Game.Board.Reset () [0x00000] in <8f1a2b3c4d5e6f708192a3b4c5d6e7f8>:0',
      ].join('\n'),
    );
    expect(fs[0]).toMatchObject({ typeName: 'Sample.Game.Player', methodName: 'Move', parameterTypes: ['System.Single'], file: '/Users/dev/Game/Assets/Player.cs', line: 42 });
    expect(fs[1]).toMatchObject({ typeName: 'Sample.Game.Player', methodName: 'Spawn', compilerKind: 'async' });
    expect(fs[1]!.file).toBeUndefined();
    expect(fs[2]!.file).toBeUndefined();
  });

  it('Unity console format', () => {
    const fs = frames(['NullReferenceException: Object reference not set to an instance of an object', 'Sample.Game.Player.Update () (at Assets/Scripts/Player.cs:27)', 'UnityEngine.Debug:Log (object)'].join('\n'));
    expect(fs[0]).toMatchObject({ typeName: 'Sample.Game.Player', methodName: 'Update', file: 'Assets/Scripts/Player.cs', line: 27, external: false });
    expect(fs[1]).toMatchObject({ typeName: 'UnityEngine.Debug', methodName: 'Log', parameterTypes: ['object'], external: true });
  });

  it('localised runtimes (German, French) with a file part', () => {
    const fs = frames(['   bei Sample.App.Worker.Run(Int32 n) in C:\\src\\Worker.cs:Zeile 12', '   à Sample.App.Worker.Stop() dans C:\\src\\Worker.cs:ligne 30'].join('\n'));
    expect(fs.map((f) => [f.methodName, f.line])).toEqual([
      ['Run', 12],
      ['Stop', 30],
    ]);
  });
});

describe('decodeDotnetName', () => {
  it.each([
    ['Ns.Type.<DoAsync>d__12.MoveNext', 'Ns.Type', 'DoAsync', 'async'],
    ['Ns.Type+<DoAsync>d__12.MoveNext', 'Ns.Type', 'DoAsync', 'async'],
    ['Ns.Type.<>c.<Main>b__0_0', 'Ns.Type', 'Main', 'lambda'],
    ['Ns.Type.<>c.<<Main>b__0_0>d.MoveNext', 'Ns.Type', 'Main', 'lambda'],
    ['Ns.Type.<<Run>g__Inner|1_0>d.MoveNext', 'Ns.Type', 'Run', 'localFunction'],
    ['Ns.Outer+Inner.Method', 'Ns.Outer.Inner', 'Method', undefined],
    ['Ns.Type..cctor', 'Ns.Type', '.cctor', undefined],
    ['Ns.Type`2.<Iterate>d__4`1.MoveNext', 'Ns.Type`2', 'Iterate', 'async'],
  ])('%s', (input, type, method, kind) => {
    const d = decodeDotnetName(input)!;
    expect([d.typeName, d.methodName, d.compilerKind]).toEqual([type, method, kind]);
  });
  it('parameter types keep generic, array and by-ref markers', () => {
    expect(dotnetParameterTypes('Dictionary`2 map, String[] args, Int32& count, ref Int32 x')).toEqual(['Dictionary`2', 'String[]', 'Int32&', 'ref Int32']);
    expect(dotnetParameterTypes('')).toEqual([]);
  });
});

describe('JavaScript / TypeScript', () => {
  it('V8 (Node, Chrome)', () => {
    const p = parseStackTrace(
      [
        "TypeError: Cannot read properties of undefined (reading 'id')",
        '    at OrderService.load (/home/dev/app/src/orders.ts:12:15)',
        '    at async Promise.all (index 0)',
        '    at async handler (file:///C:/dev/app/dist/server.js:40:3)',
        '    at new Cart (webpack:///./src/cart.ts?abcd:7:9)',
        '    at /home/dev/app/src/index.ts:3:1',
        '    at Module._compile (node:internal/modules/cjs/loader:1105:14)',
        '    at Object.<anonymous> (/home/dev/app/node_modules/lib/index.js:1:2)',
      ].join('\n'),
    );
    expect(p.groups[0]).toMatchObject({ exceptionType: 'TypeError', language: 'javascript' });
    expect(p.groups[0]!.frames.map((f) => [f.function, f.file, f.line, f.column, f.external])).toEqual([
      ['OrderService.load', '/home/dev/app/src/orders.ts', 12, 15, false],
      ['handler', 'C:/dev/app/dist/server.js', 40, 3, false],
      ['Cart', 'src/cart.ts', 7, 9, false],
      ['(anonymous)', '/home/dev/app/src/index.ts', 3, 1, false],
      ['Module._compile', 'node:internal/modules/cjs/loader', 1105, 14, true],
      ['Object.<anonymous>', '/home/dev/app/node_modules/lib/index.js', 1, 2, true],
    ]);
  });
  it('Firefox / Safari', () => {
    expect(frames('load@http://localhost:3000/src/orders.ts:12:15\n@/home/dev/app/src/main.js:3:1').map((f) => [f.function, f.file, f.line])).toEqual([
      ['load', 'http://localhost:3000/src/orders.ts', 12],
      ['(anonymous)', '/home/dev/app/src/main.js', 3],
    ]);
  });
  it('script paths', () => {
    expect(cleanScriptPath('file:///C:/a%20b/x.js')).toBe('C:/a b/x.js');
    expect(cleanScriptPath('webpack://my-app/./src/x.ts')).toBe('src/x.ts');
  });
});

describe('Python', () => {
  it('traceback with the exception line after the frames; chained exceptions', () => {
    const p = parseStackTrace(
      [
        'Traceback (most recent call last):',
        '  File "/home/dev/app/orders.py", line 10, in load',
        '    return int(raw)',
        'ValueError: invalid literal for int()',
        '',
        'During handling of the above exception, another exception occurred:',
        '',
        'Traceback (most recent call last):',
        '  File "C:\\dev\\app\\main.py", line 3, in <module>',
        '    raise RuntimeError',
        '  File "/usr/lib/python3.12/json/__init__.py", line 346, in loads',
        '  File "/home/dev/.venv/lib/python3.12/site-packages/lib/x.py", line 5, in f',
        'RuntimeError: wrapped',
      ].join('\n'),
    );
    expect(p.groups.map((g) => [g.exceptionType, g.message, g.frames.map((f) => [f.function, f.line, f.external])])).toEqual([
      ['ValueError', 'invalid literal for int()', [['load', 10, false]]],
      [
        'RuntimeError',
        'wrapped',
        [
          ['<module>', 3, false],
          ['loads', 346, true],
          ['f', 5, true],
        ],
      ],
    ]);
  });
});

describe('Rust', () => {
  it('panic (new and old message format) and backtrace', () => {
    const p = parseStackTrace(
      [
        "thread 'main' panicked at src/main.rs:10:5:",
        'called `Option::unwrap()` on a `None` value',
        'stack backtrace:',
        '   0: rust_begin_unwind',
        '             at /rustc/0123456789abcdef0123456789abcdef01234567/library/std/src/panicking.rs:645:5',
        '   1: app::orders::load::h0123456789abcdef',
        '             at ./src/orders.rs:22:9',
        '   2: app::main',
        '             at src/main.rs:10:5',
        'note: Some details are omitted, run with `RUST_BACKTRACE=full` for a verbose backtrace.',
      ].join('\n'),
    );
    expect(p.groups[0]).toMatchObject({ exceptionType: 'panic', message: 'called `Option::unwrap()` on a `None` value', language: 'rust' });
    expect(p.groups[0]!.frames.map((f) => [f.function, f.file, f.line, f.external])).toEqual([
      ['(panic location)', 'src/main.rs', 10, false],
      ['rust_begin_unwind', '/rustc/0123456789abcdef0123456789abcdef01234567/library/std/src/panicking.rs', 645, true],
      ['app::orders::load', './src/orders.rs', 22, false],
      ['app::main', 'src/main.rs', 10, false],
    ]);
    const old = parseStackTrace("thread 'worker' panicked at 'index out of bounds', src/lib.rs:4:9");
    expect(old.groups[0]).toMatchObject({ message: 'index out of bounds' });
    expect(old.groups[0]!.frames[0]).toMatchObject({ file: 'src/lib.rs', line: 4, column: 9 });
  });
});

describe('robustness', () => {
  it('text without frames yields no groups; plain prose is not a frame', () => {
    expect(parseStackTrace('').groups).toEqual([]);
    expect(parseStackTrace('The build failed at startup (see log).\nNothing else here').frameCount).toBe(0);
  });
  it('a header line alone is kept so the user sees what was recognised', () => {
    expect(parseStackTrace('System.Exception: boom').groups).toHaveLength(1);
  });
  it('mixed languages in one paste keep their own groups', () => {
    const p = parseStackTrace(['Error: js failed', '    at f (/a/b.js:1:2)', 'System.Exception: net failed', '   at Ns.T.M() in C:\\x\\T.cs:line 3'].join('\n'));
    expect(p.groups.map((g) => g.language)).toEqual(['javascript', 'dotnet']);
  });
});

describe('workspace path matching', () => {
  const ws = ['C:/repo/src/Sample.Orders/OrderService.cs', 'C:/repo/src/Sample.Web/OrderService.cs', 'C:/repo/tests/Helpers.cs', 'C:/repo/src/Lib/Helpers.cs'];
  it('exact path first', () => {
    expect(matchFramePath('C:\\repo\\src\\Sample.Web\\OrderService.cs', ws, 'insensitive')).toMatchObject({ kind: 'exact', matches: [{ path: ws[1] }] });
  });
  it('longest suffix wins (build-server paths)', () => {
    expect(matchFramePath('D:\\a\\1\\s\\src\\Sample.Orders\\OrderService.cs', ws, 'insensitive')).toMatchObject({ kind: 'unique', matches: [{ path: ws[0], score: 3 }] });
    expect(matchFramePath('/home/ci/build/Sample.Web/OrderService.cs', ws, 'sensitive')).toMatchObject({ kind: 'unique', matches: [{ path: ws[1] }] });
  });
  it('ties are ambiguous and listed', () => {
    const r = matchFramePath('/build/Helpers.cs', ws, 'sensitive');
    expect(r.kind).toBe('ambiguous');
    expect(r.matches.map((m) => m.path)).toEqual(['C:/repo/src/Lib/Helpers.cs', 'C:/repo/tests/Helpers.cs']);
  });
  it('case rules per OS', () => {
    expect(caseRuleFor('win32')).toBe('insensitive');
    expect(caseRuleFor('darwin')).toBe('insensitive');
    expect(caseRuleFor('linux')).toBe('sensitive');
    expect(matchFramePath('/x/orderservice.cs', ws, 'sensitive').kind).toBe('none');
    expect(matchFramePath('/x/SAMPLE.ORDERS/orderservice.cs', ws, 'insensitive')).toMatchObject({ kind: 'unique', matches: [{ path: ws[0] }] });
  });
  it('relative and dotted paths', () => {
    expect(normalizeFramePath('.\\src\\.\\main.rs')).toBe('src/main.rs');
    expect(basenameOf('../src/main.rs')).toBe('main.rs');
    expect(matchFramePath('./src/Lib/Helpers.cs', ws, 'sensitive')).toMatchObject({ kind: 'unique', matches: [{ path: ws[3] }] });
    expect(matchFramePath('', ws, 'sensitive').kind).toBe('none');
  });
  it('line may have moved only when the line is past the end', () => {
    expect(lineMayHaveMoved(120, 80)).toBe(true);
    expect(lineMayHaveMoved(80, 80)).toBe(false);
    expect(lineMayHaveMoved(undefined, 1)).toBe(false);
  });
});

describe('frame presentation (words, not colour)', () => {
  const f = frames('   at Sample.Orders.OrderService.<LoadAllAsync>d__5.MoveNext() in C:\\src\\OrderService.cs:line 57\n   at System.Threading.Tasks.Task.Run()');
  it('labels say user code / external and the kind of compiler-generated frame', () => {
    expect(frameAccessibleLabel(f[0]!, { index: 0, count: 2, status: 'user' })).toBe('Frame 1 of 2: Sample.Orders.OrderService.LoadAllAsync (async), OrderService.cs line 57, your code');
    expect(frameAccessibleLabel(f[1]!, { index: 1, count: 2, status: 'external' })).toBe('Frame 2 of 2: System.Threading.Tasks.Task.Run, no file, external');
    expect(frameDescription(f[0]!, 'ambiguous')).toBe('OrderService.cs:57 · several files match');
    expect(frameDescription(f[1]!, 'external')).toBe('external');
  });
});
