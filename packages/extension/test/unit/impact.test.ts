import { describe, expect, it } from 'vitest';
import { changedCSharpFiles, impactGroups, impactSummary } from '../../src/impactModel';

const rel = (group: string, label: string) => ({ via: 'OrderService', relation: { group, relationKind: 'x', target: { label, location: { uri: 'file:///a.cs', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } } }, evidence: [], confidence: 'proven', provenance: {}, limitations: [] } });

describe('Change Impact', () => {
  it('groups the relations in a fixed order, empty groups left out', () => {
    const r = { changed: [], relations: [rel('references', 'OrderHandlers.cs:9'), rel('registrations', 'AddScoped<IOrderService, OrderService>')], tests: [], truncated: false, snapshotId: 's' };
    const g = impactGroups(r as never);
    expect(g.map((x) => x.id)).toEqual(['registrations', 'references']);
    expect(g[1]!.entries[0]).toMatchObject({ label: 'OrderHandlers.cs:9', via: 'OrderService' });
  });

  it('reads the changed C# files from git status --porcelain', () => {
    const porcelain = [' M src/Api/OrderService.cs', '?? src/Api/New.cs', ' D src/Old.cs', 'R  src/A.cs -> src/B.cs', ' M README.md', ' M "src/With Space.razor"'].join('\n');
    expect(changedCSharpFiles(porcelain)).toEqual(['src/Api/OrderService.cs', 'src/Api/New.cs', 'src/B.cs', 'src/With Space.razor']);
  });

  it('summarises and says when a limit cut it', () => {
    expect(impactSummary({ changed: [{} as never], relations: [], tests: [{ fullyQualifiedName: 'a', reason: '' }, { fullyQualifiedName: 'b', reason: '' }], truncated: true, snapshotId: 's' })).toBe('1 changed symbol · 0 relations · 2 tests · cut at a limit: the impact may be larger');
  });
});
