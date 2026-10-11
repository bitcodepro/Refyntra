// Version policy of the web frameworks module (pure). See docs/adr/ADR-007-web-worker.md.

/** TypeScript bundled with Refyntra for the web worker (exact pin; the Angular language service needs this major.minor). */
export const BUNDLED_TYPESCRIPT_VERSION = '6.0.3';
/** @angular/language-service bundled with Refyntra (exact pin). */
export const BUNDLED_ANGULAR_LS_VERSION = '22.2.1';

/**
 * Angular majors the bundled language service understands: its compiler gates template features by the project's
 * @angular/core version from 17.0 on and is released for 22. Older majors (View Engine era, pre-control-flow) and
 * newer majors are refused with a reason instead of giving wrong answers.
 */
export const ANGULAR_SUPPORTED_MAJORS = { min: 17, max: 22 } as const;
/** Majors exercised by Refyntra's own fixtures (the others in the window rely on the language service's gates). */
export const ANGULAR_VERIFIED_MAJORS: readonly number[] = [22];

/** React: function components and hooks need 16.8+; detection only needs a react dependency. */
export const REACT_MIN_MAJOR = 16;

/** Next.js conventions and the first major that has them. */
export const NEXT_CONVENTIONS = {
  pagesRouter: 9,
  appRouter: 13,
  routeHandlers: 13,
  parallelAndInterceptingRoutes: 13,
} as const;

/** Major of a version or a range ("^22.1.0", "~12.2.0", ">=13", "22.2.1"); undefined for "latest", "*", tags, URLs. */
export function majorOf(versionOrRange: string): number | undefined {
  const v = versionOrRange.trim();
  if (/^(workspace:|npm:|file:|link:|git|https?:|github:)/i.test(v)) {
    const inner = /^workspace:(.*)$/.exec(v)?.[1];
    return inner ? majorOf(inner) : undefined;
  }
  const m = /^(?:[\^~]|>=?|=)?\s*v?(\d+)(?:\.|$|\s|-|x)/.exec(v);
  return m ? Number(m[1]) : undefined;
}

export function angularSupport(major: number | undefined): { supported: boolean; reason?: string } {
  if (major === undefined) return { supported: false, reason: 'The @angular/core version could not be read (no node_modules/@angular/core and no version range in package.json).' };
  const { min, max } = ANGULAR_SUPPORTED_MAJORS;
  if (major < min) return { supported: false, reason: `Angular ${major} is older than the versions the bundled Angular language service ${BUNDLED_ANGULAR_LS_VERSION} understands (${min}–${max}). Angular template relations are not shown for this project.` };
  if (major > max) return { supported: false, reason: `Angular ${major} is newer than the bundled Angular language service ${BUNDLED_ANGULAR_LS_VERSION} (${min}–${max}). Update Refyntra for Angular ${major} support.` };
  return { supported: true };
}
