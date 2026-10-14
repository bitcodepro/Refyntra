import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MetadataDocument, MetadataSourceResult, SymbolRef } from '@refyntra/contracts';
import { metadataDocumentRef } from '@refyntra/application';
import {
  MetadataDocumentStore,
  OPEN_DECOMPILED,
  frameTypeDocumentationId,
  metadataAction,
  metadataHealthText,
  metadataHoverMarkdown,
  metadataUriString,
  originLine,
  sourcePolicy,
} from '../../src/metadataModel';
import { navigateTargets, targetOutcome } from '../../src/navigateToModel';
import { DEFAULT_FILTERS, structureSections } from '../../src/fileStructureModel';

const range = (line: number, a: number, b: number) => ({ start: { line, character: a }, end: { line, character: b } });

const doc = (over: Partial<MetadataDocument> = {}): MetadataDocument => ({
  path: 'MediatR/MediatR.IMediator.cs',
  assemblyName: 'MediatR',
  assemblyVersion: '12.0.0.0',
  assemblyPath: '/nuget/mediatr/12.5.0/lib/net8.0/MediatR.dll',
  implementationPath: '/nuget/mediatr/12.5.0/lib/net8.0/MediatR.dll',
  mvid: '00000000-0000-0000-0000-000000000001',
  origin: 'decompiled',
  typeDocumentationId: 'T:MediatR.IMediator',
  text: '// MediatR.IMediator\npublic interface IMediator : ISender, IPublisher { }\n',
  symbols: [{ documentationId: 'T:MediatR.IMediator', nameRange: range(1, 17, 26), range: range(1, 0, 50) }],
  ...over,
});

const result = (over: Partial<MetadataSourceResult> = {}): MetadataSourceResult => ({ decompilerVersion: '11.1.0.9782', snapshotId: 's1', ...over });

describe('metadata document URIs', () => {
  it('round-trips "<assembly>/<Namespace.Type>.cs" to the type documentation id and assembly', () => {
    const uri = metadataUriString('MediatR/MediatR.IMediator.cs');
    expect(uri).toBe('refyntra-metadata:/MediatR/MediatR.IMediator.cs');
    expect(metadataDocumentRef(uri)).toEqual({ documentationId: 'T:MediatR.IMediator', assemblyName: 'MediatR' });
  });

  it('encodes generic arity and keeps it in the documentation id', () => {
    const uri = metadataUriString('System.Private.CoreLib/System.Collections.Generic.List`1.cs');
    expect(uri).toBe('refyntra-metadata:/System.Private.CoreLib/System.Collections.Generic.List%601.cs');
    expect(metadataDocumentRef(uri)).toEqual({ documentationId: 'T:System.Collections.Generic.List`1', assemblyName: 'System.Private.CoreLib' });
  });

  it('rejects other schemes, nested folders and non-.cs paths', () => {
    expect(metadataDocumentRef('file:///c%3A/src/Program.cs')).toBeUndefined();
    expect(metadataDocumentRef('refyntra-metadata:/a/b/c.cs')).toBeUndefined();
    expect(metadataDocumentRef('refyntra-metadata:/MediatR/MediatR.IMediator.txt')).toBeUndefined();
    expect(metadataDocumentRef('refyntra-metadata:/%E0%A4%A')).toBeUndefined();
  });
});

describe('metadata document store', () => {
  it('keeps the newest documents and moves a re-opened one to the end', () => {
    const store = new MetadataDocumentStore(2);
    store.set('a', doc({ path: 'A/A.cs' }));
    store.set('b', doc({ path: 'B/B.cs' }));
    store.set('a', doc({ path: 'A/A.cs' }));
    store.set('c', doc({ path: 'C/C.cs' }));
    expect(store.uris()).toEqual(['a', 'c']);
    expect(store.get('b')).toBeUndefined();
    expect(store.size).toBe(2);
  });
});

