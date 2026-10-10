import * as vscode from 'vscode';
import type { EngineClient } from '@refyntra/application';
import type { Availability } from '@refyntra/contracts';
import { isRunnable } from '@refyntra/domain';
import { capabilityTitleOf, commandForCapability } from './capabilityUi';
import { toPosition } from './convert';
import { unavailableDescription, unavailableDetail } from './terminology';

export { commandForCapability } from './capabilityUi';

/**
 * Recovery actions come from the backend (untrusted): only Refyntra's own commands and the Workspace
 * Trust editor may be run from them.
 */
export function isAllowedRecoveryCommand(command: string): boolean {
  return command.startsWith('refyntra.') || command === 'workbench.trust.manage';
}

export async function runRecovery(action: { command: string; args?: unknown[] } | undefined): Promise<void> {
  if (!action) return;
  if (!isAllowedRecoveryCommand(action.command)) {
    void vscode.window.showWarningMessage(`Refyntra: ignored a recovery action with an unexpected command (${action.command}).`);
    return;
  }
  await vscode.commands.executeCommand(action.command, ...(action.args ?? []));
}

export function capabilityTitle(a: Availability): string {
  return capabilityTitleOf(a.capabilityId);
}

interface ActionPick extends vscode.QuickPickItem {
  availability?: Availability;
}

/** Actions QuickPick: available items first, then unavailable ones with their reason (runs recovery). */
export async function runActions(engine: EngineClient): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    void vscode.window.showInformationMessage('Refyntra Actions: open a C#, TypeScript or JavaScript file first.');
    return;
  }
  const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Refyntra: Actions', cancellable: true }, (_p, token) =>
    engine.actions({ uri: ed.document.uri.toString(), position: toPosition(ed.selection.active) }, token),
  );
  const items: ActionPick[] = [];
  const available = outcome.items.filter(isRunnable);
  const unavailable = outcome.items.filter((a) => !isRunnable(a));
  if (available.length) items.push({ label: 'Available', kind: vscode.QuickPickItemKind.Separator });
  for (const a of available) {
    items.push({
      label: `$(lightbulb) ${capabilityTitle(a)}`,
      description: a.state === 'limited' ? 'limited' : a.guarantee !== 'owned-semantic' ? a.guarantee : 'available',
      detail: a.limitations.length ? a.limitations.join('; ') : undefined,
      availability: a,
    });
  }
  if (unavailable.length) items.push({ label: 'Unavailable', kind: vscode.QuickPickItemKind.Separator });
  for (const a of unavailable) {
    items.push({
      label: `$(circle-slash) ${capabilityTitle(a)}`,
      description: unavailableDescription(a),
      detail: unavailableDetail(a, a.recoveryActions[0]?.title),
      availability: a,
    });
  }
  if (outcome.note) items.push({ label: `$(info) ${outcome.note}` });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Refyntra actions at the cursor', matchOnDescription: true });
  const a = pick?.availability;
  if (!a) return;
  if (isRunnable(a)) {
    const command = commandForCapability(a.capabilityId);
    if (command) await vscode.commands.executeCommand(command);
    else void vscode.window.showInformationMessage(`Refyntra: "${capabilityTitle(a)}" has no editor command in this version.`);
    return;
  }
  const recovery = a.recoveryActions[0];
  if (recovery) await runRecovery(recovery);
  else void vscode.window.showInformationMessage(`${capabilityTitle(a)}: ${unavailableDescription(a)}`);
}
