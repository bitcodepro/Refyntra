import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import {
  type ClassInfo,
  type Edit,
  type Lifetime,
  type Member,
  type PlanResult,
  constructorCandidates,
  directConstructions,
  fieldAt,
  findClass,
  findRegistrationTargets,
  implementationsOf,
  inferFieldType,
  isFrameworkProvided,
  isRegisteredByText,
  looksLikeInterface,
  namingStyle,
  parameterAt,
  planCreateInjectedField,
  planGenerateConstructor,
  planInitializeAll,
  planInitializeMembers,
  planIntroduce,
  rankTypeCandidates,
  registrationEdit,
  undeclaredFieldAt,
  unassignedMembers,
  unassignedParameters,
} from './constructorModel';
import { toPosition } from './convert';
import type { VsCodeEditApplier } from './editApplier';
import { applyGenerate } from './generate';

const KIND = vscode.CodeActionKind.RefactorRewrite.append('refyntra').append('constructor');
const QUICKFIX = vscode.CodeActionKind.QuickFix.append('refyntra').append('constructor');
const MAX_FILES = 3000;

interface Target { uri: string; offset: number }

async function editorConfigText(uri: vscode.Uri): Promise<string | undefined> {
  // Nearest .editorconfig files from the document's folder up to the workspace folder (closest last wins in our parser).
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const parts: string[] = [];
  let dir = vscode.Uri.joinPath(uri, '..');
  for (let i = 0; i < 12; i++) {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, '.editorconfig'));
      const text = new TextDecoder().decode(bytes);
      parts.unshift(text);
      if (/^\s*root\s*=\s*true/im.test(text)) break;
    } catch {
      // none here
    }
    if (!folder || dir.path === folder.uri.path || dir.path.length <= 1) break;
    dir = vscode.Uri.joinPath(dir, '..');
  }
  return parts.length ? parts.join('\n') : undefined;
}