describe('what an answer of code/metadataSource does', () => {
  it('opens the document at the symbol, a solution location for source symbols, or says why not', () => {
    const d = doc();
    expect(metadataAction(result({ document: d, symbolRange: range(1, 17, 26) }), 'Navigate To')).toEqual({ kind: 'document', uri: 'refyntra-metadata:/MediatR/MediatR.IMediator.cs', document: d, selection: range(1, 17, 26) });
    expect(metadataAction(result({ reasonCode: 'InSource', location: { uri: 'file:///src/Order.cs', range: range(3, 0, 5) } }), 'x')).toEqual({ kind: 'location', uri: 'file:///src/Order.cs', range: range(3, 0, 5) });
    const missing = metadataAction(result({ reasonCode: 'AssemblyNotFound' }), 'Find');
    expect(missing).toEqual({ kind: 'message', severity: 'warning', text: 'Refyntra Go to Metadata (Find): The assembly file of the symbol is not available on this machine.' });
    const none = metadataAction(result({ reasonCode: 'NoSymbol', message: 'Nothing here.' }), 'at the cursor');
    expect(none).toEqual({ kind: 'message', severity: 'info', text: 'Refyntra Go to Metadata (at the cursor): Nothing here.' });
  });

  it('describes where the text comes from, without directories', () => {
    expect(originLine(doc(), '11.1.0.9782')).toBe('Decompiled from MediatR.dll with ICSharpCode.Decompiler 11.1.0.9782; read-only.');
    expect(originLine(doc({ origin: 'embeddedSource', sourceDocument: '/_/src/Lib/Calc.cs', implementationPath: 'C:\\lib\\Lib.dll' }), '')).toBe('Source embedded in the PDB of Lib.dll (/_/src/Lib/Calc.cs); read-only.');
    expect(originLine(doc({ note: 'Reference assembly: no bodies.' }), '')).toContain('(unknown version); read-only. Reference assembly: no bodies.');
  });

  it('reads the setting strictly: anything but "off" keeps embedded sources first', () => {
    expect(sourcePolicy('off')).toBe('off');
    expect(sourcePolicy('embeddedOnly')).toBe('embeddedOnly');
    expect(sourcePolicy('download')).toBe('embeddedOnly');
    expect(sourcePolicy(undefined)).toBe('embeddedOnly');
  });

  it('health says decompiler, policy, no network and the document count', () => {
    const t = metadataHealthText({ decompilerVersion: '11.1.0.9782', policy: 'embeddedOnly', documents: 1 });
    expect(t).toContain('ICSharpCode.Decompiler 11.1.0.9782 (MIT)');
    expect(t).toContain('nothing is downloaded');
    expect(t).toContain('1 document opened');
    expect(metadataHealthText({ decompilerVersion: '', policy: 'off', documents: 0, lastError: 'boom' })).toMatch(/version is shown after the first.*always decompiled.*0 documents opened.*Last problem: boom/);
  });
});

describe('stack frames and hovers', () => {
  it('maps reflection type names to documentation ids', () => {
    expect(frameTypeDocumentationId('System.Runtime.ExceptionServices.ExceptionDispatchInfo')).toEqual({ documentationId: 'T:System.Runtime.ExceptionServices.ExceptionDispatchInfo', topLevel: 'T:System.Runtime.ExceptionServices.ExceptionDispatchInfo' });
    expect(frameTypeDocumentationId('System.Collections.Generic.List`1+Enumerator')).toEqual({ documentationId: 'T:System.Collections.Generic.List`1.Enumerator', topLevel: 'T:System.Collections.Generic.List`1' });
    expect(frameTypeDocumentationId('System.Linq.Enumerable[[System.Int32]]')?.documentationId).toBe('T:System.Linq.Enumerable');
    expect(frameTypeDocumentationId('Sample.<>c')).toBeUndefined();
    expect(frameTypeDocumentationId('not a type')).toBeUndefined();
  });

  it('hover escapes Markdown and names where the symbol lives', () => {
    const s = { name: 'Send', displayName: 'MediatR.ISender.Send<TResponse>(IRequest<TResponse>)', kind: 'method', origin: 'metadata' } as SymbolRef;
    const md = metadataHoverMarkdown(s, 'Asynchronously send a request [to a single handler].');
    expect(md).toBe('**MediatR\\.ISender\\.Send\\<TResponse\\>\\(IRequest\\<TResponse\\>\\)** \u2014 method in library \\(metadata\\)\n\nAsynchronously send a request \\[to a single handler\\]\\.');
    expect(metadataHoverMarkdown({ ...s, origin: 'source', projectName: 'Shop.Api' }, null)).toContain('in project Shop\\.Api');
  });
});

