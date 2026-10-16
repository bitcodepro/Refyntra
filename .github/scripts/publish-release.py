"""Verify and publish Refyntra VSIX assets after ci.yml's required jobs succeed.

Only metadata is read from ZIP files; package contents are never extracted or run.
The workflow must serialize publishers and gate this job on every required check.
These guards are defense in depth, not protection against a malicious repository
writer. Server-side tag restrictions and independent credential controls remain
necessary for enforced immutability.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.error
from urllib.parse import quote
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


REPOSITORY = "bitcodepro/Refyntra"
TARGETS = (
    "win32-x64", "win32-arm64", "linux-x64", "linux-arm64",
    "alpine-x64", "darwin-x64", "darwin-arm64", "universal",
)
VERSION_RE = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
METADATA_LIMIT = 4 * 1024 * 1024


class DuplicateRelease(RuntimeError):
    """A higher version is not a recovery route for an already published SHA."""


def validate_version(version):
    if not isinstance(version, str) or not re.fullmatch(VERSION_RE, version):
        raise RuntimeError("Invalid release version; use stable X.Y.Z without a v prefix.")
    return version


def expected_assets(version):
    validate_version(version)
    return {f"refyntra-{version}{'' if target == 'universal' else '-' + target}.vsix": target
            for target in TARGETS}


def regular_file(path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise RuntimeError(f"Expected a regular file, not a directory or symlink: {path.name}")


def unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read_metadata(archive, name):
    info = archive.getinfo(name)
    if info.file_size > METADATA_LIMIT or info.is_dir():
        raise RuntimeError(f"Invalid or oversized VSIX metadata: {name}")
    if stat.S_ISLNK(info.external_attr >> 16):
        raise RuntimeError(f"Symlink VSIX metadata: {name}")
    return archive.read(info)


def verify_vsix(path, version, target):
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) != len(set(names)):
                raise RuntimeError(f"Invalid VSIX {path.name}: duplicate archive entries")
            package = json.loads(read_metadata(archive, "extension/package.json"),
                                 object_pairs_hook=unique_json_object)
            if not isinstance(package, dict) or any(
                    package.get(key) != value for key, value in
                    (("name", "refyntra"), ("publisher", "refyntra"), ("version", version))):
                raise RuntimeError(f"Invalid package.json identity/version in {path.name}")
            manifest_bytes = read_metadata(archive, "extension.vsixmanifest")
            # vsce emits UTF-8. Refuse DTDs/entities before parsing metadata.
            manifest_text = manifest_bytes.decode("utf-8-sig")
            if "<!DOCTYPE" in manifest_text.upper() or "<!ENTITY" in manifest_text.upper():
                raise RuntimeError(f"Unsafe VSIX manifest in {path.name}")
            manifest = ET.fromstring(manifest_text)
            identities = manifest.findall("./{*}Metadata/{*}Identity")
            if (manifest.tag.rsplit("}", 1)[-1] != "PackageManifest" or
                    len(identities) != 1 or len(manifest.findall(".//{*}Identity")) != 1):
                raise RuntimeError(f"VSIX manifest requires one Identity in {path.name}")
            identity = identities[0]
            expected = {"Id": "refyntra", "Publisher": "refyntra", "Version": version}
            if any(identity.get(key) != value for key, value in expected.items()):
                raise RuntimeError(f"Invalid VSIX manifest identity/version in {path.name}")
            platform = identity.get("TargetPlatform")
            if (target == "universal" and platform is not None) or (
                    target != "universal" and platform != target):
                raise RuntimeError(f"Wrong VSIX manifest target in {path.name}: {platform!r}")
    except (zipfile.BadZipFile, KeyError, ValueError, ET.ParseError, UnicodeError) as error:
        raise RuntimeError(f"Invalid VSIX {path.name}: {error}") from error


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def verify_assets(directory, version):
    """Return the eight VSIX plus deterministic SHA256SUMS, without executing them.

    A previous checksum file must match exactly; never silently replace it. This
    makes verification idempotent and detects changed assets before publication.
    """
    expected = expected_assets(version)
    directory = Path(directory).absolute()
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError("Release asset directory must be a real directory.")
    entries = {path.name: path for path in directory.iterdir()}
    missing = set(expected) - set(entries)
    extras = set(entries) - set(expected) - {"SHA256SUMS"}
    if missing or extras:
        raise RuntimeError(f"Release asset set mismatch: missing={sorted(missing)}, unexpected={sorted(extras)}")
    for path in entries.values():
        regular_file(path)
    assets = [entries[name] for name in sorted(expected)]
    for path in assets:
        verify_vsix(path, version, expected[path.name])
    checksums = "".join(f"{digest(path)}  {path.name}\n" for path in assets).encode("ascii")
    checksum_path = directory / "SHA256SUMS"
    if "SHA256SUMS" in entries:
        if checksum_path.read_bytes() != checksums:
            raise RuntimeError("Existing SHA256SUMS does not match the verified release assets; refusing overwrite.")
    else:
        with checksum_path.open("xb") as stream:
            stream.write(checksums)
    return assets + [checksum_path]


class GitHub:
    def __init__(self, repository, token):
        if repository != REPOSITORY or not token:
            raise RuntimeError("Publishing requires the Refyntra repository and a GitHub token.")
        self.base = f"https://api.github.com/repos/{repository}/"
        self.token = token
        self.created_release_ids = set()

    def request(self, method, path, data=None, *, missing_ok=False):
        # PATCH is allowed only to publish a draft created in this invocation.
        # Existing releases/assets/tags cannot be updated, deleted, or resumed.
        if method == "PATCH":
            if (path not in {f"releases/{item}" for item in self.created_release_ids} or
                    data != {"draft": False, "make_latest": "true"}):
                raise RuntimeError("Only a newly created draft can be published.")
        elif method not in ("GET", "POST") or (method == "POST" and path not in ("git/refs", "releases")):
            raise RuntimeError("Release publisher does not support destructive API requests.")
        request = urllib.request.Request(
            self.base + path, method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Authorization": f"Bearer {self.token}",
                     "Accept": "application/vnd.github+json",
                     "Content-Type": "application/json",
                     "X-GitHub-Api-Version": "2022-11-28"})
        result = self.send(request, missing_ok=missing_ok)
        if method == "POST" and path == "releases":
            if (isinstance(result, dict) and type(result.get("id")) is int and result["id"] > 0 and
                    result.get("draft") is True and result.get("tag_name") == data["tag_name"]):
                self.created_release_ids.add(result["id"])
        return result

    def send(self, request, *, missing_ok=False):
        try:
            # These fixed GitHub hosts must never redirect credentials elsewhere.
            opener = urllib.request.build_opener(NoRedirect())
            with opener.open(request, timeout=120) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if missing_ok and request.method == "GET" and error.code == 404:
                return None
            raise RuntimeError(f"GitHub {request.method} {request.full_url} failed: HTTP {error.code}") from error
        except http.client.HTTPException as error:
            raise RuntimeError(f"GitHub {request.method} response was incomplete; no retry was attempted.") from error

    def upload(self, release_id, path):
        if release_id not in self.created_release_ids:
            raise RuntimeError("Assets may only be uploaded to a newly created draft.")
        # Never follow upload_url from a response; fix both host and repository.
        url = (f"https://uploads.github.com/repos/{REPOSITORY}/releases/{release_id}"
               f"/assets?name={quote(path.name, safe='')}")
        with path.open("rb") as stream:
            request = urllib.request.Request(url, method="POST", data=stream, headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/octet-stream",
                "Content-Length": str(os.fstat(stream.fileno()).st_size),
                "X-GitHub-Api-Version": "2022-11-28",
            })
            return self.send(request)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise RuntimeError("Unexpected GitHub API redirect; refusing to forward credentials.")


def validate_context(env, version):
    validate_version(version)
    if (env.get("GITHUB_REPOSITORY") != REPOSITORY or
            env.get("GITHUB_REF") != "refs/heads/main" or
            env.get("GITHUB_EVENT_NAME") not in ("push", "workflow_dispatch") or
            env.get("GITHUB_WORKFLOW_REF") !=
            f"{REPOSITORY}/.github/workflows/ci.yml@refs/heads/main"):
        raise RuntimeError("Publishing requires this repository's CI workflow on main.")
    sha = env.get("GITHUB_SHA", "")
    tag = env.get("RELEASE_TAG", "")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError("Publishing requires an exact commit SHA.")
    if tag != "v" + version:
        raise RuntimeError("Release tag must match the verified VSIX version exactly.")
    return sha, tag


def check_main(api, sha):
    # Pin main before comparing: it is not the build target, GITHUB_SHA is.
    obj = api.request("GET", "git/ref/heads/main")["object"]
    if obj["type"] != "commit" or not re.fullmatch(r"[0-9a-f]{40}", obj["sha"]):
        raise RuntimeError("main does not resolve to an exact commit SHA.")
    comparison = api.request("GET", f"compare/{sha}...{obj['sha']}")
    if (comparison["status"] not in ("ahead", "identical") or
            comparison["merge_base_commit"]["sha"] != sha):
        raise RuntimeError("The tested commit is no longer an ancestor of main.")


def read_state(api):
    references = api.request("GET", "git/matching-refs/tags/v")
    refs = {ref["ref"].removeprefix("refs/tags/"): ref for ref in references}
    releases = []
    page = 1
    while True:
        batch = api.request("GET", f"releases?per_page=100&page={page}")
        releases.extend(batch)
        if len(batch) < 100:
            return refs, releases
        page += 1


def stable_version(tag):
    match = re.fullmatch("v" + VERSION_RE, tag)
    return tuple(map(int, match.groups())) if match else None


def stable_tags(refs, releases, exclude=None):
    names = set(refs) | {item["tag_name"] for item in releases}
    return {name: stable_version(name) for name in names
            if name != exclude and stable_version(name) is not None}


def check_unused_release(tag, releases):
    if any(item["tag_name"] == tag for item in releases):
        raise RuntimeError(f"Release {tag} already exists (including drafts).")


def check_reserved_tag(api, tag, sha):
    reference = api.request("GET", f"git/ref/tags/{tag}")
    if reference["object"]["type"] != "commit" or reference["object"]["sha"] != sha:
        raise RuntimeError("The new tag changed before publication.")


def check_draft(item, tag, release_id=None):
    if (not isinstance(item, dict) or type(item.get("id")) is not int or item["id"] <= 0 or
            item.get("tag_name") != tag or item.get("draft") is not True or
            item.get("prerelease") is not False or
            (release_id is not None and item["id"] != release_id)):
        raise RuntimeError("New release draft identity/state changed or was invalid.")
    return item["id"]


def check_uploaded_asset(item, path, expected_digest):
    if (not isinstance(item, dict) or item.get("name") != path.name or item.get("state") != "uploaded" or
            type(item.get("size")) is not int or item["size"] != path.stat().st_size or
            item.get("digest") != "sha256:" + expected_digest):
        raise RuntimeError(f"Uploaded asset metadata/checksum mismatch: {path.name}")


def check_unused(api, tag, releases):
    if api.request("GET", f"git/ref/tags/{tag}", missing_ok=True) is not None:
        raise RuntimeError(f"Tag {tag} already exists; tags are never moved or reused.")
    check_unused_release(tag, releases)


def tag_commit(api, tag, refs):
    reference = refs.get(tag)
    if reference is None:
        # Never trust target_commitish: it may contain a branch rather than SHA.
        reference = api.request("GET", f"git/ref/tags/{quote(tag, safe='')}")
    obj = reference["object"]
    for _ in range(16):
        if not re.fullmatch(r"[0-9a-f]{40}", obj["sha"]):
            raise RuntimeError(f"Invalid object SHA for {tag}.")
        if obj["type"] == "commit":
            return obj["sha"]
        if obj["type"] != "tag":
            break
        obj = api.request("GET", f"git/tags/{obj['sha']}")["object"]
    raise RuntimeError(f"Tag {tag} does not resolve to a commit.")


def check_release_order(api, sha, tag, refs, releases, *, reserved=False):
    # Only our newly reserved tag is excluded from the stable ceiling.
    stable = stable_tags(refs, releases, exclude=tag if reserved else None)
    highest = max(stable, key=stable.get) if stable else None
    if highest is not None and stable_version(tag) <= stable[highest]:
        raise RuntimeError(f"Stable {tag} must be greater than highest stable {highest}.")
    history = {highest} if highest else set()
    published = set()
    for item in releases:
        if type(item["draft"]) is not bool:
            raise RuntimeError("Invalid release draft status.")
        if not item["draft"]:
            history.add(item["tag_name"])
            published.add(item["tag_name"])
    checked = set()
    for previous in sorted(history):
        base = tag_commit(api, previous, refs)
        if base == sha and previous in published:
            raise DuplicateRelease(
                f"Tested commit {sha} already has published release {previous}. "
                "A higher version cannot release this SHA again. Use a new tested main commit. "
                "Any reserved tag remains; do not move/delete tags or replace release assets.")
        if base in checked or base == sha:
            continue
        comparison = api.request("GET", f"compare/{base}...{sha}")
        if (comparison["status"] not in ("ahead", "identical") or
                comparison["merge_base_commit"]["sha"] != base):
            raise RuntimeError(
                f"Tested commit {sha} is older than or diverges from {previous} ({base}). "
                "Start fresh CI on main; do not rerun this old SHA.")
        checked.add(base)


def recovery_hint(api, tag, sha):
    try:
        refs, releases = read_state(api)
        for item in releases:
            if type(item["draft"]) is not bool:
                raise RuntimeError("Invalid release draft status.")
            if not item["draft"] and tag_commit(api, item["tag_name"], refs) == sha:
                return (f"Tested commit {sha} already has published release {item['tag_name']}. "
                        "Inspect the release; publication may have succeeded despite the error. "
                        "For another release use a new tested main commit, not another version of this SHA. "
                        "Do not move/delete tags or replace release assets.")
        major, minor, patch = max([stable_version(tag), *stable_tags(refs, releases).values()])
        suggestion = f"{major}.{minor}.{patch + 1}"
        return (f"Do not move/delete {tag} or replace release assets. A reserved tag or partial draft may remain. "
                "Inspect the Actions log and remote release before doing anything else. "
                f"After investigation, start fresh CI on main with release_version={suggestion} "
                "(or empty for automatic bump). This unused version is only a suggestion, "
                "revalidated at publication; stale or already published commits remain rejected.")
    except (RuntimeError, OSError, KeyError, TypeError, ValueError):
        return ("Could not determine the next unused version. Inspect remote tags/releases, "
                "then start fresh CI on main. Do not move/delete tags or replace release assets.")


def publish(api, env, directory, version):
    sha, tag = validate_context(env, version)
    assets = verify_assets(directory, version)
    try:
        check_main(api, sha)
        refs, releases = read_state(api)
        check_unused(api, tag, releases)
        check_release_order(api, sha, tag, refs, releases)
        # Atomic create-only reservation: a racing creator fails; never PATCH.
        api.request("POST", "git/refs", {"ref": f"refs/tags/{tag}", "sha": sha})
        # Re-read state after reservation, not the earlier version job snapshot.
        refs, releases = read_state(api)
        check_unused_release(tag, releases)
        check_release_order(api, sha, tag, refs, releases, reserved=True)
        check_main(api, sha)
        check_reserved_tag(api, tag, sha)
        verify_assets(directory, version)  # Recheck bytes against precomputed checksums.
        hashes = {path.name: digest(path) for path in assets}
        # gh release create deletes drafts on uncertain upload/publish failures.
        # Use explicit calls instead: one create, one upload per file, one publish.
        draft = api.request("POST", "releases", {
            "tag_name": tag, "target_commitish": sha, "name": tag,
            "draft": True, "prerelease": False, "generate_release_notes": True,
        })
        release_id = check_draft(draft, tag)
        for path in assets:
            check_uploaded_asset(api.upload(release_id, path), path, hashes[path.name])
        remote_assets = api.request("GET", f"releases/{release_id}/assets?per_page=100")
        by_name = {item["name"]: item for item in remote_assets}
        if len(remote_assets) != len(assets) or set(by_name) != set(hashes):
            raise RuntimeError("Uploaded release asset set changed or is incomplete.")
        for path in assets:
            check_uploaded_asset(by_name[path.name], path, hashes[path.name])
        check_draft(api.request("GET", f"releases/{release_id}"), tag, release_id)
        # Uploads can take time. Revalidate all ordering and tag guards before
        # publishing, allowing only this invocation's own still-unpublished draft.
        refs, releases = read_state(api)
        if any(item["tag_name"] == tag and item.get("id") != release_id for item in releases):
            raise RuntimeError(f"Another release for {tag} already exists.")
        check_release_order(api, sha, tag, refs, releases, reserved=True)
        check_main(api, sha)
        check_reserved_tag(api, tag, sha)
        verify_assets(directory, version)
        result = api.request("PATCH", f"releases/{release_id}", {"draft": False, "make_latest": "true"})
        if (not isinstance(result, dict) or result.get("id") != release_id or result.get("tag_name") != tag or
                result.get("draft") is not False or result.get("prerelease") is not False):
            raise RuntimeError("Release publication returned an unexpected state; inspect the remote release.")
    except DuplicateRelease:
        raise
    except (RuntimeError, OSError, KeyError, TypeError, ValueError) as error:
        raise RuntimeError(f"{error}\n{recovery_hint(api, tag, sha)}") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("verify", "publish"))
    parser.add_argument("directory", type=Path)
    parser.add_argument("version")
    args = parser.parse_args(argv)
    try:
        if args.action == "verify":
            assets = verify_assets(args.directory, args.version)
            print(f"Verified {len(assets) - 1} VSIX assets and SHA256SUMS for {args.version}.")
        else:
            validate_context(os.environ, args.version)
            api = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ.get("GH_TOKEN", ""))
            publish(api, os.environ, args.directory, args.version)
            print(f"Published https://github.com/{REPOSITORY}/releases/tag/v{args.version}")
        return 0
    except (RuntimeError, OSError) as error:
        print(f"Release failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
