import { describe, expect, it } from 'vitest';
import {
  type Edit,
  constructorCandidates,
  directConstructions,
  fieldAt,
  findClass,
  findRegistrationTargets,
  implementationsOf,
  inferFieldType,
  isFrameworkProvided,
  isRegisteredByText,
  namingFromEditorConfig,
  namingStyle,
  parameterAt,
  parameterNameForType,
  planCreateInjectedField,
  planGenerateConstructor,
  planInitializeAll,
  planInitializeMembers,
  planIntroduce,
  rankTypeCandidates,
  registrationEdit,
  undeclaredFieldAt,
  unassignedMembers,
} from '../../src/constructorModel';

function apply(text: string, edits: Edit[]): string {
  let out = text;
  for (const e of [...edits].map((e, i) => ({ e, i })).sort((a, b) => b.e.offset - a.e.offset || b.i - a.i)) out = out.slice(0, e.e.offset) + e.e.text + out.slice(e.e.offset + e.e.length);
  return out;
}
const ok = (r: ReturnType<typeof planIntroduce>) => {
  if ('refused' in r) throw new Error(r.refused);
  return r.edits;
};

const SERVICE = `namespace Shop;

public class OrderService
{
    private readonly ILogger<OrderService> _logger;

    public OrderService(ILogger<OrderService> logger, IOrderRepository repository, IClock clock)
    {
        _logger = logger;
    }

    public void Place(int id) => _logger.LogInformation("x");
}
`;

describe('class syntax pass', () => {
  it('reads fields, constructors and parameters', () => {
    const c = findClass(SERVICE, SERVICE.indexOf('repository'))!;
    expect(c.name).toBe('OrderService');
    expect(c.fields.map((f) => f.name)).toEqual(['_logger']);
    expect(c.ctors).toHaveLength(1);
    expect(c.ctors[0]!.params.map((p) => `${p.type} ${p.name}`)).toEqual(['ILogger<OrderService> logger', 'IOrderRepository repository', 'IClock clock']);
    expect(parameterAt(c, SERVICE.indexOf('repository'))!.param.name).toBe('repository');
  });
  it('reads records, structs, primary constructors and nested classes', () => {
    const src = 'public record Person(string Name, int Age)\n{\n    public int X { get; }\n}\npublic sealed partial class Outer\n{\n    private class Inner { private int _a; }\n    private int _b;\n}\npublic class Svc(IRepo repo)\n{\n}\n';
    expect(findClass(src, src.indexOf('Age'))!.primaryParams!.map((p) => p.name)).toEqual(['Name', 'Age']);
    const outer = findClass(src, src.indexOf('_b'))!;
    expect(outer.isPartial).toBe(true);
    expect(outer.fields.map((f) => f.name)).toEqual(['_b']);
    expect(findClass(src, src.indexOf('_a'))!.name).toBe('Inner');
    expect(findClass(src, src.indexOf('repo)'))!.primaryParams![0]!.type).toBe('IRepo');
  });
});

describe('naming style', () => {
  it('reads .editorconfig private field rules', () => {
    const ec = `root = true
[*.cs]
dotnet_naming_rule.private_fields.symbols = private_fields
dotnet_naming_rule.private_fields.style = camel_underscore
dotnet_naming_rule.private_fields.severity = warning
dotnet_naming_symbols.private_fields.applicable_kinds = field
dotnet_naming_symbols.private_fields.applicable_accessibilities = private
dotnet_naming_style.camel_underscore.required_prefix = _
dotnet_naming_style.camel_underscore.capitalization = camel_case
`;
    expect(namingFromEditorConfig(ec)).toEqual({ prefix: '_' });
    expect(namingStyle(undefined, ec.replace('required_prefix = _', 'required_prefix =') + 'dotnet_style_qualification_for_field = true:warning\n')).toEqual({ prefix: '', useThis: true, source: 'editorconfig' });
  });
  it('follows existing fields, else _camelCase', () => {
    const camel = 'class A\n{\n    private readonly IX x;\n    private int count;\n    public A(IY y) { }\n}\n';
    const c = findClass(camel, camel.indexOf('IY'))!;
    const style = namingStyle(c);
    expect(style).toEqual({ prefix: '', useThis: true, source: 'existing fields' });
    expect(apply(camel, ok(planIntroduce(camel, c, parameterAt(c, camel.indexOf('IY'))!, style, 'field')))).toContain('this.y = y;');
    expect(namingStyle(findClass('class B { }', 0))).toEqual({ prefix: '_', useThis: false, source: 'default' });
  });
});

