import type { Availability, AvailabilityState, RecoveryAction } from '@refyntra/contracts';
import { compareStrings } from './location';

export const RECOVERY_SHOW_HEALTH: RecoveryAction = { command: 'refyntra.showHealth', title: 'Show Refyntra health' };
export const RECOVERY_MANAGE_TRUST: RecoveryAction = { command: 'workbench.trust.manage', title: 'Manage Workspace Trust' };
export const RECOVERY_RESTART: RecoveryAction = { command: 'refyntra.restartBackend', title: 'Restart Refyntra backend' };
export const RECOVERY_SELECT_SOLUTION: RecoveryAction = { command: 'refyntra.selectSolution', title: 'Select solution' };

const STATE_ORDER: Record<AvailabilityState, number> = { available: 0, limited: 1, unknown: 2, unavailable: 3 };

export function isRunnable(a: Availability): boolean {
  return a.state === 'available' || a.state === 'limited';
}

/** Available first, then limited, unknown, unavailable; ties by capability then route. */
export function compareAvailability(a: Availability, b: Availability): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state] || compareStrings(a.capabilityId, b.capabilityId) || compareStrings(a.providerRouteId, b.providerRouteId);
}

export function sortAvailability(list: readonly Availability[]): Availability[] {
  return [...list].sort(compareAvailability);
}

export interface UnavailableInit {
  capabilityId: string;
  providerRouteId: string;
  workspaceId: string;
  reasonCode: string;
  message: string;
  recoveryActions?: RecoveryAction[];
  documentUri?: string;
  requiredTrust?: 'none' | 'workspace';
}

export function unavailable(init: UnavailableInit): Availability {
  return {
    capabilityId: init.capabilityId,
    providerRouteId: init.providerRouteId,
    scope: { workspaceId: init.workspaceId, ...(init.documentUri ? { documentUri: init.documentUri } : {}) },
    state: 'unavailable',
    reasonCode: init.reasonCode,
    message: init.message,
    recoveryActions: init.recoveryActions ?? [],
    requiredTrust: init.requiredTrust ?? 'workspace',
    guarantee: 'owned-semantic',
    limitations: [],
  };
}

/** Backend output is untrusted: drop availability entries without the minimal shape. */
export function isWellFormedAvailability(value: unknown): value is Availability {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Availability>;
  return (
    typeof v.capabilityId === 'string' &&
    typeof v.providerRouteId === 'string' &&
    typeof v.state === 'string' &&
    Object.prototype.hasOwnProperty.call(STATE_ORDER, v.state) &&
    Array.isArray(v.recoveryActions ?? [])
  );
}
