import { CSHARP_CAPABILITY_IDS } from '@refyntra/contracts';

// Capability ids → UI (title and editor command). Pure: unit-tested with vitest (no vscode import).

/** Titles for the catalogue (protocol-v1.md "Capability ids"). Unknown ids are shown by id: a new capability needs no UI change. */
export const CAPABILITY_TITLES: Readonly<Record<string, string>> = {
  'csharp.find': 'Find symbol or endpoint',
  'csharp.related': 'Show related (handlers, callers, endpoints, registrations)',
  'csharp.rename': 'Rename (preview first)',
  'csharp.references': 'Show references',
  'tests.run': 'Run test',
  // Delegated TS/JS route (public VS Code provider commands; results not owned by Refyntra).
  'typescript.find': 'Find TypeScript/JavaScript symbol (delegated)',
  'typescript.related': 'Show declarations and references (delegated)',
  'typescript.references': 'Show references (delegated)',
  'typescript.rename': 'Rename with preview (provider-managed semantic coverage)',
  'typescript.frameworkRelations': 'Framework relations (handlers, endpoints, registrations)',
};

/** Which command runs an available capability: matched on the capability's last segment. */
export function commandForCapability(capabilityId: string): string | undefined {
  const verb = capabilityId.split('.').pop();
  switch (verb) {
    case 'rename':
      return 'refyntra.rename';
    case 'related':
    case 'references':
      // References are a group of the Related view.
      return 'refyntra.related';
    case 'find':
    case 'search':
      return 'refyntra.find';
    default:
      return undefined;
  }
}

export function capabilityTitleOf(capabilityId: string): string {
  return CAPABILITY_TITLES[capabilityId] ?? capabilityId;
}

/** The C# route's capability ids (descriptor, synthesized "unavailable" entries, Actions). */
export const CSHARP_CAPABILITIES: readonly string[] = CSHARP_CAPABILITY_IDS;