describe('introduce and initialize from a constructor parameter', () => {
  const c = findClass(SERVICE, SERVICE.indexOf('repository'))!;
  const style = namingStyle(c);
  const at = parameterAt(c, SERVICE.indexOf('repository'))!;

  it('creates a readonly field next to the others and assigns it', () => {
    const out = apply(SERVICE, ok(planIntroduce(SERVICE, c, at, style, 'field')));
    expect(out).toContain('    private readonly ILogger<OrderService> _logger;\n    private readonly IOrderRepository _repository;\n');
    expect(out).toContain('        _logger = logger;\n        _repository = repository;\n    }');
  });
  it('creates a get-only property', () => {
    const out = apply(SERVICE, ok(planIntroduce(SERVICE, c, at, style, 'property')));
    expect(out).toContain('public IOrderRepository Repository { get; }');
    expect(out).toContain('Repository = repository;');
  });
  it('initialises all unassigned parameters, reusing an unassigned field of the same type', () => {
    const src = SERVICE.replace('    private readonly ILogger<OrderService> _logger;\n', '    private readonly ILogger<OrderService> _logger;\n    private readonly IClock _time;\n');
    const cc = findClass(src, src.indexOf('repository'))!;
    expect(unassignedMembers(cc).map((u) => u.name)).toEqual(['_time']);
    const r = planInitializeAll(src, cc, cc.ctors[0]!, style);
    const out = apply(src, ok(r));
    expect(out).toContain('_repository = repository;');
    expect(out).toContain('_time = clock;');
    expect(out).not.toContain('_clock');
  });
  it('turns an expression-bodied constructor into a block', () => {
    const src = 'class A\n{\n    private readonly int _a;\n    public A(int a, int b) => _a = a;\n}\n';
    const cc = findClass(src, src.indexOf('int b'))!;
    const out = apply(src, ok(planIntroduce(src, cc, parameterAt(cc, src.indexOf('int b') + 4)!, namingStyle(cc), 'field')));
    expect(out).toContain('    public A(int a, int b)\n    {\n        _a = a;\n        _b = b;\n    }');
  });
  it('primary constructors: field initialised from the parameter', () => {
    const src = 'public class Svc(IRepo repo, IClock clock)\n{\n    private readonly IClock _clock = clock;\n}\n';
    const cc = findClass(src, src.indexOf('repo,'))!;
    const out = apply(src, ok(planIntroduce(src, cc, parameterAt(cc, src.indexOf('repo,'))!, namingStyle(cc), 'field')));
    expect(out).toContain('private readonly IRepo _repo = repo;');
  });
  it('refuses a name that exists', () => {
    const r = planIntroduce(SERVICE, c, parameterAt(c, SERVICE.indexOf('logger,'))!, style, 'field');
    expect(r).toEqual({ refused: "A member named '_logger' already exists." });
  });
});

describe('initialize members from the constructor and generate constructors', () => {
  it('adds a parameter and assignment to the single constructor', () => {
    const src = 'class A\n{\n    private readonly IRepo _repo;\n    private readonly IClock _clock;\n    public A(IClock clock)\n    {\n        _clock = clock;\n    }\n}\n';
    const c = findClass(src, src.indexOf('_repo'))!;
    expect(fieldAt(c, src.indexOf('_repo'))!.name).toBe('_repo');
    const out = apply(src, ok(planInitializeMembers(src, c, unassignedMembers(c), namingStyle(c))));
    expect(out).toContain('public A(IClock clock, IRepo repo)');
    expect(out).toContain('        _clock = clock;\n        _repo = repo;\n');
  });
  it('creates the constructor when there is none', () => {
    const src = 'class A\n{\n    private readonly IRepo _repo;\n    private readonly IClock _clock;\n    public int Count { get; }\n}\n';
    const c = findClass(src, src.indexOf('_repo'))!;
    expect(constructorCandidates(c).map((x) => `${x.name}:${x.preselect}`)).toEqual(['_repo:true', '_clock:true', 'Count:true']);
    const out = apply(src, ok(planGenerateConstructor(src, c, unassignedMembers(c), namingStyle(c))));
    expect(out).toContain('    public int Count { get; }\n\n    public A(IRepo repo, IClock clock, int count)\n    {\n        _repo = repo;\n        _clock = clock;\n        Count = count;\n    }\n}');
  });
  it('asks for a constructor when there are several, refuses for static classes and an existing signature', () => {
    const src = 'class A\n{\n    private readonly int _a;\n    public A() { }\n    public A(string s) { }\n}\n';
    const c = findClass(src, src.indexOf('_a'))!;
    expect(planInitializeMembers(src, c, unassignedMembers(c), namingStyle(c))).toEqual({ refused: 'Choose a constructor.' });
    expect('refused' in planInitializeMembers(src, c, unassignedMembers(c), namingStyle(c), c.ctors[0])).toBe(false);
    const empty = apply(src, (planInitializeMembers(src, c, unassignedMembers(c), namingStyle(c), c.ctors[0]) as { edits: Edit[] }).edits);
    expect(empty).toContain('public A(int a)\n    {\n        _a = a;\n    }');
    expect('refused' in planGenerateConstructor('static class S { private static int _x; }', findClass('static class S { private static int _x; }', 0)!, [{ name: '_x', type: 'int', kind: 'field' }], namingStyle(undefined))).toBe(true);
    expect(planGenerateConstructor(src, c, [{ name: 's', type: 'string', kind: 'field' }], namingStyle(c))).toEqual({ refused: 'A constructor with these parameter types already exists.' });
  });
  it('finds direct constructions (call sites) by text', () => {
    expect(directConstructions('A', [{ uri: 'x.cs', text: 'var a = new A(1); var b = new AB(); // new A(2)' }])).toHaveLength(1);
  });
});