async function workspaceCSharp(): Promise<{ uri: string; text: string }[]> {
  const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**,**/node_modules/**}', MAX_FILES);
  const out: { uri: string; text: string }[] = [];
  for (const f of files) {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === f.toString());
    if (open) out.push({ uri: f.toString(), text: open.getText() });
    else {
      try {
        out.push({ uri: f.toString(), text: new TextDecoder().decode(await vscode.workspace.fs.readFile(f)) });
      } catch {
        // unreadable: skipped
      }
    }
  }
  return out;
}

/**
 * Constructor and DI helpers in the lightbulb / Ctrl+.: create and initialise fields or properties from constructor
 * parameters, initialise fields from the constructor, generate a constructor, create an injected field for an
 * undeclared `_name`, register a type in the DI container. Cheap: a syntax pass over the current document; workspace
 * files are only read when an action runs (DI registration, call-site check).
 */
export class ConstructorActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [KIND, QUICKFIX];

  provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext): vscode.CodeAction[] {
    if (document.languageId !== 'csharp' || document.uri.scheme !== 'file') return [];
    if (context.only && !KIND.intersects(context.only) && !QUICKFIX.intersects(context.only)) return [];
    const text = document.getText();
    const offset = document.offsetAt(range.start);
    const c = findClass(text, offset);
    if (!c) return [];
    const style = namingStyle(c, undefined, text);
    const target: Target = { uri: document.uri.toString(), offset };
    const out: vscode.CodeAction[] = [];
    const action = (title: string, command: string, args: unknown, kind = KIND, preferred = false) => {
      const a = new vscode.CodeAction(title, kind);
      a.command = { command, title, arguments: [target, args] };
      if (preferred) a.isPreferred = true;
      out.push(a);
    };

    const at = parameterAt(c, offset);
    if (at?.primary && c.kind.startsWith('record')) return out; // positional record parameters are already properties
    if (at) {
      const field = style.prefix + at.param.name.replace(/^@/, '').replace(/^./, (x) => x.toLowerCase());
      const used = at.ctor ? !unassignedParameters(text, at.ctor).some((p) => p.name === at.param.name) : c.fields.some((f) => f.hasInitializer && new RegExp(`=\\s*${at.param.name}\\s*;`).test(text.slice(f.start, f.end)));
      if (!used) {
        const existing = unassignedMembers(c).find((u) => u.type === at.param.type);
        if (existing && !at.primary) action(`Initialize ${existing.kind} '${existing.name}'`, 'refyntra.ctor.introduce', { mode: { existing: existing.name } }, KIND, true);
        action(at.primary ? `Create field '${field}' from primary constructor parameter` : `Create and initialize field '${field}'`, 'refyntra.ctor.introduce', { mode: 'field' }, KIND, !existing);
        action(`Create and initialize property '${at.param.name.replace(/^@/, '').replace(/^./, (x) => x.toUpperCase())}'`, 'refyntra.ctor.introduce', { mode: 'property' });
      }
      if (at.ctor && unassignedParameters(text, at.ctor).length > 1) action('Initialize all unassigned parameters from constructor', 'refyntra.ctor.initializeAllParameters', {});
      if (!isFrameworkProvided(at.param.type)) action(`Register '${at.param.type}' in DI…`, 'refyntra.ctor.registerDi', { type: at.param.type, typeOffset: at.param.start });
      return out;
    }

    const f = fieldAt(c, offset);
    const unassigned = unassignedMembers(c);
    if (f) {
      if (unassigned.some((u) => u.name === f.name)) {
        action(`Initialize '${f.name}' from constructor`, 'refyntra.ctor.initializeMembers', { names: [f.name] }, QUICKFIX, true);
        if (unassigned.length > 1) action('Initialize all readonly fields from constructor', 'refyntra.ctor.initializeMembers', { names: unassigned.map((u) => u.name) }, QUICKFIX);
      }
      return out;
    }

    const missing = undeclaredFieldAt(text, c, offset);
    if (missing) {
      action(`Create field '${missing.name}' and inject via constructor`, 'refyntra.ctor.createInjectedField', { name: missing.name }, QUICKFIX, true);
      return out;
    }

    const onHeader = offset >= c.start && offset <= c.bodyOpen;
    if (onHeader && !c.isStatic) {
      if (constructorCandidates(c).length) action('Generate constructor…', 'refyntra.ctor.generate', {});
      if (c.ctors.length && unassigned.length) action('Add parameters to constructor…', 'refyntra.ctor.addParameters', {});
    }
    return out;
  }
}

class ConstructorCommands {
  constructor(
    private readonly engine: EngineClient,
    private readonly applier: VsCodeEditApplier,
  ) {}

