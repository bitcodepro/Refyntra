// Project file editing model (pure: no vscode). Completion and hover data for .csproj / .props / .targets: common
// MSBuild properties and items, their values (TargetFramework, Nullable, LangVersion, ImplicitUsings …), and where the
// caret is (element name, element value, attribute value). Package ids and versions come from the caller (local NuGet
// cache, installed packages, versions loaded on demand). ADR-013.

export interface MsBuildEntry {
  name: string;
  doc: string;
  values?: string[];
}

const TFMS = ['net10.0', 'net9.0', 'net8.0', 'netstandard2.1', 'netstandard2.0', 'net10.0-windows', 'net9.0-windows', 'net8.0-windows', 'net481', 'net48', 'net472', 'net462'];
const BOOL = ['true', 'false'];

export const MSBUILD_PROPERTIES: MsBuildEntry[] = [
  { name: 'TargetFramework', doc: 'The target framework moniker the project builds for (one).', values: TFMS },
  { name: 'TargetFrameworks', doc: 'Several target frameworks, separated by semicolons (multi-targeting).', values: ['net10.0;net8.0', 'net8.0;netstandard2.0'] },
  { name: 'OutputType', doc: 'Exe (console app), WinExe (Windows GUI app) or Library (default).', values: ['Exe', 'WinExe', 'Library'] },
  { name: 'Nullable', doc: 'The nullable reference types context: enable, disable, warnings or annotations.', values: ['enable', 'disable', 'warnings', 'annotations'] },
  { name: 'ImplicitUsings', doc: 'Adds global using directives for the SDK\'s common namespaces.', values: ['enable', 'disable'] },
  { name: 'LangVersion', doc: 'The C# language version: latest, preview, default, latestMajor or a number.', values: ['latest', 'preview', 'default', 'latestMajor', '14.0', '13.0', '12.0', '11.0', '10.0', '9.0', '8.0', '7.3'] },
  { name: 'RootNamespace', doc: 'The namespace new files get; defaults to the project name.' },
  { name: 'AssemblyName', doc: 'The output assembly name; defaults to the project name.' },
  { name: 'Version', doc: 'The package and assembly version (SemVer).' },
  { name: 'VersionPrefix', doc: 'The version without a suffix.' },
  { name: 'VersionSuffix', doc: 'The prerelease suffix of the version.' },
  { name: 'TreatWarningsAsErrors', doc: 'Reports every warning as an error.', values: BOOL },
  { name: 'WarningsAsErrors', doc: 'Warning ids reported as errors (semicolon separated).' },
  { name: 'NoWarn', doc: 'Warning ids not reported (semicolon separated).' },
  { name: 'GenerateDocumentationFile', doc: 'Writes the XML documentation file of the assembly.', values: BOOL },
  { name: 'IsPackable', doc: 'Whether dotnet pack makes a package of the project.', values: BOOL },
  { name: 'IsTestProject', doc: 'Marks a test project (dotnet test, Test Explorer).', values: BOOL },
  { name: 'PackageId', doc: 'The id of the package dotnet pack produces.' },
  { name: 'Authors', doc: 'Package authors.' },
  { name: 'Description', doc: 'Package description.' },
  { name: 'PackageLicenseExpression', doc: 'An SPDX license expression (MIT, Apache-2.0 …).', values: ['MIT', 'Apache-2.0', 'BSD-3-Clause'] },
  { name: 'PackageReadmeFile', doc: 'The readme file packed into the package.' },
  { name: 'RuntimeIdentifier', doc: 'The runtime the app is built for (RID).', values: ['win-x64', 'win-arm64', 'linux-x64', 'linux-arm64', 'linux-musl-x64', 'osx-x64', 'osx-arm64'] },
  { name: 'RuntimeIdentifiers', doc: 'Runtimes restore prepares (semicolon separated).' },
  { name: 'SelfContained', doc: 'Publishes the .NET runtime with the app.', values: BOOL },
  { name: 'PublishSingleFile', doc: 'Publishes one executable file.', values: BOOL },
  { name: 'PublishTrimmed', doc: 'Trims unused code when publishing.', values: BOOL },
  { name: 'PublishAot', doc: 'Native AOT compilation on publish.', values: BOOL },
  { name: 'InvariantGlobalization', doc: 'Runs without culture data (smaller, culture-invariant).', values: BOOL },
  { name: 'UserSecretsId', doc: 'The id of the user secrets store (dotnet user-secrets).' },
  { name: 'AllowUnsafeBlocks', doc: 'Allows unsafe code.', values: BOOL },
  { name: 'Deterministic', doc: 'Deterministic builds (same inputs, same output).', values: BOOL },
  { name: 'EnableDefaultCompileItems', doc: 'Includes **/*.cs as Compile items (SDK default globs).', values: BOOL },
  { name: 'EnableDefaultItems', doc: 'Includes the SDK default items (Compile, None, EmbeddedResource).', values: BOOL },
  { name: 'ManagePackageVersionsCentrally', doc: 'Central Package Management: versions in Directory.Packages.props.', values: BOOL },
  { name: 'CentralPackageTransitivePinningEnabled', doc: 'Central versions also pin transitive packages.', values: BOOL },
  { name: 'UseWPF', doc: 'Windows Presentation Foundation app (net*-windows).', values: BOOL },
  { name: 'UseWindowsForms', doc: 'Windows Forms app (net*-windows).', values: BOOL },
  { name: 'AnalysisLevel', doc: 'The .NET code analysis rule set level.', values: ['latest', 'latest-recommended', 'latest-all', 'preview'] },
  { name: 'EnableNETAnalyzers', doc: 'Runs the .NET code analyzers.', values: BOOL },
  { name: 'EnforceCodeStyleInBuild', doc: 'Reports code style (IDE) rules in the build.', values: BOOL },
  { name: 'Configuration', doc: 'The build configuration (Debug / Release).', values: ['Debug', 'Release'] },
  { name: 'Platforms', doc: 'Platforms of the project (AnyCPU;x64).' },
  { name: 'DebugType', doc: 'portable, embedded, full or none.', values: ['portable', 'embedded', 'full', 'none'] },
  { name: 'Optimize', doc: 'Compiler optimizations.', values: BOOL },
  { name: 'DefineConstants', doc: 'Conditional compilation symbols (semicolon separated).' },
  { name: 'ContinuousIntegrationBuild', doc: 'Normalizes paths for CI (deterministic source paths).', values: BOOL },
  { name: 'InternalsVisibleTo', doc: 'Use the InternalsVisibleTo item instead.' },
];

