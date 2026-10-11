// Generates THIRD_PARTY_NOTICES.md, packages/extension/legal/** and dist/<name>-<version>.sbom.json (CycloneDX 1.5)
// from what the VSIX actually ships:
//   - npm: the packages esbuild bundled into extension/dist/extension.js (packages/extension/dist/extension.meta.json),
//   - NuGet: every DLL in extension/host mapped to its package through src/dotnet/Refyntra.Host/obj/project.assets.json.
// Usage: pnpm notices [--vsix <path>]   (builds the VSIX first when it is missing). Fetches nothing from the network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { repo, extPkg, ensureVsix, extractVsix, walk, rel } from './lib.mjs';
import { LICENSES_DIR, RA } from './servers.mjs';

const manual = []; // things needing manual legal review
const flag = (msg) => { manual.push(msg); console.warn(`MANUAL REVIEW: ${msg}`); };
const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? xmlDecode(m[1].trim()) : undefined; };

const vsix = ensureVsix();
const tmp = extractVsix(vsix);
try {
  const ext = path.join(tmp, 'extension');
  const hostDir = path.join(ext, 'host');
  const components = []; // {ecosystem,name,version,license,copyright,files,hash,deps,review}

  // ---------- npm (bundled into extension.js) ----------
  const metaFile = path.join(repo, 'packages', 'extension', 'dist', 'extension.meta.json');
  if (!fs.existsSync(metaFile)) throw new Error('packages/extension/dist/extension.meta.json is missing; run pnpm package:vsix (the esbuild build writes it)');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const out = Object.entries(meta.outputs).find(([k]) => k.endsWith('dist/extension.js'));
  const shippedJs = path.join(ext, 'dist', 'extension.js');
  if (!out || !fs.existsSync(shippedJs)) throw new Error('extension.js missing from the VSIX or the metafile');
  if (out[1].bytes !== fs.statSync(shippedJs).size) {
    throw new Error(`extension.meta.json (${out[1].bytes} bytes) does not describe the shipped extension.js (${fs.statSync(shippedJs).size} bytes); rebuild with pnpm package:vsix`);
  }
  const npmDirs = new Map();
  const npmLicenseSources = []; // {name, version, dir}: upstream license texts of the bundled npm packages
  for (const input of Object.keys(out[1].inputs)) {
    const p = input.split('\\').join('/');
    const i = p.lastIndexOf('node_modules/');
    if (i < 0) continue;
    const m = /^((?:@[^/]+\/)?[^/]+)\//.exec(p.slice(i + 'node_modules/'.length));
    if (!m) continue;
    npmDirs.set(m[1], path.resolve(repo, 'packages', 'extension', p.slice(0, i), 'node_modules', m[1]));
  }
  for (const [name, dir] of npmDirs) {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const lic = typeof pj.license === 'string' ? pj.license : pj.license?.type ?? (pj.licenses ? pj.licenses.map((l) => l.type).join(' OR ') : undefined);
    const c = { ecosystem: 'npm', name, version: pj.version, license: lic ?? 'UNKNOWN', copyright: typeof pj.author === 'string' ? pj.author : pj.author?.name, files: ['dist/extension.js (bundled)'] };
    if (!lic) { c.review = 'no license field in package.json'; flag(`npm ${name}@${pj.version}: no license field`); }
    npmLicenseSources.push({ name, version: pj.version, dir });
    components.push(c);
  }

  // ---------- NuGet (DLLs in extension/host) ----------
  const assets = JSON.parse(fs.readFileSync(path.join(repo, 'src', 'dotnet', 'Refyntra.Host', 'obj', 'project.assets.json'), 'utf8'));
  const folder = Object.keys(assets.packageFolders).find((f) => fs.existsSync(f));
  const depsJson = JSON.parse(fs.readFileSync(path.join(hostDir, 'Refyntra.Host.deps.json'), 'utf8'));
  const depsPackages = new Map(Object.keys(depsJson.libraries).map((k) => k.split('/')).map(([n, v]) => [n.toLowerCase(), v]));
  const byBase = new Map(); // dll basename (lower) -> Set(libraryKey)
  for (const [key, lib] of Object.entries(assets.libraries)) {
    if (lib.type !== 'package') continue;
    for (const f of lib.files ?? []) {
      if (!/\.(dll|exe)$/i.test(f)) continue;
      const b = path.posix.basename(f).toLowerCase();
      if (!byBase.has(b)) byBase.set(b, new Set());
      byBase.get(b).add(key);
    }
  }
  const pkgFiles = new Map(); // libraryKey -> shipped files
  const firstParty = [];
  const unmapped = [];
  for (const file of walk(hostDir)) {
    const r = rel(hostDir, file);
    if (!/\.(dll|exe)$/i.test(r)) continue;
    const base = path.posix.basename(r).toLowerCase();
    if (base.startsWith('refyntra.')) { firstParty.push(r); continue; }
    const keys = [...(byBase.get(base) ?? [])];
    const key = keys.find((k) => depsPackages.get(k.split('/')[0].toLowerCase()) === k.split('/')[1]) ?? keys[0];
    if (!key) { unmapped.push(r); continue; }
    if (!pkgFiles.has(key)) pkgFiles.set(key, []);
    pkgFiles.get(key).push(r);
  }
  for (const u of unmapped) flag(`host/${u}: no NuGet package owns this binary (not in project.assets.json)`);

  const legalDir = path.join(repo, 'packages', 'extension', 'legal');
  fs.rmSync(legalDir, { recursive: true, force: true });
  const noticeByHash = new Map(); // sha256 -> {ext, buf, owners}
  const target = assets.targets[Object.keys(assets.targets)[0]];
  for (const [key, files] of [...pkgFiles].sort(([a], [b]) => a.localeCompare(b))) {
    const lib = assets.libraries[key];
    const [name, version] = key.split('/');
    const pdir = path.join(folder, lib.path);
    const nuspecName = fs.readdirSync(pdir).find((f) => f.endsWith('.nuspec'));
    const nuspec = fs.readFileSync(path.join(pdir, nuspecName), 'utf8');
    const licTag = /<license\s+type="(\w+)"[^>]*>([\s\S]*?)<\/license>/i.exec(nuspec);
    const licenseUrl = tag(nuspec, 'licenseUrl');
    const c = { ecosystem: 'nuget', name, version, copyright: tag(nuspec, 'copyright'), authors: tag(nuspec, 'authors'), files, hash: lib.sha512, deps: Object.keys(target[key]?.dependencies ?? {}) };
    if (licTag && licTag[1] === 'expression') c.license = xmlDecode(licTag[2].trim());
    else if (licTag && licTag[1] === 'file') {
      c.license = `SEE LICENSE FILE (${licTag[2].trim()})`; c.review = 'license is a file inside the package';
      flag(`NuGet ${name}@${version}: license is the file ${licTag[2].trim()}`);
    } else {
      c.license = 'UNKNOWN'; c.licenseUrl = licenseUrl; c.review = 'only a license URL is declared';
      flag(`NuGet ${name}@${version}: only licenseUrl ${licenseUrl ?? '(none)'}`);
    }
    // Notice files that ship inside the package (third-party attributions of the package itself).
    for (const f of fs.readdirSync(pdir)) {
      if (!/^(notice|third[-_ ]?party[-_ ]?notices?)(\.[a-z]+)?$/i.test(f) || !fs.statSync(path.join(pdir, f)).isFile()) continue;
      const buf = fs.readFileSync(path.join(pdir, f));
      const h = crypto.createHash('sha256').update(buf).digest('hex');
      if (!noticeByHash.has(h)) noticeByHash.set(h, { ext: path.extname(f) || '.txt', buf, owners: [] });
      noticeByHash.get(h).owners.push(name);
    }
    components.push(c);
  }
  // Write the deduplicated upstream notices into the VSIX payload folder (packages/extension/legal).
  const noticeFiles = new Map(); // hash -> {rel, owners}
  if (noticeByHash.size) fs.mkdirSync(legalDir, { recursive: true });
  for (const [h, n] of [...noticeByHash].sort(([, a], [, b]) => a.owners[0].localeCompare(b.owners[0]))) {
    const rp = `${n.owners[0].replace(/[^\w.-]/g, '_')}-notices${n.ext.toLowerCase()}`;
    fs.writeFileSync(path.join(legalDir, rp), n.buf);
    noticeFiles.set(h, { rel: `legal/${rp}`, owners: n.owners });
  }

  // ---------- bundled language servers (extension/servers) ----------
  const serverLicenses = []; // {rel, what}
  const copyLicense = (from, name, what) => {
    fs.mkdirSync(legalDir, { recursive: true });
    fs.copyFileSync(from, path.join(legalDir, name));
    serverLicenses.push({ rel: `legal/${name}`, what });
  };
  const pyDir = path.join(ext, 'servers', 'pyright');
  if (fs.existsSync(path.join(pyDir, 'package.json'))) {
    const pj = JSON.parse(fs.readFileSync(path.join(pyDir, 'package.json'), 'utf8'));
    const pyFiles = walk(pyDir).map((f) => `servers/pyright/${rel(pyDir, f)}`);
    components.push({ ecosystem: 'npm', name: 'pyright', version: pj.version, license: pj.license, copyright: 'Copyright (c) Microsoft Corporation', files: pyFiles.filter((f) => !f.includes('/typeshed-fallback/')) });
    copyLicense(path.join(pyDir, 'LICENSE.txt'), 'pyright-LICENSE.txt', `Pyright ${pj.version} (MIT)`);
    const commit = fs.readFileSync(path.join(pyDir, 'dist', 'typeshed-fallback', 'commit.txt'), 'utf8').trim();
    components.push({ ecosystem: 'generic', name: 'typeshed (stdlib stubs, bundled with Pyright)', version: commit.slice(0, 12), license: 'Apache-2.0 AND MIT', copyright: 'typeshed contributors', files: pyFiles.filter((f) => f.includes('/typeshed-fallback/')) });
    copyLicense(path.join(pyDir, 'dist', 'typeshed-fallback', 'LICENSE'), 'typeshed-LICENSE.txt', 'typeshed (Apache-2.0; parts MIT, as stated in the file)');
  }
  const raDir = path.join(ext, 'servers', 'rust-analyzer');
  if (fs.existsSync(raDir)) {
    // Target-independent wording: every platform package ships the same notices file.
    const raFiles = ['servers/rust-analyzer/rust-analyzer(.exe) (the binary of the package platform)', 'servers/rust-analyzer/LICENSE-MIT.txt', 'servers/rust-analyzer/LICENSE-APACHE.txt', 'servers/rust-analyzer/VERSION.txt'];
    components.push({ ecosystem: 'generic', name: 'rust-analyzer', version: RA.version, license: 'MIT OR Apache-2.0', copyright: 'The rust-analyzer developers', files: raFiles, review: undefined });
    copyLicense(path.join(LICENSES_DIR, 'rust-analyzer-LICENSE-MIT.txt'), 'rust-analyzer-LICENSE-MIT.txt', `rust-analyzer ${RA.version} (MIT)`);
    copyLicense(path.join(LICENSES_DIR, 'rust-analyzer-LICENSE-APACHE.txt'), 'rust-analyzer-LICENSE-APACHE.txt', `rust-analyzer ${RA.version} (Apache-2.0)`);
  }

  // Web worker runtime (React / Next.js / Angular, ADR-007): pinned TypeScript and Angular language service.
  const tsDir = path.join(ext, 'servers', 'typescript');
  if (fs.existsSync(path.join(tsDir, 'package.json'))) {
    const pj = JSON.parse(fs.readFileSync(path.join(tsDir, 'package.json'), 'utf8'));
    components.push({ ecosystem: 'npm', name: 'typescript', version: pj.version, license: 'Apache-2.0', copyright: 'Copyright (c) Microsoft Corporation', files: walk(tsDir).map((f) => `servers/typescript/${rel(tsDir, f)}`), licenseShipped: true });
    copyLicense(path.join(tsDir, 'LICENSE.txt'), 'typescript-LICENSE.txt', `TypeScript ${pj.version} (Apache-2.0)`);
    copyLicense(path.join(tsDir, 'ThirdPartyNoticeText.txt'), 'typescript-ThirdPartyNoticeText.txt', `TypeScript ${pj.version} third-party notices`);
  }
  const ngDir = path.join(ext, 'servers', 'angular-language-service');
  if (fs.existsSync(path.join(ngDir, 'package.json'))) {
    const pj = JSON.parse(fs.readFileSync(path.join(ngDir, 'package.json'), 'utf8'));
    components.push({ ecosystem: 'npm', name: '@angular/language-service', version: pj.version, license: pj.license, copyright: 'Copyright (c) Google LLC', files: walk(ngDir).map((f) => `servers/angular-language-service/${rel(ngDir, f)}`) });
    copyLicense(path.join(ngDir, 'LICENSE.txt'), 'angular-language-service-LICENSE.txt', `@angular/language-service ${pj.version} (MIT)`);
  }

  // Upstream license texts of the npm packages bundled into extension.js (legal/npm-<name>-LICENSE.txt).
  const npmLicenses = [];
  for (const { name, version, dir } of npmLicenseSources) {
    const f = fs.readdirSync(dir).find((x) => /^licen[sc]e(\.(md|txt))?$/i.test(x));
    if (!f) { flag(`npm ${name}@${version}: no LICENSE file in the package`); continue; }
    const out = `npm-${name.replace(/[^\w.-]/g, '_')}-LICENSE.txt`;
    fs.mkdirSync(legalDir, { recursive: true });
    fs.copyFileSync(path.join(dir, f), path.join(legalDir, out));
    npmLicenses.push({ rel: `legal/${out}`, what: `${name} ${version}` });
  }

  // ---------- reporting ----------
  components.sort((a, b) => (a.ecosystem + a.name).localeCompare(b.ecosystem + b.name));
  const mitCopyrights = [...new Set(components.filter((c) => /^MIT$/i.test(c.license) && c.copyright).map((c) => c.copyright.replace(/\s*All rights reserved\.?$/i, '')))].sort();
  const counts = {};
  for (const c of components) counts[c.license] = (counts[c.license] ?? 0) + 1;
  // Apache-2.0 components need their license text in legal/ (the bundled servers ship theirs; anything else is flagged).
  if (components.some((c) => /Apache-2\.0/.test(c.license) && c.ecosystem !== 'generic' && !c.licenseShipped)) flag('an Apache-2.0 component is bundled: its LICENSE and NOTICE text must be added to legal/');

  const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

  const npmCount = components.filter((c) => c.ecosystem === 'npm').length;
  const nugetCount = components.filter((c) => c.ecosystem === 'nuget').length;
  const serverCount = components.filter((c) => c.ecosystem === 'generic').length;
  const md = [];
  md.push('# Third-party notices', '',
    `Generated by \`scripts/package/notices.mjs\` from the contents of \`${extPkg.name}-${extPkg.version}.vsix\`. Do not edit by hand; run \`pnpm notices\`. This file is not a legal opinion. A machine-readable CycloneDX 1.5 SBOM is produced next to the VSIX (\`dist/${extPkg.name}-${extPkg.version}.sbom.json\`).`, '',
    '## What is shipped', '',
    `- The extension bundle \`extension/dist/extension.js\` (esbuild): ${components.some((c) => c.files.includes('dist/extension.js (bundled)')) ? `it includes the npm packages listed below; their license texts ship under \`legal/\` (${npmLicenses.map((l) => `\`${l.rel}\``).join(', ')}). The CSS and HTML language services (vscode-css-languageservice, vscode-html-languageservice) are bundled without their browser data files (descriptions of CSS properties and HTML tags, used only for completion and hover, which Refyntra does not offer): the build replaces them by empty data sets` : '**no third-party npm package is bundled**; it contains only Refyntra code (the `vscode` API is provided by the editor at run time)'}.`,
    `- The .NET host \`extension/host\`: Refyntra assemblies plus the ${nugetCount} NuGet packages listed below.`, '',
    '## Bundled language servers', '',
    'Python and Rust work without any other VS Code extension: Refyntra runs these servers as its own processes.', '',
    '- **TypeScript** (npm `typescript`, Apache-2.0, Microsoft Corporation) in `extension/servers/typescript`: the compiler API (`typescript.js`, no source map) and its default library declarations (`lib.*.d.ts`), run by the Refyntra web worker. License and third-party notices ship as `legal/typescript-LICENSE.txt` and `legal/typescript-ThirdPartyNoticeText.txt`.',
    '- **@angular/language-service** (npm, MIT, Google LLC) in `extension/servers/angular-language-service`: its self-contained bundle (no source map), loaded only by the Refyntra web worker as the single allowed TypeScript plugin.',
    '- **Pyright** (npm `pyright`, MIT, Microsoft Corporation) in `extension/servers/pyright`: only the files its language server needs (no source maps). `dist/vendor.js` contains npm libraries bundled by the Pyright project, distributed by Microsoft under the Pyright license.',
    '- **typeshed** standard-library stubs (Apache-2.0; parts MIT) bundled inside Pyright (`extension/servers/pyright/dist/typeshed-fallback`). Third-party stubs (`stubs/`) are not bundled. The license text ships as `legal/typeshed-LICENSE.txt` and next to the stubs.',
    `- **rust-analyzer** ${RA.version} (MIT OR Apache-2.0, the rust-analyzer developers) in \`extension/servers/rust-analyzer\` of the platform packages: the official release binary for that platform, downloaded at packaging time from ${RA.source} and verified against the SHA-256 in \`scripts/package/rust-analyzer.json\`. Both license texts ship (\`legal/rust-analyzer-LICENSE-MIT.txt\`, \`legal/rust-analyzer-LICENSE-APACHE.txt\`). The binary statically links Rust crates published under permissive licenses (MIT, Apache-2.0 and compatible); their attributions are those of the rust-analyzer release.`,
    ...serverLicenses.map((l) => `  - \`${l.rel}\`: ${l.what}`), '',
    '## Not bundled', '',
    '- **MSBuild and the .NET SDK**: taken from the SDK installed by the user at run time; not redistributed. `Microsoft.Build.Framework` is referenced with `ExcludeAssets="runtime"` and is not shipped.',
    '- **xunit 2.9.3** (Apache-2.0; xunit.core, xunit.assert, xunit.analyzers and xunit.extensibility.* declare Apache-2.0; xunit.abstractions 2.0.3 has only a licenseUrl): test-only, used by the `tests/fixtures/DiRules/DiRules.Tests` fixture and the host test project. Not redistributed, not part of the VSIX.',
    '- **MediatR 12.5.0** (Apache-2.0), **EF Core / Npgsql** and similar libraries appear only in test fixtures to prove navigation against the real libraries. They are **not redistributed** and are not part of the VSIX; Refyntra reads the metadata of the user\'s own projects. `scripts/package/audit.mjs` fails if such files appear in the VSIX.',
    '- **Microsoft.EntityFrameworkCore.Relational 9.0.10** (MIT; brings Microsoft.EntityFrameworkCore, .Abstractions, .Analyzers and their Microsoft.Extensions.* dependencies): test-only, used by the `tests/fixtures/EfCore` fixture to prove EF Core navigation against the real assemblies. Not redistributed, not part of the VSIX; Refyntra.Frameworks.EfCore.dll references no EF Core assembly.', '',
    '## Summary by license', '', '| License | Components |', '|---|---|',
    ...Object.entries(counts).sort().map(([l, n]) => `| ${l} | ${n} |`), '',
    '## Components', '', '| Ecosystem | Component | Version | License | Copyright | Shipped files |', '|---|---|---|---|---|---|',
    ...components.map((c) => `| ${c.ecosystem} | ${c.name} | ${c.version} | ${c.license}${c.review ? ` (needs manual review: ${c.review})` : ''} | ${(c.copyright ?? '').replace(/\|/g, '/')} | ${c.files.length > 3 ? `${c.files.slice(0, 3).join(', ')} +${c.files.length - 3}` : c.files.join(', ')} |`), '',
    `First-party assemblies (Refyntra, MIT, see \`LICENSE\`): ${firstParty.sort().join(', ')}.`, '');
  if (noticeFiles.size) {
    md.push('## Notices shipped by the packages', '', 'These files come from the NuGet packages themselves and are included unchanged in the VSIX under `legal/`:', '',
      ...[...noticeFiles.values()].map((n) => `- \`${n.rel}\` (from ${[...new Set(n.owners)].join(', ')})`), '');
  }
  md.push('## MIT License', '', 'The components marked MIT above are distributed under the following terms. Copyright holders:', '',
    ...mitCopyrights.map((c) => `- ${c}`), '', '```text', MIT_TEXT, '```', '');
  if (manual.length) md.push('## Open items for legal review', '', ...manual.map((m) => `- ${m}`), '');
  fs.writeFileSync(path.join(repo, 'THIRD_PARTY_NOTICES.md'), md.join('\n'));

  // ---------- CycloneDX 1.5 SBOM ----------
  const ref = (c) => `${c.ecosystem}:${c.name}@${c.version}`;
  const purl = (c) => (c.ecosystem === 'npm' ? `pkg:npm/${c.name.replace('@', '%40')}@${c.version}` : c.ecosystem === 'generic' ? (c.name === 'rust-analyzer' ? `pkg:github/rust-lang/rust-analyzer@${c.version}` : `pkg:github/python/typeshed@${c.version}`) : `pkg:nuget/${c.name}@${c.version}`);
  const nugetByName = new Map(components.filter((c) => c.ecosystem === 'nuget').map((c) => [c.name.toLowerCase(), c]));
  const mainRef = `${extPkg.name}@${extPkg.version}`;
  const bom = {
    bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: {
      timestamp: process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : new Date().toISOString(),
      tools: { components: [{ type: 'application', name: 'refyntra-notices', version: '1' }] },
      component: { type: 'application', 'bom-ref': mainRef, name: extPkg.name, version: extPkg.version, licenses: [{ license: { id: 'MIT' } }], purl: `pkg:generic/${extPkg.publisher}.${extPkg.name}@${extPkg.version}` },
    },
    components: components.map((c) => {
      const o = { type: 'library', 'bom-ref': ref(c), name: c.name, version: c.version, purl: purl(c) };
      if (c.authors) o.author = c.authors;
      if (c.copyright) o.copyright = c.copyright;
      if (c.review) o.licenses = [{ license: { name: c.license, ...(c.licenseUrl ? { url: c.licenseUrl } : {}) } }];
      else if (/^[\w.+-]+$/.test(c.license)) o.licenses = [{ license: { id: c.license } }];
      else o.licenses = [{ expression: c.license }];
      if (c.hash) o.hashes = [{ alg: 'SHA-512', content: Buffer.from(c.hash, 'base64').toString('hex') }];
      o.properties = [{ name: 'refyntra:shipped-files', value: c.files.join(';') }, ...(c.review ? [{ name: 'refyntra:needs-manual-review', value: c.review }] : [])];
      return o;
    }),
    dependencies: [
      { ref: mainRef, dependsOn: components.map(ref) },
      ...components.filter((c) => c.ecosystem === 'nuget').map((c) => ({ ref: ref(c), dependsOn: (c.deps ?? []).map((d) => nugetByName.get(d.toLowerCase())).filter(Boolean).map(ref) })),
    ],
  };
  bom.serialNumber = 'urn:uuid:' + crypto.createHash('sha256').update(JSON.stringify(bom.components)).digest('hex').replace(/^(.{8})(.{4}).(.{3}).(.{4})(.{12}).*$/, '$1-$2-5$3-8$4-$5');
  const sbomPath = path.join(repo, 'dist', `${extPkg.name}-${extPkg.version}.sbom.json`);
  fs.writeFileSync(sbomPath, JSON.stringify(bom, null, 2) + '\n');

  console.log(`\nComponents: ${components.length} (npm ${npmCount}, NuGet ${nugetCount}, other ${serverCount}); first-party assemblies ${firstParty.length}`);
  for (const [l, n] of Object.entries(counts).sort()) console.log(`  ${l}: ${n}`);
  console.log(`Wrote THIRD_PARTY_NOTICES.md, packages/extension/legal/ (${noticeFiles.size} files), ${path.relative(repo, sbomPath)}`);
  console.log(manual.length ? `${manual.length} item(s) need manual review` : 'No items need manual review');
  console.log('If THIRD_PARTY_NOTICES.md or legal/ changed, re-run pnpm package:vsix so the VSIX carries them (audit:vsix checks this).');
  if (unmapped.length) process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
