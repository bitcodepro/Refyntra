import { describe, expect, it } from 'vitest';
import type { TestMethodInfo, TestProjectInfo } from '@refyntra/contracts';
import {
  aggregateOutcome,
  buildCargoTree,
  buildDotnetTree,
  buildPytestTree,
  cargoTestArgs,
  displayArguments,
  dotnetFilter,
  dotnetMethodId,
  dotnetTestArgs,
  failureLocation,
  matchDotnetResults,
  mergeTests,
  normalizeArgument,
  parseCobertura,
  referencesCoverlet,
  parseCargoList,
  parseCargoTestOutput,
  parseDuration,
  parseJunitXml,
  parsePytestCollect,
  parseTrx,
  pytestArgs,
  pytestNodeId,
  splitTopLevel,
  stackLocations,
  testhostProcessId,
  type TestNode,
} from '../../src/testingModel';

const r = (l: number, c = 0) => ({ start: { line: l, character: c }, end: { line: l, character: c + 5 } });
const P = 'file:///w/XUnitTests/XUnitTests.csproj';
const N = 'file:///w/NUnitTests/NUnitTests.csproj';
const F = 'file:///w/XUnitTests/CalculatorTests.cs';

function method(fqn: string, extra: Partial<TestMethodInfo> = {}): TestMethodInfo {
  const parts = fqn.split('.');
  const name = parts.pop()!;
  const classes = parts.pop()!.split('+');
  return {
    projectUri: P,
    uri: F,
    framework: 'xUnit',
    namespace: parts.join('.'),
    classes: classes.map((c, i) => ({ name: c, range: { start: { line: i, character: 0 }, end: { line: 60, character: 1 } }, nameRange: r(i + 5) })),
    method: name,
    fullyQualifiedName: fqn,
    range: { start: { line: 10, character: 4 }, end: { line: 14, character: 5 } },
    nameRange: r(10, 16),
    cases: [],
    dynamicCases: false,
    ...extra,
  };
}

const projects: TestProjectInfo[] = [
  { name: 'XUnitTests', projectUri: P, frameworks: ['xUnit'] },
  { name: 'NUnitTests', projectUri: N, frameworks: ['NUnit'] },
];
const tests: TestMethodInfo[] = [
  method('XUnitTests.CalculatorTests.AddsTwoNumbers'),
  method('XUnitTests.CalculatorTests.AddTheory', {
    cases: [
      { label: '(1, 2, 3)', arguments: ['1', '2', '3'], range: r(27) },
      { label: '(5, 5, 11)', arguments: ['5', '5', '11'], range: r(29) },
    ],
  }),
  method('XUnitTests.CalculatorTests.DividesByThree', { dynamicCases: true }),
  method('XUnitTests.CalculatorTests+Nested.NestedPasses'),
  method('NUnitTests.Arithmetic.DivideTests.DivideCases', { projectUri: N, framework: 'NUnit', uri: 'file:///w/NUnitTests/DivideTests.cs' }),
  method('NUnitTests.Arithmetic.DivideTests.DivideCasesTwice', { projectUri: N, framework: 'NUnit', uri: 'file:///w/NUnitTests/DivideTests.cs' }),
];