describe('create field from an undeclared identifier', () => {
  const src = 'class OrderService\n{\n    public OrderService() { }\n    public void F(int id) { _logger.LogInformation("x"); var o = _repo.Get(id); }\n}\n';
  const c = findClass(src, src.indexOf('_repo'))!;
  it('detects field-shaped undeclared names', () => {
    expect(undeclaredFieldAt(src, c, src.indexOf('_repo') + 2)!.name).toBe('_repo');
    expect(undeclaredFieldAt(src, c, src.indexOf('id)'))).toBeUndefined();
  });
  it('infers well-known types and ranks solution types (interfaces first)', () => {
    expect(inferFieldType(src, c, '_logger')).toBe('ILogger<OrderService>');
    expect(inferFieldType(src, c, '_repo')).toBeUndefined();
    expect(rankTypeCandidates('_repo', [{ name: 'Repo', isInterface: false }, { name: 'IRepo', isInterface: true }, { name: 'Clock', isInterface: false }])).toEqual(['IRepo', 'Repo', 'Clock']);
    expect(parameterNameForType('IOrderRepository')).toBe('orderRepository');
  });
  it('adds field, parameter and assignment', () => {
    const out = apply(src, ok(planCreateInjectedField(src, c, '_repo', 'IRepo', namingStyle(c))));
    expect(out).toContain('private readonly IRepo _repo;');
    expect(out).toContain('public OrderService(IRepo repo)');
    expect(out).toContain('_repo = repo;');
  });
});

describe('DI registration targets', () => {
  const program = { uri: 'file:///app/Program.cs', text: 'var builder = WebApplication.CreateBuilder(args);\nbuilder.Services.AddScoped<IClock, Clock>();\nbuilder.Services.AddControllers(o =>\n{\n});\nvar app = builder.Build();\n' };
  const ext = { uri: 'file:///app/ServiceCollectionExtensions.cs', text: 'public static class X\n{\n    public static IServiceCollection AddShop(this IServiceCollection services)\n    {\n        services.AddScoped<IA, A>();\n        return services;\n    }\n}\n' };
  const impl = { uri: 'file:///app/Repo.cs', text: 'public class SqlOrderRepository : IOrderRepository { }\npublic interface IOrderRepository { }\n' };
  it('finds Program.cs top-level and extension-method roots', () => {
    const t = findRegistrationTargets([program, ext, impl]);
    expect(t.map((x) => x.label)).toEqual(['builder.Services in Program.cs', 'AddShop(this IServiceCollection services) in ServiceCollectionExtensions.cs']);
    const out = program.text.slice(0, t[0]!.offset) + registrationEdit(t[0]!, 'Scoped', 'IOrderRepository', 'SqlOrderRepository').text + program.text.slice(t[0]!.offset);
    expect(out).toContain('builder.Services.AddControllers(o =>\n{\n});\nbuilder.Services.AddScoped<IOrderRepository, SqlOrderRepository>();\nvar app');
    const out2 = ext.text.slice(0, t[1]!.offset) + registrationEdit(t[1]!, 'Singleton', 'B').text + ext.text.slice(t[1]!.offset);
    expect(out2).toContain('        services.AddSingleton<B>();\n        return services;');
  });
  it('falls back to the builder line, finds nothing without a root', () => {
    expect(findRegistrationTargets([{ uri: 'Program.cs', text: 'var builder = Host.CreateApplicationBuilder(args);\nbuilder.Build().Run();\n' }])[0]!.receiver).toBe('builder.Services');
    expect(findRegistrationTargets([impl])).toEqual([]);
  });
  it('pairs an interface with its only implementation and checks registration', () => {
    expect(implementationsOf('IOrderRepository', [impl])).toEqual(['SqlOrderRepository']);
    expect(isRegisteredByText('IClock', [program])).toBe(true);
    expect(isRegisteredByText('IOrderRepository', [program])).toBe(false);
    expect(isFrameworkProvided('ILogger<OrderService>')).toBe(true);
  });
});
