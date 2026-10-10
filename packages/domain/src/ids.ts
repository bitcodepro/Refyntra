/** Deterministic id factories. No randomness or IO: callers inject uniqueness (e.g. a session prefix). */
export interface IdFactory {
  next(): string;
}

export function createIdFactory(prefix: string): IdFactory {
  let counter = 0;
  return {
    next(): string {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
}

/** Identity of a language route (adapter) inside one workspace. */
export type ProviderRouteId = string;
export type AdapterId = string;