  private async context(t: Target): Promise<{ doc: vscode.TextDocument; text: string; c: ClassInfo; style: ReturnType<typeof namingStyle> } | undefined> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(t.uri, true));
    const text = doc.getText();
    const c = findClass(text, t.offset);
    if (!c) {
      void vscode.window.showInformationMessage('Refyntra: place the cursor inside a class, struct or record.');
      return undefined;
    }
    return { doc, text, c, style: namingStyle(c, await editorConfigText(doc.uri), text) };
  }

  /** Current-document edits are applied directly (one undo step); the result is a normal editor change. */
  private async apply(doc: vscode.TextDocument, r: PlanResult): Promise<boolean> {
    if ('refused' in r) {
      void vscode.window.showInformationMessage(`Refyntra: ${r.refused}`);
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const e of r.edits) edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.offset), doc.positionAt(e.offset + e.length)), e.text);
    const ok = await this.applier.applyCodeActionEdit(edit);
    if (!ok) void vscode.window.showWarningMessage('Refyntra: the document changed; nothing was applied. Try again.');
    else if (r.note) void vscode.window.setStatusBarMessage(`Refyntra: ${r.note}`, 4000);
    return ok;
  }

  async introduce(t: Target, a: { mode: 'field' | 'property' | { existing: string } }): Promise<boolean> {
    const x = await this.context(t);
    if (!x) return false;
    const at = parameterAt(x.c, t.offset);
    if (!at) return false;
    return this.apply(x.doc, planIntroduce(x.text, x.c, at, x.style, a.mode));
  }

  async initializeAllParameters(t: Target): Promise<boolean> {
    const x = await this.context(t);
    const at = x && parameterAt(x.c, t.offset);
    if (!x || !at?.ctor) return false;
    return this.apply(x.doc, planInitializeAll(x.text, x.c, at.ctor, x.style));
  }

  private async pickCtor(c: ClassInfo, text: string): Promise<ClassInfo['ctors'][number] | undefined | null> {
    const usable = c.ctors.filter((k) => !/:\s*this\s*\(/.test(text.slice(k.paramsClose + 1, k.bodyOpen ?? k.end)));
    if (usable.length <= 1) return usable[0];
    const pick = await vscode.window.showQuickPick(usable.map((k) => ({ label: `${c.name}(${k.params.map((p) => `${p.type} ${p.name}`).join(', ')})`, k })), { title: 'Refyntra: Initialize from constructor', placeHolder: 'Choose the constructor to extend' });
    return pick ? pick.k : null;
  }

  /** Refuses when the class is constructed with `new` somewhere (those calls would need the new arguments). */
  private async callSitesBlock(c: ClassInfo): Promise<string | undefined> {
    const files = await workspaceCSharp();
    const sites = directConstructions(c.name, files);
    const targetTyped = files.some((f) => new RegExp(`\\b${c.name}\\s+\\w+\\s*=\\s*new\\s*\\(`).test(f.text));
    if (sites.length || targetTyped) return `'${c.name}' is created with 'new' in ${sites.length || 'some'} place(s); adding constructor parameters would break them. Change the signature with Refyntra: Change Signature (it updates call sites) or add the arguments yourself.`;
    return undefined;
  }

  async initializeMembers(t: Target, a: { names: string[] }): Promise<boolean> {
    const x = await this.context(t);
    if (!x) return false;
    const members = unassignedMembers(x.c).filter((u) => a.names.includes(u.name));
    return this.addMembers(x, members);
  }

  private async addMembers(x: NonNullable<Awaited<ReturnType<ConstructorCommands['context']>>>, members: Member[]): Promise<boolean> {
    if (x.c.ctors.length === 0) return this.apply(x.doc, planInitializeMembers(x.text, x.c, members, x.style));
    const block = await this.callSitesBlock(x.c);
    if (block) {
      void vscode.window.showInformationMessage(`Refyntra: ${block}`);
      return false;
    }
    const ctor = await this.pickCtor(x.c, x.text);
    if (ctor === null) return false;
    return this.apply(x.doc, planInitializeMembers(x.text, x.c, members, x.style, ctor));
  }

  async generate(t: Target): Promise<boolean> {
    const x = await this.context(t);
    if (!x) return false;
    const members = await this.pickMembers(x.c, 'Generate constructor');
    if (!members) return false;
    // Roslyn first (protocol 1.10): semantic types, usings, partial types, .editorconfig formatting, compile check.
    // The text-based plan remains for an older host or a file the host does not know.
    const viaHost = await applyGenerate(this.engine, this.applier, { uri: t.uri, position: toPosition(x.doc.positionAt(t.offset)) }, { kind: 'constructor', members: members.map((m) => m.name) }, ['NoType', 'UnknownMember', 'NotApplicable', 'NoDocument']);
    if (viaHost !== undefined) return viaHost;
    return this.apply(x.doc, planGenerateConstructor(x.text, x.c, members, x.style));
  }

  async addParameters(t: Target): Promise<boolean> {
    const x = await this.context(t);
    if (!x) return false;
    const members = await this.pickMembers(x.c, 'Add parameters to constructor', true);
    if (!members) return false;
    return this.addMembers(x, members);
  }

  private async pickMembers(c: ClassInfo, title: string, unassignedOnly = false): Promise<Member[] | undefined> {
    const unassigned = new Set(unassignedMembers(c).map((u) => u.name));
    const items = constructorCandidates(c)
      .filter((m) => !unassignedOnly || unassigned.has(m.name))
      .map((m) => ({ label: m.name, description: `${m.type} · ${m.kind}${unassigned.has(m.name) ? ' · not initialised' : ''}`, picked: m.preselect, m }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage(`Refyntra: '${c.name}' has no fields or properties a constructor can initialise.`);
      return undefined;
    }
    const picks = await vscode.window.showQuickPick(items, { title: `Refyntra: ${title}`, placeHolder: 'Fields and properties to initialise (Space toggles)', canPickMany: true });
    return picks?.length ? picks.map((p) => ({ name: p.m.name, type: p.m.type, kind: p.m.kind })) : undefined;
  }

  async createInjectedField(t: Target, a: { name: string }): Promise<boolean> {
    const x = await this.context(t);
    if (!x) return false;
    let type = inferFieldType(x.text, x.c, a.name);
    if (!type) type = await this.askType(a.name);
    if (!type) return false;
    if (x.c.ctors.length) {
      const block = await this.callSitesBlock(x.c);
      if (block) {
        void vscode.window.showInformationMessage(`Refyntra: ${block}`);
        return false;
      }
    }
    const ok = await this.apply(x.doc, planCreateInjectedField(x.text, x.c, a.name, type, x.style));
    if (ok && !isFrameworkProvided(type)) {
      const files = await workspaceCSharp();
      if (!isRegisteredByText(type, files)) {
        const yes = await vscode.window.showInformationMessage(`Refyntra: '${type}' is not registered in the DI container. Register it?`, 'Register…');
        if (yes) await this.registerDi(t, { type });
      }
    }
    return ok;
  }

  /** Type for a missing field: QuickPick of solution types (workspace symbols), interfaces first, or a typed name. */
  private async askType(field: string): Promise<string | undefined> {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
    qp.title = `Refyntra: type of '${field}'`;
    qp.placeholder = 'Type name (interfaces first); Enter accepts the typed text';
    const bare = field.replace(/^(m_|_)/, '');
    const load = async (query: string) => {
      const symbols = ((await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query || bare)) ?? []).filter((s) => s.location.uri.fsPath.endsWith('.cs') && [vscode.SymbolKind.Interface, vscode.SymbolKind.Class, vscode.SymbolKind.Struct].includes(s.kind));
      const names = rankTypeCandidates(bare, symbols.map((s) => ({ name: s.name, isInterface: s.kind === vscode.SymbolKind.Interface })));
      qp.items = names.slice(0, 50).map((n) => ({ label: n }));
    };
    await load('');
    return new Promise((resolve) => {
      let done = false;
      qp.onDidChangeValue((v) => void load(v));
      qp.onDidAccept(() => {
        done = true;
        const v = qp.selectedItems[0]?.label ?? qp.value.trim();
        qp.hide();
        resolve(/^[A-Za-z_][\w.<>, ?\[\]]*$/.test(v) ? v : undefined);
      });
      qp.onDidHide(() => {
        qp.dispose();
        if (!done) resolve(undefined);
      });
      qp.show();
    });
  }

  /** Registration: lifetime, interface → implementation pair, composition root; the edit goes through VS Code's refactor preview. */
  async registerDi(t: Target, a: { type: string; typeOffset?: number }): Promise<boolean> {
    const files = await workspaceCSharp();
    if (await this.isRegistered(t, a, files)) {
      void vscode.window.showInformationMessage(`Refyntra: '${a.type}' is already registered (see Refyntra Related → registrations).`);
      return false;
    }
    let service = a.type;
    let implementation: string | undefined;
    if (looksLikeInterface(a.type)) {
      const impls = implementationsOf(a.type, files);
      if (impls.length === 0) {
        void vscode.window.showInformationMessage(`Refyntra: no class implements '${a.type}' in the workspace, so there is nothing to register. Create the implementation first.`);
        return false;
      }
      implementation = impls.length === 1 ? impls[0] : (await vscode.window.showQuickPick(impls, { title: `Refyntra: implementation of ${a.type}`, placeHolder: 'Several classes implement it: choose the one to register' }));
      if (!implementation) return false;
    }
    const lifetime = (await vscode.window.showQuickPick(
      [
        { label: 'Scoped', description: 'one per request / scope (default for services using a DbContext)' },
        { label: 'Transient', description: 'a new instance every time' },
        { label: 'Singleton', description: 'one for the application (must be thread-safe, no scoped dependencies)' },
      ],
      { title: `Refyntra: register ${implementation ? `${service} → ${implementation}` : service}`, placeHolder: 'Lifetime' },
    ))?.label as Lifetime | undefined;
    if (!lifetime) return false;
    const targets = findRegistrationTargets(files);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage("Refyntra: no composition root was found (no 'builder.Services' in Program.cs, no 'this IServiceCollection' extension method). Nothing was changed; add the registration where your services are configured.");
      return false;
    }
    const target = targets.length === 1 ? targets[0]! : (await vscode.window.showQuickPick(targets.map((x) => ({ label: x.label, x })), { title: 'Refyntra: where to register', placeHolder: 'Several composition roots were found: choose one' }))?.x;
    if (!target) return false;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri, true));
    const e: Edit = registrationEdit(target, lifetime, service, implementation);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, doc.positionAt(e.offset), e.text, { label: `Register ${service} (${lifetime})`, needsConfirmation: true });
    return this.applier.applyCodeActionEdit(edit);
  }

  /** Our DI relations first (Related → registrations for the type at the parameter), text search as fallback. */
  private async isRegistered(t: Target, a: { type: string; typeOffset?: number }, files: { uri: string; text: string }[]): Promise<boolean> {
    if (a.typeOffset !== undefined) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(t.uri, true));
        const outcome = await this.engine.related({ uri: t.uri, position: toPosition(doc.positionAt(a.typeOffset)) });
        if (outcome.kind === 'related') {
          const regs = outcome.groups.find((g) => g.group === 'registrations')?.relations ?? [];
          if (regs.length > 0) return true;
          if (outcome.completeness === 'complete') return isRegisteredByText(a.type, files);
        }
      } catch {
        // fall back to text
      }
    }
    return isRegisteredByText(a.type, files);
  }
}

