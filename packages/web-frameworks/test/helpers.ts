import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type * as TS from 'typescript';
import { WebAnalyzer } from '../src/worker/analyzer';
import type { RelatedResult, WorkerRelation } from '../src/protocol';

const require = createRequire(__filename);
export const ts = require('typescript') as typeof TS;
export const angularPlugin = require('@angular/language-service') as unknown;
export const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures');

export function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

export function uri(root: string, rel: string): string {
  return pathToFileURL(path.join(root, rel)).href;
}

export function analyzer(...roots: string[]): WebAnalyzer {
  const a = new WebAnalyzer({ ts, angularPlugin });
  a.initialize(roots.map((r) => pathToFileURL(r).href));
  return a;
}

/** Position of the n-th occurrence of `needle` (plus `delta` characters) in a fixture file. */
export function at(root: string, rel: string, needle: string, delta = 0, nth = 0): { uri: string; position: { line: number; character: number } } {
  const text = ts.sys.readFile(path.join(root, rel))!;
  let i = -1;
  for (let k = 0; k <= nth; k++) {
    i = text.indexOf(needle, i + 1);
    if (i < 0) throw new Error(`${needle} not found in ${rel}`);
  }
  const off = i + delta;
  const before = text.slice(0, off);
  const line = before.split('\n').length - 1;
  return { uri: uri(root, rel), position: { line, character: off - (before.lastIndexOf('\n') + 1) } };
}

export function related(a: WebAnalyzer, root: string, rel: string, needle: string, delta = 1, nth = 0): RelatedResult {
  return a.related({ ...at(root, rel, needle, delta, nth), documents: [] });
}

export const kinds = (r: RelatedResult, kind: string): WorkerRelation[] => r.relations.filter((x) => x.kind === kind);
export const labels = (r: RelatedResult, kind: string): string[] => kinds(r, kind).map((x) => x.label).sort();
