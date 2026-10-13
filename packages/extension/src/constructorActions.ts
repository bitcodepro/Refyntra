import * as vscode from 'vscode';
import { CancelledError, type ConstructorActionsOutcome, type EngineClient } from '@refyntra/application';
import { CSHARP_REGISTER_DI_ACTION } from '@refyntra/contracts';
import { runCodePlan } from './codeRefactor';
import {
  ADD_PARAMETERS_ACTION,
  type CtorActionArgs,
  type CtorActionItem,
  type CtorTarget,
  INITIALIZE_ALL_ACTION,
  INITIALIZE_MEMBERS_ACTION,
  LIFETIME_ITEMS,
  REGISTER_DI_ACTION,
  answer,
  choiceItems,
  ctorActionSpecs,
  isTypeName,
  parseCtorArgs,
  registrationTitle,
  staleFiles,
} from './constructorModel';
import { toPosition } from './convert';
import type { VsCodeEditApplier } from './editApplier';
import { applyGenerate } from './generate';
import type { PreviewContentProvider } from './rename';
import { sha256 } from './textEdits';

const KIND = vscode.CodeActionKind.RefactorRewrite.append('refyntra').append('constructor');
const QUICKFIX = vscode.CodeActionKind.QuickFix.append('refyntra').append('constructor');
const CACHE_MS = 4000;
const MAX_QUESTIONS = 4;

/**
 * Constructor and DI helpers in the lightbulb / Ctrl+.: create and initialise fields or properties from constructor
 * parameters, initialise members from a constructor, generate a constructor, create an injected field for an undeclared
 * `_name`, register a type in the DI container. The C# host lists and computes them with Roslyn (protocol 1.11,
 * code/constructorActions): semantic types with usings, every part of a partial type, .editorconfig naming, compile
 * check. Single-document results are applied as one undo step while every document still has the text they were
 * computed for; the DI registration (another file) is a previewed plan.
 */
export class ConstructorActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [KIND, QUICKFIX];

  private cache: { key: string; at: number; items: CtorActionItem[] } | undefined;

  constructor(private readonly engine: EngineClient) {}

  async provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[]> {
    if (document.languageId !== 'csharp' || document.uri.scheme !== 'file' || !this.engine.constructorActions) return [];
    if (context.only && !KIND.intersects(context.only) && !QUICKFIX.intersects(context.only)) return [];
    if (!this.engine.handlesDocument(document.uri.toString(), document.languageId)) return [];
    const position = range.start;
    const key = `${document.uri.toString()}#${document.version}#${position.line}:${position.character}`;
    let items: CtorActionItem[];
    if (this.cache && this.cache.key === key && Date.now() - this.cache.at < CACHE_MS) items = this.cache.items;
    else {
      const source = new vscode.CancellationTokenSource();
      const sub = token.onCancellationRequested(() => source.cancel());
      try {
        const r = await this.engine.constructorActions({ uri: document.uri.toString(), position: toPosition(position) }, undefined, source.token);
        items = r.kind === 'actions' ? r.items : [];
        this.cache = { key, at: Date.now(), items };
      } catch {
        return [];
      } finally {
        sub.dispose();
        source.dispose();
      }
    }
    if (token.isCancellationRequested) return [];
    const target: CtorTarget = { uri: document.uri.toString(), offset: document.offsetAt(position) };
    return ctorActionSpecs(items)
      .filter((s) => !context.only || (s.kind === 'quickfix' ? QUICKFIX : KIND).intersects(context.only))
      .map((s) => {
        const a = new vscode.CodeAction(s.title, s.kind === 'quickfix' ? QUICKFIX : KIND);
        a.command = { command: s.command, title: s.title, arguments: [target, s.args] };
        if (s.preferred) a.isPreferred = true;
        return a;
      });
  }
}

class ConstructorCommands {
  constructor(
    private readonly engine: EngineClient,
    private readonly previews: PreviewContentProvider,
    private readonly applier: VsCodeEditApplier,
  ) {}

