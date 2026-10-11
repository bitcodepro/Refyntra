import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FrameworkVersion, WebProjectInfo } from '../protocol';
import { angularSupport, majorOf } from '../versions';

// Workspace scan (Node side: worker and the extension-side detection). Reads package.json files and lists source
// files; never runs anything, never follows symbolic links, bounded by entry counts.

export const SKIPPED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build', '.next', '.angular', '.nuxt', 'coverage', 'bin', 'obj', '.cache', '.turbo', '.vscode-test', 'TestResults']);
export const SOURCE_FILE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/i;
export const TEMPLATE_FILE = /\.html?$/i;

export interface ScannedProject {
  dir: string;
  info: WebProjectInfo;
}

export interface ScanResult {
  projects: ScannedProject[];
  /** Source and template files under web projects (absolute paths). */
  files: string[];
  truncated: boolean;
}

export interface ScanLimits {
  maxEntries: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: ScanLimits = { maxEntries: 50_000, maxDepth: 12 };

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length > 2_000_000) return undefined;
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Version of a dependency: node_modules/<name>/package.json (walking up), else the range declared in package.json. */
export function dependencyVersion(dir: string, pkg: Record<string, unknown>, name: string): FrameworkVersion | undefined {
  const declared = ['dependencies', 'devDependencies', 'peerDependencies']
    .map((k) => (pkg[k] && typeof pkg[k] === 'object' ? (pkg[k] as Record<string, unknown>)[name] : undefined))
    .find((v): v is string => typeof v === 'string');
  if (declared === undefined) return undefined;
  let d = dir;
  for (let i = 0; i < 6; i++) {
    const installed = readJson(path.join(d, 'node_modules', ...name.split('/'), 'package.json'));
    if (installed && typeof installed.version === 'string') {
      const major = majorOf(installed.version);
      return { version: installed.version, ...(major !== undefined ? { major } : {}), source: 'installed' };
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const major = majorOf(declared);
  return { version: declared, ...(major !== undefined ? { major } : {}), source: 'declared' };
}

export function projectInfo(dir: string): WebProjectInfo | undefined {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg) return undefined;
  const react = dependencyVersion(dir, pkg, 'react');
  const next = dependencyVersion(dir, pkg, 'next');
  const angular = dependencyVersion(dir, pkg, '@angular/core');
  if (!react && !next && !angular) return undefined;
  return {
    rootUri: pathToFileURL(dir).href,
    ...(react ? { react } : {}),
    ...(next ? { next } : {}),
    ...(angular ? { angular: { ...angular, ...angularSupport(angular.major) } } : {}),
  };
}

/** Finds web projects (package.json with react, next or @angular/core) and their source/template files. */
export function scanWorkspace(roots: readonly string[], limits: ScanLimits = DEFAULT_LIMITS): ScanResult {
  const projects: ScannedProject[] = [];
  const files: string[] = [];
  let entries = 0;
  let truncated = false;
  const walk = (dir: string, depth: number, inProject: boolean) => {
    if (truncated) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let here = inProject;
    if (list.some((e) => e.isFile() && e.name === 'package.json')) {
      const info = projectInfo(dir);
      if (info) {
        projects.push({ dir, info });
        here = true;
      }
    }
    for (const e of list) {
      if (++entries > limits.maxEntries) {
        truncated = true;
        return;
      }
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIPPED_DIRS.has(e.name) || depth >= limits.maxDepth) continue;
        walk(p, depth + 1, here);
      } else if (here && e.isFile() && (SOURCE_FILE.test(e.name) || TEMPLATE_FILE.test(e.name)) && !e.name.endsWith('.d.ts')) {
        files.push(p);
      }
    }
  };
  for (const r of roots) walk(r, 0, false);
  return { projects, files, truncated };
}

/** Cheap check for the extension host: does any folder (bounded walk) contain a React, Next.js or Angular project? */
export function hasWebProject(roots: readonly string[]): boolean {
  let found = false;
  let entries = 0;
  const walk = (dir: string, depth: number) => {
    if (found || entries > 20_000) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (list.some((e) => e.isFile() && e.name === 'package.json') && projectInfo(dir)) {
      found = true;
      return;
    }
    for (const e of list) {
      entries++;
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIPPED_DIRS.has(e.name) && depth < 8) walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return found;
}