export const MSBUILD_ITEMS: MsBuildEntry[] = [
  { name: 'PackageReference', doc: 'A NuGet package dependency: Include="Id" Version="x" (no Version with Central Package Management).' },
  { name: 'ProjectReference', doc: 'A dependency on another project: Include="..\\Other\\Other.csproj".' },
  { name: 'FrameworkReference', doc: 'A shared framework: Include="Microsoft.AspNetCore.App".' },
  { name: 'Compile', doc: 'C# source files. Include / Remove change the SDK default glob; Link shows a file in another folder.' },
  { name: 'None', doc: 'Files that are part of the project but not compiled. CopyToOutputDirectory copies them.' },
  { name: 'Content', doc: 'Content files (web roots, copied on publish).' },
  { name: 'EmbeddedResource', doc: 'Files embedded in the assembly (.resx).' },
  { name: 'AdditionalFiles', doc: 'Files given to analyzers and source generators.' },
  { name: 'Using', doc: 'A global using directive: Include="Namespace" (Static="true", Alias="X").' },
  { name: 'InternalsVisibleTo', doc: 'Makes internal members visible to another assembly: Include="Other.Tests".' },
  { name: 'PackageVersion', doc: 'Central Package Management (Directory.Packages.props): Include="Id" Version="x".' },
  { name: 'Folder', doc: 'An empty folder kept in the project.' },
];

const GROUPS = ['PropertyGroup', 'ItemGroup', 'Target', 'Import', 'Choose', 'ImportGroup', 'Sdk'];