  private async position(t: CtorTarget): Promise<{ doc: vscode.TextDocument; position: { line: number; character: number } }> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(t.uri, true));
    return { doc, position: toPosition(doc.positionAt(t.offset)) };
  }

  /** Asks the host, answers its questions with pickers, applies the edits. True when applied. */
  async run(t: CtorTarget, args: CtorActionArgs, title: string): Promise<boolean> {
    if (!this.engine.constructorActions) {
      void vscode.window.showInformationMessage('Refyntra: the constructor actions need the C# host of this version; reload the window.');
      return false;
    }
    const { position } = await this.position(t);
    let request = args;
    for (let i = 0; i <= MAX_QUESTIONS; i++) {
      let r: ConstructorActionsOutcome;
      try {
        r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refyntra: computing the constructor change…' }, (_p, token) =>
          this.engine.constructorActions!({ uri: t.uri, position }, request, token),
        );
      } catch (e) {
        if (e instanceof CancelledError) return false;
        throw e;
      }
      if (r.kind === 'ask') {
        const picked = await this.ask(r.need, r.choices, r.message, title);
        if (!picked) return false;
        request = answer(request, r.need, picked);
        continue;
      }
      if (r.kind === 'unavailable') {
        void vscode.window.showInformationMessage(`Refyntra: ${r.message}`);
        return false;
      }
      if (r.kind !== 'edits') return false;
      const ok = await this.apply(r.files);
      if (ok && r.note) void vscode.window.setStatusBarMessage(`Refyntra: ${r.note}`, 4000);
      if (ok && r.registerTypeId) {
        // Not awaited: the field is created; registering is an offer the user may ignore.
        const typeId = r.registerTypeId;
        void vscode.window.showInformationMessage(`Refyntra: '${r.registerTypeName ?? 'the type'}' is not registered in the DI container. Register it?`, 'Register…').then((yes) => {
          if (yes) void this.registerDi(t, { actionId: REGISTER_DI_ACTION, typeId });
        });
      }
      return ok;
    }
    return false;
  }

  private async ask(need: 'members' | 'constructor' | 'type', choices: readonly { id: string; label: string; detail?: string | null; picked: boolean }[], message: string, title: string): Promise<string[] | undefined> {
    const items = choiceItems(choices);
    if (need === 'members') {
      const picks = await vscode.window.showQuickPick(items, { title: `Refyntra: ${title}`, placeHolder: `${message} (Space toggles)`, canPickMany: true });
      return picks?.length ? picks.map((p) => p.id) : undefined;
    }
    if (need === 'constructor') {
      const pick = await vscode.window.showQuickPick(items, { title: `Refyntra: ${title}`, placeHolder: message });
      return pick ? [pick.id] : undefined;
    }
    // A type: a choice, or a typed name (the host resolves it and adds the using).
    const qp = vscode.window.createQuickPick<(typeof items)[number]>();
    qp.title = `Refyntra: ${title}`;
    qp.placeholder = `${message}; Enter accepts a typed type name`;
    qp.items = items;
    return new Promise((resolve) => {
      let done = false;
      qp.onDidAccept(() => {
        done = true;
        const chosen = qp.selectedItems[0];
        const typed = qp.value.trim();
        qp.hide();
        if (chosen) resolve([chosen.id]);
        else resolve(isTypeName(typed) ? [typed] : undefined);
      });
      qp.onDidHide(() => {
        qp.dispose();
        if (!done) resolve(undefined);
      });
      qp.show();
    });
  }

  /** All files in one WorkspaceEdit (one undo step per file), only while each file has the text the host saw. */
  private async apply(files: readonly { uri: string; documentHash: string; edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[] }[]): Promise<boolean> {
    const docs = new Map<string, vscode.TextDocument>();
    for (const f of files) docs.set(f.uri, await vscode.workspace.openTextDocument(vscode.Uri.parse(f.uri, true)));
    const stale = staleFiles(files, (uri) => {
      const d = docs.get(uri);
      return d ? sha256(d.getText()) : undefined;
    });
    if (stale.length) {
      void vscode.window.showWarningMessage('Refyntra: the document changed; nothing was applied. Try again.');
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const f of files) {
      const doc = docs.get(f.uri)!;
      for (const e of f.edits) edit.replace(doc.uri, new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character), e.newText);
    }
    const ok = await this.applier.applyCodeActionEdit(edit);
    if (!ok) void vscode.window.showWarningMessage('Refyntra: the document changed; nothing was applied. Try again.');
    return ok;
  }

  async generate(t: CtorTarget): Promise<boolean> {
    // Generate constructor: the member picker of the constructor actions (unassigned readonly members preselected),
    // then Generate's constructor kind (code/generate, protocol 1.10) computes the new constructor.
    if (!this.engine.constructorActions || !this.engine.generate) return false;
    const { position } = await this.position(t);
    const asked = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refyntra: Generate constructor…' }, (_p, token) =>
      this.engine.constructorActions!({ uri: t.uri, position }, { actionId: INITIALIZE_MEMBERS_ACTION }, token),
    );
    if (asked.kind !== 'ask' || asked.need !== 'members') {
      void vscode.window.showInformationMessage(`Refyntra: ${asked.kind === 'unavailable' ? asked.message : 'this type has no fields or properties a constructor can initialise.'}`);
      return false;
    }
    const picks = await this.ask('members', asked.choices, asked.message, 'Generate constructor');
    if (!picks) return false;
    return (await applyGenerate(this.engine, this.applier, { uri: t.uri, position }, { kind: 'constructor', members: picks })) === true;
  }

  /** Register in DI: the host's implementations and composition roots, then a previewed plan. */
  async registerDi(t: CtorTarget, args: CtorActionArgs): Promise<boolean> {
    if (!this.engine.constructorActions) return false;
    const { position } = await this.position(t);
    const d = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refyntra: finding composition roots…' }, (_p, token) =>
      this.engine.constructorActions!({ uri: t.uri, position }, { actionId: REGISTER_DI_ACTION, ...(args.typeId ? { typeId: args.typeId } : {}) }, token),
    );
    if (d.kind !== 'registration') {
      void vscode.window.showInformationMessage(`Refyntra: ${d.kind === 'unavailable' ? d.message : 'nothing to register here.'}`);
      return false;
    }
    const info = d.info;
    const service = info.service ?? 'the service';
    let implementation = info.implementations[0];
    if (info.implementations.length > 1) {
      const pick = await vscode.window.showQuickPick(choiceItems(info.implementations), { title: `Refyntra: implementation of ${service}`, placeHolder: 'Several classes implement it: choose the one to register' });
      if (!pick) return false;
      implementation = info.implementations.find((x) => x.id === pick.id);
    }
    const lifetime = (await vscode.window.showQuickPick([...LIFETIME_ITEMS], { title: `Refyntra: register ${implementation && implementation.label !== service ? `${service} → ${implementation.label}` : service}`, placeHolder: 'Lifetime' }))?.label;
    if (!lifetime) return false;
    let root = info.roots[0];
    if (info.roots.length > 1) {
      const pick = await vscode.window.showQuickPick(choiceItems(info.roots), { title: 'Refyntra: where to register', placeHolder: 'Several composition roots were found: choose one' });
      if (!pick) return false;
      root = info.roots.find((x) => x.id === pick.id);
    }
    const registration = {
      lifetime,
      ...(args.typeId ? { typeId: args.typeId } : {}),
      ...(implementation ? { implementationId: implementation.id } : {}),
      ...(root ? { rootId: root.id } : {}),
    };
    const title = registrationTitle(service, implementation?.label, lifetime);
    await runCodePlan(this.engine, this.previews, this.applier, title, (token) => this.engine.prepareAction({ uri: t.uri, position }, CSHARP_REGISTER_DI_ACTION, token, { range: { start: position, end: position }, registration }), () => this.registerDi(t, args).then(() => undefined));
    return true;
  }
}

