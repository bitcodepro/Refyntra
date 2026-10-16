# GitHub Releases

CI builds and tests the exact triggering commit. Pull requests run the same existing
Windows integration/install smoke, Windows/Linux unit/architecture/host tests and
eight-target package/audit matrix, plus release-policy and downloaded-package checks.
Only successful `main` push or manual CI runs in `bitcodepro/Refyntra` can publish.
There is no VS Code Marketplace publishing and no additional credential is needed.

## Versions

The first release uses `packages/extension/package.json`'s version (initially 0.1.0).
Later releases increment the highest stable `vX.Y.Z` tag's patch number. The
**first line of the tested commit message** controls the bump:

- `[major]` or `#major`: increment major, reset minor and patch
- `[minor]` or `#minor`: increment minor, reset patch
- `[skip release]`: run all checks but skip publishing
- Otherwise: increment patch

Use these markers in a squash-merge PR title, or edit the merge commit's first line
when using a merge commit. Text in the commit body does not select a bump.
A manual CI run on main can provide an explicit, unused stable `release_version`
(`X.Y.Z`, no `v`, prerelease or build suffix). It overrides the subject including skip.

One version is selected before every build. CI stamps only the extension manifest in
its disposable checkouts; it does not push version-bump commits. The package script,
audit and install smoke derive filenames and installed identity from that manifest.
The manifest committed on main remains the local-development baseline; release tags
identify source, while downloaded VSIX manifests contain the selected release version.

## Assets and permissions

Each release contains eight VSIX: win32-x64, win32-arm64, linux-x64, linux-arm64,
alpine-x64, darwin-x64, darwin-arm64 and universal. The universal filename has no
target suffix; it does not carry rust-analyzer. Package audits remain mandatory.
The verifier requires the complete exact asset set and matching embedded versions
and targets, and creates `SHA256SUMS`. For example, on Linux:

```sh
sha256sum -c SHA256SUMS
```

Only the final publisher has `contents: write`. Checkouts do not retain credentials.
Main workflows are serialized without canceling an active release; PR runs may cancel
older PR runs. GitHub concurrency can replace a *pending* run with a newer pending
run, so every main commit is not guaranteed its own release during rapid pushes.

The publisher uses atomic create-only tag creation pointing at the tested SHA. It
never moves tags or overwrites releases/assets. It rejects non-main contexts, commits
no longer on main, stale/divergent release history and duplicate published commit SHAs.
Downloaded packages are inspected as data, never executed by the publishing job.
Server-side `v*` tag restrictions are separate repository settings; these scripts do
not create or change rulesets and cannot stop a repository administrator moving tags.

## Interrupted publication and retries

A failure before tag reservation can be retried after investigating. Once a tag or
release exists, retrying that version fails closed; no cleanup, overwrite or deletion
is attempted. An interrupted upload may leave a draft or incomplete release. Inspect
remote tags/releases and the CI error before taking any further action. If publication
already succeeded, do not release the same commit again. Otherwise start fresh CI on
main with the next unused stable version; rerunning old failed jobs does not recalculate
the version. Any existing reserved tag or assets remain untouched.

## Policy checks

```sh
python3 -m pip install PyYAML==6.0.3
python3 -B -m unittest discover -s .github/scripts/tests -v
```

These checks supplement the existing product tests; they do not replace them.