function outline(nodes: readonly TestNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.kind}:${n.label}`, ...outline(n.children, depth + 1)]);
}

function methodsOf(nodes: readonly TestNode[]): Map<string, TestNode> {
  const m = new Map<string, TestNode>();
  const walk = (n: TestNode) => {
    if (n.kind === 'method') m.set(n.key, n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return m;
}

describe('C# test tree', () => {
  it('nests project → namespace → class → nested class → method → data cases', () => {
    const tree = buildDotnetTree(projects, tests, (u) => u.replace('file://', ''));
    expect(outline(tree)).toEqual([
      'project:NUnitTests',
      '  namespace:NUnitTests.Arithmetic',
      '    class:DivideTests',
      '      method:DivideCases',
      '      method:DivideCasesTwice',
      'project:XUnitTests',
      '  namespace:XUnitTests',
      '    class:CalculatorTests',
      '      method:AddsTwoNumbers',
      '      method:AddTheory',
      '        case:(1, 2, 3)',
      '        case:(5, 5, 11)',
      '      method:DividesByThree',
      '      class:Nested',
      '        method:NestedPasses',
    ]);
    const x = tree[1]!;
    expect(x.project).toBe('/w/XUnitTests/XUnitTests.csproj');
    expect(x.description).toBe('xUnit');
    const nested = x.children[0]!.children[0]!.children.find((c) => c.label === 'Nested')!;
    expect(nested.key).toBe('XUnitTests.CalculatorTests+Nested');
    expect(methodsOf(tree).get('XUnitTests.CalculatorTests.AddTheory')!.id).toBe(dotnetMethodId(P, 'XUnitTests.CalculatorTests.AddTheory'));
  });

  it('replaces only the tests of re-discovered documents', () => {
    const merged = mergeTests(tests, [F], [method('XUnitTests.CalculatorTests.Fresh')]);
    expect(merged.map((t) => t.method)).toEqual(['DivideCases', 'DivideCasesTwice', 'Fresh']);
    // The editor and the host may spell a URI differently (drive letters on Windows): compared through a key.
    const keyed = mergeTests(tests, [F.toUpperCase()], [], (u) => u.toLowerCase());
    expect(keyed.map((t) => t.method)).toEqual(['DivideCases', 'DivideCasesTwice']);
  });
});

describe('dotnet test filters', () => {
  const tree = buildDotnetTree(projects, tests, (u) => u);
  const m = methodsOf(tree);
  it('uses exact names for xUnit / MSTest methods and their data cases', () => {
    expect(dotnetFilter([m.get('XUnitTests.CalculatorTests.AddTheory')!])).toBe('FullyQualifiedName=XUnitTests.CalculatorTests.AddTheory');
    expect(dotnetFilter([m.get('XUnitTests.CalculatorTests.AddTheory')!.children[1]!])).toBe('FullyQualifiedName=XUnitTests.CalculatorTests.AddTheory');
  });
  it('NUnit methods: contains, minus siblings that start with the same name (no parentheses)', () => {
    expect(dotnetFilter([m.get('NUnitTests.Arithmetic.DivideTests.DivideCases')!])).toBe(
      'FullyQualifiedName~NUnitTests.Arithmetic.DivideTests.DivideCases&FullyQualifiedName!~NUnitTests.Arithmetic.DivideTests.DivideCasesTwice',
    );
    expect(dotnetFilter([m.get('NUnitTests.Arithmetic.DivideTests.DivideCasesTwice')!])).toBe('FullyQualifiedName~NUnitTests.Arithmetic.DivideTests.DivideCasesTwice');
  });
  it('classes include their nested classes; namespaces; several selections; a project runs everything', () => {
    expect(dotnetFilter([{ kind: 'class', key: 'XUnitTests.CalculatorTests' }])).toBe('FullyQualifiedName~XUnitTests.CalculatorTests.|FullyQualifiedName~XUnitTests.CalculatorTests+');
    expect(dotnetFilter([{ kind: 'namespace', key: 'A.B' }, { kind: 'method', key: 'A.C.M', framework: 'MSTest' }])).toBe('FullyQualifiedName~A.B.|FullyQualifiedName=A.C.M');
    expect(dotnetFilter([{ kind: 'project', key: '' }, { kind: 'method', key: 'A.C.M' }])).toBeUndefined();
    expect(dotnetFilter([])).toBeUndefined();
  });
  it('builds dotnet test arguments with a TRX logger into the results directory', () => {
    expect(dotnetTestArgs('/w/T.csproj', { filter: 'FullyQualifiedName=A.B.C', resultsDirectory: '/tmp/r', noBuild: true })).toEqual([
      'test', '/w/T.csproj', '--nologo', '-c', 'Debug', '--logger', 'trx', '--results-directory', '/tmp/r', '--filter', 'FullyQualifiedName=A.B.C', '--no-build',
    ]);
    expect(dotnetTestArgs('/w/T.csproj', { resultsDirectory: '/r' })).not.toContain('--filter');
  });
  it('reads the test host process id that VSTEST_HOST_DEBUG prints', () => {
    expect(testhostProcessId('Host debugging is enabled. Please attach debugger to testhost process to continue.\r\nProcess Id: 4084, Name: testhost\r\n')).toBe(4084);
    // On Linux the test host runs as "dotnet exec testhost.dll".
    expect(testhostProcessId('Process Id: 123, Name: dotnet\n')).toBe(123);
    expect(testhostProcessId('Test run for X.dll')).toBeUndefined();
  });
});

// Shapes of real TRX files (VSTest TRX logger) of xUnit, NUnit and MSTest, trimmed.
const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="e1" testId="t1" testName="XUnitTests.CalculatorTests.AddTheory(a: 5, b: 5, expected: 11)" duration="00:00:00.0029404" outcome="Failed">
      <Output>
        <ErrorInfo>
          <Message>Assert.Equal() Failure: Values differ&#xD;
Expected: 11&#xD;
Actual:   10</Message>
          <StackTrace>   at XUnitTests.CalculatorTests.AddTheory(Int32 a, Int32 b, Int32 expected) in /w/XUnitTests/CalculatorTests.cs:line 33&#xD;
   at InvokeStub_CalculatorTests.AddTheory(Object, Span\`1)</StackTrace>
        </ErrorInfo>
      </Output>
    </UnitTestResult>
    <UnitTestResult executionId="e2" testId="t2" testName="XUnitTests.CalculatorTests.AddTheory(a: 1, b: 2, expected: 3)" duration="00:00:00.0002140" outcome="Passed" />
    <UnitTestResult executionId="e3" testId="t3" testName="XUnitTests.CalculatorTests.SkippedOnPurpose" duration="00:00:00.0010000" outcome="NotExecuted">
      <Output><ErrorInfo><Message>skipped on purpose</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult executionId="e4" testId="t4" testName="XUnitTests.CalculatorTests+Nested.NestedPasses" duration="00:00:01.5" outcome="Passed" />
    <UnitTestResult executionId="e5" testId="t5" testName="XUnitTests.CalculatorTests.DividesByThree(a: 6, b: 3)" duration="00:00:00.0002833" outcome="Passed" />
    <UnitTestResult executionId="e6" testId="t6" testName="DivideCases(9,3,3)" duration="00:00:00.0004960" outcome="Passed">
      <Output><StdOut>hello &amp; bye</StdOut></Output>
    </UnitTestResult>
    <UnitTestResult executionId="e7" testId="t7" testName="AddRows (3,4,7)" duration="00:00:00.0004049" outcome="Passed" />
  </Results>
  <TestDefinitions>
    <UnitTest name="XUnitTests.CalculatorTests.AddTheory(a: 5, b: 5, expected: 11)" storage="x" id="t1"><Execution id="e1" /><TestMethod codeBase="x" adapterTypeName="x" className="XUnitTests.CalculatorTests" name="AddTheory" /></UnitTest>
    <UnitTest name="XUnitTests.CalculatorTests.AddTheory(a: 1, b: 2, expected: 3)" storage="x" id="t2"><Execution id="e2" /><TestMethod codeBase="x" adapterTypeName="x" className="XUnitTests.CalculatorTests" name="AddTheory" /></UnitTest>
    <UnitTest name="XUnitTests.CalculatorTests.SkippedOnPurpose" storage="x" id="t3"><Execution id="e3" /><TestMethod codeBase="x" adapterTypeName="x" className="XUnitTests.CalculatorTests" name="SkippedOnPurpose" /></UnitTest>
    <UnitTest name="XUnitTests.CalculatorTests+Nested.NestedPasses" storage="x" id="t4"><Execution id="e4" /><TestMethod codeBase="x" adapterTypeName="x" className="XUnitTests.CalculatorTests+Nested" name="NestedPasses" /></UnitTest>
    <UnitTest name="XUnitTests.CalculatorTests.DividesByThree(a: 6, b: 3)" storage="x" id="t5"><Execution id="e5" /><TestMethod codeBase="x" adapterTypeName="x" className="XUnitTests.CalculatorTests" name="DividesByThree" /></UnitTest>
    <UnitTest name="DivideCases(9,3,3)" storage="x" id="t6"><Execution id="e6" /><TestMethod codeBase="x" adapterTypeName="x" className="NUnitTests.Arithmetic.DivideTests" name="DivideCases(9,3,3)" /></UnitTest>
    <UnitTest name="AddRows (3,4,7)" storage="x" id="t7"><Execution id="e7" /><TestMethod codeBase="x" adapterTypeName="x" className="MSTestTests.AddTests" name="AddRows" /></UnitTest>
  </TestDefinitions>
</TestRun>`;