export function registerConstructorActions(engine: EngineClient, applier: VsCodeEditApplier): vscode.Disposable {
  const cmd = new ConstructorCommands(engine, applier);
  return vscode.Disposable.from(
    vscode.languages.registerCodeActionsProvider({ language: 'csharp', scheme: 'file' }, new ConstructorActionProvider(), { providedCodeActionKinds: ConstructorActionProvider.providedCodeActionKinds }),
    vscode.commands.registerCommand('refyntra.ctor.introduce', (t: Target, a: { mode: 'field' | 'property' | { existing: string } }) => cmd.introduce(t, a)),
    vscode.commands.registerCommand('refyntra.ctor.initializeAllParameters', (t: Target) => cmd.initializeAllParameters(t)),
    vscode.commands.registerCommand('refyntra.ctor.initializeMembers', (t: Target, a: { names: string[] }) => cmd.initializeMembers(t, a)),
    vscode.commands.registerCommand('refyntra.ctor.generate', (t?: Target) => cmd.generate(t ?? activeTarget())),
    vscode.commands.registerCommand('refyntra.ctor.addParameters', (t?: Target) => cmd.addParameters(t ?? activeTarget())),
    vscode.commands.registerCommand('refyntra.ctor.createInjectedField', (t: Target, a: { name: string }) => cmd.createInjectedField(t, a)),
    vscode.commands.registerCommand('refyntra.ctor.registerDi', (t: Target, a: { type: string; typeOffset?: number }) => cmd.registerDi(t, a)),
  );
}

function activeTarget(): Target {
  const ed = vscode.window.activeTextEditor;
  return ed ? { uri: ed.document.uri.toString(), offset: ed.document.offsetAt(ed.selection.active) } : { uri: '', offset: 0 };
}