export type ProjectFileContext =
  | { kind: 'propertyName' }
  | { kind: 'itemName' }
  | { kind: 'groupName' }
  | { kind: 'propertyValue'; property: string }
  | { kind: 'attributeValue'; element: string; attribute: string; prefix: string }
  | { kind: 'none' };

/** Names of the elements open at the end of `text` (a tolerant scan: comments and CDATA skipped). */
export function openElements(text: string): string[] {
  const stack: string[] = [];
  const clean = text.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?(\]\]>|$)/g, '');
  const re = /<(\/?)([A-Za-z_][\w.-]*)([^<>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) {
      const i = stack.lastIndexOf(name!);
      if (i >= 0) stack.length = i;
    } else stack.push(name!);
  }
  return stack;
}

/** Where the caret is: `before` is the document text up to the caret. */
export function projectFileContext(before: string): ProjectFileContext {
  // Inside an attribute value: <PackageReference Include="Med|
  const attr = /<([A-Za-z_][\w.-]*)\b[^<>]*\b([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)$/.exec(before);
  if (attr) return { kind: 'attributeValue', element: attr[1]!, attribute: attr[2]!, prefix: attr[3]! };
  // A tag name being typed: <Tar|  (or just "<")
  const tag = /<([A-Za-z_][\w.-]*)?$/.exec(before);
  if (tag) {
    const parents = openElements(before.slice(0, tag.index));
    const parent = parents[parents.length - 1];
    if (parent === 'PropertyGroup') return { kind: 'propertyName' };
    if (parent === 'ItemGroup') return { kind: 'itemName' };
    if (parent === 'Project' || parent === 'Target' || parent === 'Choose' || parent === 'When' || parent === 'Otherwise') return { kind: 'groupName' };
    return { kind: 'none' };
  }
  // Element text: <Nullable>en|
  const value = /<([A-Za-z_][\w.-]*)(\s[^<>]*)?>([^<]*)$/.exec(before);
  if (value) {
    const parents = openElements(before.slice(0, value.index));
    if (parents[parents.length - 1] === 'PropertyGroup') return { kind: 'propertyValue', property: value[1]! };
  }
  return { kind: 'none' };
}

export function propertyValues(property: string): string[] {
  return MSBUILD_PROPERTIES.find((p) => p.name.toLowerCase() === property.toLowerCase())?.values ?? [];
}

export function groupNames(): string[] {
  return [...GROUPS];
}

/** Hover text for an element name (properties and items). */
export function hoverFor(name: string): string | undefined {
  const p = MSBUILD_PROPERTIES.find((x) => x.name === name);
  if (p) return `**${p.name}** (MSBuild property)\n\n${p.doc}${p.values?.length ? `\n\nValues: ${p.values.map((v) => `\`${v}\``).join(', ')}` : ''}`;
  const i = MSBUILD_ITEMS.find((x) => x.name === name);
  if (i) return `**${i.name}** (MSBuild item)\n\n${i.doc}`;
  return undefined;
}

/** The element name under the caret: `line` and the character index in it. */
export function elementNameAt(line: string, character: number): string | undefined {
  const re = /<\/?([A-Za-z_][\w.-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const start = m.index + m[0].length - m[1]!.length;
    if (character >= start && character <= start + m[1]!.length) return m[1];
  }
  return undefined;
}

/** The Include of the PackageReference / PackageVersion element the caret's attribute belongs to (Version completion). */
export function packageIdOfElement(before: string): string | undefined {
  const open = before.lastIndexOf('<');
  const tag = before.slice(open);
  const m = /^<(?:PackageReference|PackageVersion)\b[^>]*\b(?:Include|Update)\s*=\s*"([^"]+)"/.exec(tag);
  return m?.[1];
}

/** Package ids in the local NuGet cache: the folder names of ~/.nuget/packages are lower-case ids. */
export function cacheIds(folderNames: readonly string[], prefix: string): string[] {
  const p = prefix.toLowerCase();
  return folderNames.filter((n) => !n.startsWith('.') && n.toLowerCase().startsWith(p)).sort();
}