describe('TRX', () => {
  const results = parseTrx(TRX);
  it('reads outcome, duration, message, stack trace and output per result', () => {
    expect(results).toHaveLength(7);
    const failed = results[0]!;
    expect(failed).toMatchObject({ className: 'XUnitTests.CalculatorTests', methodName: 'AddTheory', outcome: 'failed', durationMs: 3 });
    expect(failed.message).toBe('Assert.Equal() Failure: Values differ\nExpected: 11\nActual:   10');
    expect(failed.stackTrace).toContain('CalculatorTests.cs:line 33');
    expect(results[2]).toMatchObject({ outcome: 'skipped', message: 'skipped on purpose' });
    expect(results[3]).toMatchObject({ className: 'XUnitTests.CalculatorTests+Nested', durationMs: 1500 });
    expect(results[5]).toMatchObject({ className: 'NUnitTests.Arithmetic.DivideTests', methodName: 'DivideCases', stdout: 'hello & bye' });
    expect(results[6]).toMatchObject({ className: 'MSTestTests.AddTests', methodName: 'AddRows' });
  });

  it('matches results to methods, source data cases and run-time cases', () => {
    const tree = buildDotnetTree(projects, tests, (u) => u);
    const m = methodsOf(tree);
    const matched = matchDotnetResults(results, m);
    const theory = m.get('XUnitTests.CalculatorTests.AddTheory')!;
    expect(matched.find((x) => x.result === results[0])!.id).toBe(theory.children[1]!.id); // (5, 5, 11)
    expect(matched.find((x) => x.result === results[1])!.id).toBe(theory.children[0]!.id); // (1, 2, 3)
    expect(matched.find((x) => x.result === results[3])!.id).toBe(m.get('XUnitTests.CalculatorTests+Nested.NestedPasses')!.id);
    const dynamic = matched.find((x) => x.result === results[4])!;
    expect(dynamic.parentId).toBe(m.get('XUnitTests.CalculatorTests.DividesByThree')!.id);
    expect(dynamic.label).toBe('(a: 6, b: 3)');
    // NUnit DivideCases has no source cases in this tree: a run-time case under the method.
    expect(matched.find((x) => x.result === results[5])!.parentId).toBe(m.get('NUnitTests.Arithmetic.DivideTests.DivideCases')!.id);
    // Unknown methods (SkippedOnPurpose is not in this tree, MSTest project not loaded) are not reported.
    expect(matched).toHaveLength(5);
  });

  it('parses durations and display arguments the way the host normalises source arguments', () => {
    expect(parseDuration('00:01:02.5')).toBe(62500);
    expect(parseDuration('bad')).toBeUndefined();
    expect(displayArguments('Ns.C.M(a: 1, b: "x, y", c: Red)')).toEqual(['1', 'x,y', 'red']);
    expect(displayArguments('M (1,2)')).toEqual(['1', '2']);
    expect(displayArguments('M')).toEqual([]);
    expect(splitTopLevel('[1, 2], "a,b", f(3, 4)')).toEqual(['[1, 2]', '"a,b"', 'f(3, 4)']);
    for (const [a, b] of [['"abc"', 'abc'], ['1.5d', '1.5'], ['10L', '10'], ['Color.Red', 'red'], ["'x'", 'x'], ['true', 'true'], ['null', 'null'], ['-3', '-3']]) expect(normalizeArgument(a!)).toBe(b);
  });

  it('aggregates outcomes', () => {
    expect(aggregateOutcome(['passed', 'failed', 'skipped'])).toBe('failed');
    expect(aggregateOutcome(['skipped', 'passed'])).toBe('passed');
    expect(aggregateOutcome(['skipped'])).toBe('skipped');
    expect(aggregateOutcome([])).toBeUndefined();
  });
});

