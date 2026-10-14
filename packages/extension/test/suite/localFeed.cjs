// A local NuGet folder feed made in the test (no internet): `dotnet pack` of a tiny net10.0 library, versions 1.0.0 and
// 1.1.0 of "Refyntra.Sample", with a nuget.config that clears every other source. Used by the Solution Explorer e2e
// suite (solution.cjs) and its visual cases (visualSolution.cjs).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const PACKAGE_ID = 'Refyntra.Sample';

/** nuget.config text with only the given local folder as a source. */
function nugetConfig(feed) {
  return ['<?xml version="1.0" encoding="utf-8"?>', '<configuration>', '  <packageSources>', '    <clear />', `    <add key="local" value="${feed}" />`, '  </packageSources>', '</configuration>', ''].join('\n');
}

/** Packs Refyntra.Sample 1.0.0 and 1.1.0 into a new folder feed (asynchronously: the extension host stays responsive). */
async function createLocalFeed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refyntra-feed-'));
  const src = path.join(root, 'src');
  const feed = path.join(root, 'feed');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(feed, { recursive: true });
  fs.writeFileSync(path.join(root, 'nuget.config'), nugetConfig(feed));
  fs.writeFileSync(path.join(root, 'Directory.Build.props'), '<Project />\n');
  fs.writeFileSync(path.join(root, 'Directory.Packages.props'), '<Project><PropertyGroup><ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally></PropertyGroup></Project>\n');
  fs.writeFileSync(
    path.join(src, `${PACKAGE_ID}.csproj`),
    ['<Project Sdk="Microsoft.NET.Sdk">', '  <PropertyGroup>', '    <TargetFramework>net10.0</TargetFramework>', `    <PackageId>${PACKAGE_ID}</PackageId>`, '    <Authors>Refyntra tests</Authors>', '    <Description>A package made by the Refyntra tests for a local folder feed.</Description>', '  </PropertyGroup>', '</Project>', ''].join('\n'),
  );
  fs.writeFileSync(path.join(src, 'Sample.cs'), 'namespace Refyntra.Sample;\n\npublic static class Sample\n{\n    public static int Answer() => 42;\n}\n');
  for (const version of ['1.0.0', '1.1.0'])
    await promisify(execFile)('dotnet', ['pack', path.join(src, `${PACKAGE_ID}.csproj`), '-c', 'Release', '-o', feed, `-p:Version=${version}`, '--nologo'], {
      cwd: root,
      timeout: 300000,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER: '1' },
    });
  return { root, feed, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }) };
}

module.exports = { PACKAGE_ID, createLocalFeed, nugetConfig };
