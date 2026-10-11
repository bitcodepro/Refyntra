import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type * as TS from 'typescript';
import type { WorkerLocation, WorkerRelation, WorkerSymbol } from '../protocol';
import { norm } from './tsHost';

export function uriOf(file: string): string {
  return pathToFileURL(file).href;
}

/** Canonical worker path: forward slashes, upper-case drive letter (VS Code URIs carry a lower-case one). */
export function canon(p: string): string {
  const n = norm(p);
  return /^[a-z]:\//.test(n) ? n[0]!.toUpperCase() + n.slice(1) : n;
}

export function pathOf(uri: string): string {
  return canon(fileURLToPath(uri));
}

/** Line/character of an offset in plain text (templates, files outside a program). */
export function positionInText(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

export function offsetInText(text: string, pos: { line: number; character: number }): number {
  let line = 0;
  let i = 0;
  while (line < pos.line && i < text.length) {
    if (text.charCodeAt(i) === 10) line++;
    i++;
  }
  return Math.min(text.length, i + pos.character);
}

export function textLocation(file: string, text: string, start: number, end: number): WorkerLocation {
  return { uri: uriOf(file), range: { start: positionInText(text, start), end: positionInText(text, end) } };
}

export function nodeLocation(sf: TS.SourceFile, node: TS.Node): WorkerLocation {
  const start = node.getStart(sf);
  return { uri: uriOf(sf.fileName), range: { start: sf.getLineAndCharacterOfPosition(start), end: sf.getLineAndCharacterOfPosition(node.getEnd()) } };
}

export function spanLocation(sf: TS.SourceFile, start: number, length: number): WorkerLocation {
  return { uri: uriOf(sf.fileName), range: { start: sf.getLineAndCharacterOfPosition(start), end: sf.getLineAndCharacterOfPosition(start + length) } };
}

export function fileStart(file: string): WorkerLocation {
  return { uri: uriOf(file), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
}

/** Innermost node whose span (without trivia) contains `offset` (end inclusive for identifiers at the cursor end). */
export function nodeAt(ts: typeof TS, sf: TS.SourceFile, offset: number): TS.Node {
  let found: TS.Node = sf;
  const visit = (n: TS.Node): void => {
    const start = n.getStart(sf);
    if (offset >= start && (offset < n.getEnd() || (offset === n.getEnd() && ts.isIdentifier(n)))) {
      found = n;
      n.forEachChild(visit);
    }
  };
  sf.forEachChild(visit);
  return found;
}

export function readText(file: string, maxChars = 2_000_000): string | undefined {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxChars * 2) return undefined;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

export function lineLabel(loc: WorkerLocation | undefined): string {
  if (!loc) return '';
  const p = pathOf(loc.uri);
  return `${baseName(p)}:${loc.range.start.line + 1}`;
}

export function symbolOf(name: string, kind: WorkerSymbol['kind'], location: WorkerLocation | undefined, containerName?: string): WorkerSymbol {
  return { name, kind, ...(location ? { location } : {}), ...(containerName ? { containerName } : {}) };
}

export function relation(r: Omit<WorkerRelation, 'evidence' | 'limitations'> & Partial<Pick<WorkerRelation, 'evidence' | 'limitations'>>): WorkerRelation {
  return { evidence: [], limitations: [], ...r };
}

/** The declaration name node of a declaration, when it has one. */
export function declName(ts: typeof TS, d: TS.Node): TS.Node | undefined {
  if ((ts.isFunctionDeclaration(d) || ts.isClassDeclaration(d) || ts.isVariableDeclaration(d) || ts.isPropertySignature(d) || ts.isPropertyDeclaration(d) || ts.isMethodDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d) || ts.isBindingElement(d) || ts.isParameter(d)) && d.name) return d.name;
  return undefined;
}

export function isInNodeModules(file: string): boolean {
  return /\/node_modules\//.test(norm(file));
}

export function stringValue(ts: typeof TS, e: TS.Expression | undefined): string | undefined {
  if (!e) return undefined;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  return undefined;
}

export function propertyNamed(ts: typeof TS, obj: TS.ObjectLiteralExpression, name: string): TS.PropertyAssignment | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p;
  }
  return undefined;
}

export function propertyName(ts: typeof TS, p: TS.Node): string | undefined {
  if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
  return undefined;
}