describe('stack trace locations', () => {
  it('reads .NET, Python and Rust frames and prefers the test file', () => {
    const trace = '   at Calc.Calculator.Divide(Int32 a, Int32 b) in /w/Calc/Calculator.cs:line 13\n   at XUnitTests.CalculatorTests.M() in /w/XUnitTests/CalculatorTests.cs:line 40\n   at System.X()';
    expect(stackLocations(trace)).toEqual([
      { path: '/w/Calc/Calculator.cs', line: 13, text: 'at Calc.Calculator.Divide(Int32 a, Int32 b)' },
      { path: '/w/XUnitTests/CalculatorTests.cs', line: 40, text: 'at XUnitTests.CalculatorTests.M()' },
    ]);
    expect(failureLocation(trace, () => true, '/w/XUnitTests/CalculatorTests.cs')).toMatchObject({ path: '/w/XUnitTests/CalculatorTests.cs', line: 40 });
    expect(failureLocation(trace, (p) => p.includes('Calc/'))).toMatchObject({ path: '/w/Calc/Calculator.cs', line: 13 });
    expect(failureLocation(undefined, () => true)).toBeUndefined();
    expect(stackLocations('  File "/w/tests/test_a.py", line 7, in test_x')).toEqual([{ path: '/w/tests/test_a.py', line: 7, text: 'in test_x' }]);
    expect(stackLocations('tests/test_a.py:7: AssertionError')).toEqual([{ path: 'tests/test_a.py', line: 7, text: 'AssertionError' }]);
    expect(stackLocations("thread 'tests::adds' panicked at src/lib.rs:12:9:")).toMatchObject([{ path: 'src/lib.rs', line: 12 }]);
    expect(stackLocations('   at C:\\w\\X.cs not a frame')).toEqual([]);
  });
});