describe('navigation entry points offer decompiled sources', () => {
  it('Navigate To lists the decompiled declaration of a library symbol', () => {
    const targets = navigateTargets({
      subject: { name: 'String', kind: 'class', origin: 'metadata', symbolId: 'sym-1' },
      currentUri: 'file:///src/a.cs',
      groups: [],
      bases: [],
      containing: [],
      siblingFiles: [],
    });
    expect(targets.map((t) => t.id)).toEqual(['metadata']);
    expect(targets[0]!.label).toBe('Decompiled declaration');
    expect(targetOutcome(targets[0]!)).toEqual({ kind: 'metadata', symbolId: 'sym-1' });
    const source = navigateTargets({ subject: { name: 'Order', kind: 'class', origin: 'source', symbolId: 'sym-2' }, currentUri: 'file:///src/a.cs', groups: [], bases: [], containing: [], siblingFiles: [] });
    expect(source.map((t) => t.id)).not.toContain('metadata');
  });

  it('File Structure rows of inherited library members carry what opens their decompiled source', () => {
    const r = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const sections = structureSections(
      {
        types: [
          {
            name: 'AppException', fullName: 'AppException', kind: 'class', accessibility: 'public', isStatic: false, signature: 'AppException : Exception', range: r, selectionRange: r, members: [],
            inherited: [
              { name: 'StackTrace', kind: 'property', accessibility: 'public', isStatic: false, signature: 'StackTrace : string?', range: r, selectionRange: r, declaringType: 'Exception', uri: null, navigable: false, documentationId: 'P:System.Exception.StackTrace', assemblyName: 'System.Runtime' },
              { name: 'Old', kind: 'method', accessibility: 'public', isStatic: false, signature: 'Old()', range: r, selectionRange: r, declaringType: 'Exception', uri: null, navigable: false },
            ],
          },
        ],
        inheritedAvailable: true,
        accessibility: true,
      } as unknown as Parameters<typeof structureSections>[0],
      { ...DEFAULT_FILTERS, inherited: true },
    );
    const rows = sections.flatMap((s) => s.rows).filter((x) => x.inherited);
    expect(rows.map((x) => [x.label, x.navigable, x.metadata ?? null, x.description.split(' · ').pop()])).toEqual([
      ['StackTrace : string?', false, { documentationId: 'P:System.Exception.StackTrace', assemblyName: 'System.Runtime' }, 'library: opens decompiled'],
      ['Old()', false, null, 'no source (metadata)'],
    ]);
  });
});

describe('manifest', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    contributes: {
      commands: { command: string; title: string }[];
      keybindings: { command: string; key: string; when: string }[];
      menus: Record<string, { command: string; when?: string }[]>;
      configuration: { properties: Record<string, { default?: unknown; enum?: string[] }> };
    };
  };

  it('contributes the command, the setting (embeddedOnly by default, no download option) and keys only inside metadata documents', () => {
    expect(pkg.contributes.commands.find((c) => c.command === 'refyntra.goToMetadata')?.title).toBe('Go to Metadata / Decompiled Source');
    const setting = pkg.contributes.configuration.properties['refyntra.metadata.sourceLink']!;
    expect(setting.default).toBe('embeddedOnly');
    expect(setting.enum).toEqual(['embeddedOnly', 'off']);
    const keys = pkg.contributes.keybindings.filter((k) => k.command === 'refyntra.goToMetadata' || (k.command === 'refyntra.findUsages' && k.when.includes('refyntra-metadata')));
    expect(keys.map((k) => k.key).sort()).toEqual(['f12', 'f12', 'shift+f12', 'shift+f12']);
    for (const k of keys) expect(k.when).toContain('resourceScheme == refyntra-metadata');
    expect(pkg.contributes.menus.commandPalette!.find((m) => m.command === 'refyntra.openMetadata')?.when).toBe('false');
    expect(OPEN_DECOMPILED).toBe('Open Decompiled Source');
  });
});