export function registerConstructorActions(engine: EngineClient, previews: PreviewContentProvider, applier: VsCodeEditApplier): vscode.Disposable {
  const cmd = new ConstructorCommands(engine, previews, applier);
  const run = (fallback: string, title: string) => (t?: CtorTarget, a?: unknown) => cmd.run(t ?? activeTarget(), parseCtorArgs(a, fallback), title);
  return vscode.Disposable.from(
    vscode.languages.registerCodeActionsProvider({ language: 'csharp', scheme: 'file' }, new ConstructorActionProvider(engine), { providedCodeActionKinds: ConstructorActionProvider.providedCodeActionKinds }),
    vscode.commands.registerCommand('refyntra.ctor.introduce', run('csharp.ctor.introduceField', 'Create and initialize field')),
    vscode.commands.registerCommand('refyntra.ctor.initializeAllParameters', run(INITIALIZE_ALL_ACTION, 'Initialize all parameters')),
    vscode.commands.registerCommand('refyntra.ctor.initializeMembers', run(INITIALIZE_MEMBERS_ACTION, 'Initialize from constructor')),
    vscode.commands.registerCommand('refyntra.ctor.generate', (t?: CtorTarget) => cmd.generate(t ?? activeTarget())),
    vscode.commands.registerCommand('refyntra.ctor.addParameters', run(ADD_PARAMETERS_ACTION, 'Add parameters to constructor')),
    vscode.commands.registerCommand('refyntra.ctor.createInjectedField', run('csharp.ctor.createInjectedField', 'Create field and inject via constructor')),
    vscode.commands.registerCommand('refyntra.ctor.registerDi', (t?: CtorTarget, a?: unknown) => cmd.registerDi(t ?? activeTarget(), parseCtorArgs(a, REGISTER_DI_ACTION))),
  );
}

function activeTarget(): CtorTarget {
  const ed = vscode.window.activeTextEditor;
  return ed ? { uri: ed.document.uri.toString(), offset: ed.document.offsetAt(ed.selection.active) } : { uri: '', offset: 0 };
}