describe('pytest', () => {
  const collected = 'tests/test_math.py::test_add\ntests/test_math.py::TestDiv::test_div[1-1]\ntests/test_math.py::TestDiv::test_div[4-2]\n\n3 tests collected in 0.01s\n';
  it('reads collected node ids and builds file → class → function → parameter cases', () => {
    const ids = parsePytestCollect(collected);
    expect(ids).toEqual(['tests/test_math.py::test_add', 'tests/test_math.py::TestDiv::test_div[1-1]', 'tests/test_math.py::TestDiv::test_div[4-2]']);
    const tree = buildPytestTree(ids, '/w', (rel) => `file:///w/${rel}`);
    expect(outline(tree)).toEqual(['file:tests/test_math.py', '  method:test_add', '  class:TestDiv', '    method:test_div', '      case:[1-1]', '      case:[4-2]']);
    expect(tree[0]!.children[1]!.children[0]!.key).toBe('tests/test_math.py::TestDiv::test_div');
    expect(tree[0]!.children[1]!.children[0]!.children[0]!.id).toBe('python:tests/test_math.py::TestDiv::test_div[1-1]');
    expect(parsePytestCollect('no tests ran in 0.01s\n')).toEqual([]);
  });

  it('maps JUnit XML testcases to node ids and reads failures', () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="pytest" tests="3">
<testcase classname="tests.test_math" name="test_add" time="0.001" />
<testcase classname="tests.test_math.TestDiv" name="test_div[4-2]" time="0.002"><failure message="assert 2 == 3">tests/test_math.py:9: AssertionError</failure><system-out>out &lt;1&gt;</system-out></testcase>
<testcase classname="tests.test_math.TestDiv" name="test_div[1-1]" time="0"><skipped type="pytest.skip" message="later" /></testcase>
</testsuite></testsuites>`;
    const res = parseJunitXml(xml);
    expect(res.map((x) => x.outcome)).toEqual(['passed', 'failed', 'skipped']);
    expect(res[1]).toMatchObject({ message: 'assert 2 == 3', details: 'tests/test_math.py:9: AssertionError', stdout: 'out <1>', durationMs: 2 });
    const known = new Set(parsePytestCollect(collected));
    expect(pytestNodeId('tests.test_math.TestDiv', 'test_div[4-2]', known)).toBe('tests/test_math.py::TestDiv::test_div[4-2]');
    expect(pytestNodeId('tests.test_math', 'test_add', known)).toBe('tests/test_math.py::test_add');
    expect(pytestNodeId('other', 'x', known)).toBeUndefined();
    expect(pytestArgs(['a.py::t'], '/tmp/r.xml')).toEqual(['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--junitxml=/tmp/r.xml', 'a.py::t']);
  });
});

describe('cargo test', () => {
  it('lists tests, builds module → test and parses results with failure output', () => {
    const names = parseCargoList('tests::adds: test\ntests::inner::subtracts: test\nbench_x: benchmark\n\n2 tests, 0 benchmarks\n');
    expect(names).toEqual(['tests::adds', 'tests::inner::subtracts']);
    expect(outline(buildCargoTree(names, '/w/crate', 'crate'))).toEqual(['project:crate', '  module:tests', '    method:adds', '    module:inner', '      method:subtracts']);
    const out = `running 3 tests
test tests::adds ... ok
test tests::inner::subtracts ... FAILED
test tests::later ... ignored

failures:

---- tests::inner::subtracts stdout ----
thread 'tests::inner::subtracts' panicked at src/lib.rs:12:9:
assertion failed

failures:
    tests::inner::subtracts

test result: FAILED. 1 passed; 1 failed; 1 ignored
`;
    const res = parseCargoTestOutput(out);
    expect(res.map((x) => `${x.name}:${x.outcome}`)).toEqual(['tests::adds:passed', 'tests::inner::subtracts:failed', 'tests::later:skipped']);
    expect(res[1]!.output).toContain('assertion failed');
    expect(cargoTestArgs([{ kind: 'method', key: 'tests::adds' }])).toEqual(['test', '--', '--exact', 'tests::adds']);
    expect(cargoTestArgs([{ kind: 'module', key: 'tests::' }])).toEqual(['test', '--', 'tests::']);
    expect(cargoTestArgs([{ kind: 'project', key: '' }])).toEqual(['test']);
  });
});

describe('coverage (coverlet.collector)', () => {
  it('reads line hits per file from a Cobertura report, merged across classes', () => {
    const xml = `<?xml version="1.0"?><coverage line-rate="0.8"><sources><source>/w/</source></sources><packages><package name="Calc"><classes>
<class name="Calc.Calculator" filename="Calc/Calculator.cs"><methods><method name="Add"><lines><line number="6" hits="3" /></lines></method></methods>
<lines><line number="6" hits="3" branch="False" /><line number="7" hits="3" /><line number="13" hits="0" /></lines></class>
<class name="Calc.Calculator/&lt;&gt;c" filename="Calc/Calculator.cs"><lines><line number="13" hits="1" /></lines></class>
</classes></package></packages></coverage>`;
    const r = parseCobertura(xml);
    expect(r.sources).toEqual(['/w/']);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]!.filename).toBe('Calc/Calculator.cs');
    expect([...r.files[0]!.lines]).toEqual([[6, 3], [7, 3], [13, 1]]);
  });
  it('needs coverlet.collector in the project or its restored assets', () => {
    expect(referencesCoverlet('<PackageReference Include="coverlet.collector" Version="6.0.0" />')).toBe(true);
    expect(referencesCoverlet('<Project />', '{"libraries":{"coverlet.collector/6.0.0":{}}}')).toBe(true);
    expect(referencesCoverlet('<Project />', '{}')).toBe(false);
    expect(dotnetTestArgs('/w/T.csproj', { resultsDirectory: '/r', coverage: true }).slice(-2)).toEqual(['--collect', 'XPlat Code Coverage']);
  });
});

describe('Testing status row (instead of VS Code\'s "Install Additional Test Extensions")', () => {
  it('explains the state: trust, no solution, loading, failed, nothing found', async () => {
    const { testingStatusText } = await import('../../src/testingModel');
    expect(testingStatusText({ trusted: false, csharpState: 'Ready', discovered: true }).label).toMatch(/trusted workspace/);
    expect(testingStatusText({ trusted: true, csharpState: undefined, discovered: false }).label).toMatch(/no \.NET solution/);
    expect(testingStatusText({ trusted: true, csharpState: 'Loading', discovered: false }).label).toMatch(/loading/);
    expect(testingStatusText({ trusted: true, csharpState: 'Failed', discovered: false }).description).toMatch(/Show Health/);
    expect(testingStatusText({ trusted: true, csharpState: 'Ready', discovered: true }).label).toMatch(/no tests found/);
    expect(testingStatusText({ trusted: true, csharpState: 'Ready', discovered: false }).label).toMatch(/no test projects/);
  });
});

describe('VSTest or Microsoft Testing Platform', () => {
  it('detects MTP projects and the TRX switch of their framework', async () => {
    const { detectTestRunner, mtpTestArgs } = await import('../../src/testingModel');
    const pkg = (id: string) => `<PackageReference Include="${id}" Version="1.0.0" />`;
    expect(detectTestRunner(`<Project Sdk="Microsoft.NET.Sdk">${pkg('xunit')}${pkg('xunit.runner.visualstudio')}</Project>`)).toEqual({ runner: 'vstest', report: '--report-trx' });
    expect(detectTestRunner(`<Project Sdk="MSTest.Sdk/4.5.1"></Project>`)).toEqual({ runner: 'mtp', report: '--report-trx' });
    expect(detectTestRunner(`<Project><PropertyGroup><UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner></PropertyGroup>${pkg('xunit.v3')}</Project>`)).toEqual({ runner: 'mtp', report: '--report-xunit-trx' });
    expect(detectTestRunner(`<Project><PropertyGroup><EnableNUnitRunner>true</EnableNUnitRunner></PropertyGroup>${pkg('NUnit')}</Project>`).runner).toBe('mtp');
    // xunit.v3.mtp-off: VSTest even when global.json selects MTP.
    expect(detectTestRunner(`<Project>${pkg('xunit.v3.mtp-off')}</Project>`, '{"test":{"runner":"Microsoft.Testing.Platform"}}').runner).toBe('vstest');
    expect(detectTestRunner(`<Project>${pkg('MSTest.TestFramework')}</Project>`, '{"test":{"runner":"Microsoft.Testing.Platform"}}').runner).toBe('mtp');
    expect(detectTestRunner(`<Project>${pkg('NUnit')}</Project>`, '{ broken').runner).toBe('vstest');
    expect(mtpTestArgs('/b/T.dll', { report: '--report-trx', resultsDirectory: '/r', filter: 'FullyQualifiedName=A.B' })).toEqual(['exec', '/b/T.dll', '--report-trx', '--results-directory', '/r', '--filter', 'FullyQualifiedName=A.B']);
  });
});
