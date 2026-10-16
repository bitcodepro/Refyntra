"""Offline release safety tests. The fake API never makes network requests."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


SPEC = importlib.util.spec_from_file_location(
    "publish_release", Path(__file__).resolve().parents[1] / "publish-release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

SHA = "a" * 40
OLD = "b" * 40
NEW = "c" * 40
VERSION = "0.2.0"
TAG = "v" + VERSION
ENV = {
    "GITHUB_REPOSITORY": "bitcodepro/Refyntra",
    "GITHUB_REF": "refs/heads/main",
    "GITHUB_EVENT_NAME": "push",
    "GITHUB_WORKFLOW_REF": "bitcodepro/Refyntra/.github/workflows/ci.yml@refs/heads/main",
    "GITHUB_SHA": SHA,
    "RELEASE_TAG": TAG,
}


def reference(tag, sha=OLD, kind="commit"):
    return {"ref": "refs/tags/" + tag, "object": {"type": kind, "sha": sha}}


class FakeGitHub:
    def __init__(self):
        self.refs = {}
        self.releases = []
        self.main = SHA
        self.comparisons = {}
        self.objects = {}
        self.calls = []
        self.after_reserve = None
        self.after_create = None
        self.before_upload = None
        self.before_finalize = None
        self.uploads = []
        self.publications = []
        self.created = set()

    def request(self, method, path, data=None, *, missing_ok=False):
        self.calls.append((method, path, data))
        if method == "POST" and path == "git/refs":
            tag = data["ref"].removeprefix("refs/tags/")
            if tag in self.refs:
                raise RuntimeError("HTTP 422: reference already exists")
            self.refs[tag] = reference(tag, data["sha"])
            if self.after_reserve:
                self.after_reserve(self)
            return copy.deepcopy(self.refs[tag])
        if method == "POST" and path == "releases":
            if any(item["tag_name"] == data["tag_name"] for item in self.releases):
                raise RuntimeError("Release already exists")
            item = {**data, "id": 1000 + len(self.releases), "assets": []}
            self.releases.append(item)
            self.created.add(item["id"])
            if self.after_create:
                self.after_create(self, item)
            return copy.deepcopy(item)
        if method == "PATCH" and path.startswith("releases/"):
            release_id = int(path.split("/")[1])
            assert release_id in self.created
            assert data == {"draft": False, "make_latest": "true"}
            item = self.get_release(release_id)
            if self.before_finalize:
                self.before_finalize(self, item)
            item.update(data)
            self.publications.append(release_id)
            return copy.deepcopy(item)
        if method != "GET":
            raise AssertionError(f"Unexpected mutation: {method} {path}")
        if path == "git/ref/heads/main":
            return {"object": {"type": "commit", "sha": self.main}}
        if path == "git/matching-refs/tags/v":
            return copy.deepcopy(list(self.refs.values()))
        if path.startswith("releases?per_page=100&page="):
            page = int(path.rsplit("=", 1)[1])
            return copy.deepcopy(self.releases[(page - 1) * 100:page * 100])
        if path.startswith("releases/"):
            item = self.get_release(int(path.split("/")[1]))
            return copy.deepcopy(item["assets"] if "/assets?" in path else item)
        if path.startswith("git/ref/tags/"):
            tag = path.removeprefix("git/ref/tags/")
            if tag in self.refs:
                return copy.deepcopy(self.refs[tag])
            if missing_ok:
                return None
            raise RuntimeError("Missing release tag")
        if path.startswith("git/tags/"):
            return {"object": self.objects[path.removeprefix("git/tags/")]}
        if path.startswith("compare/"):
            base, head = path.removeprefix("compare/").split("...")
            return self.comparisons.get((base, head), {
                "status": "identical" if base == head else "ahead",
                "merge_base_commit": {"sha": base},
            })
        raise AssertionError(f"Unexpected request: {method} {path}")

    def add_release(self, tag="v0.1.0", sha=OLD, draft=False, prerelease=False):
        self.refs[tag] = reference(tag, sha)
        self.releases.append({"tag_name": tag, "draft": draft, "prerelease": prerelease,
                              "id": 1000 + len(self.releases), "assets": []})

    def get_release(self, release_id):
        return next(item for item in self.releases if item["id"] == release_id)

    def upload(self, release_id, path):
        assert release_id in self.created
        self.uploads.append(path.name)
        self.calls.append(("POST", f"uploads/{release_id}/{path.name}", None))
        item = self.get_release(release_id)
        if self.before_upload:
            self.before_upload(self, item, path)
        asset = {"name": path.name, "size": path.stat().st_size, "state": "uploaded",
                 "digest": "sha256:" + release.digest(path)}
        item["assets"].append(asset)
        return copy.deepcopy(asset)

    @property
    def mutations(self):
        return [call for call in self.calls if call[0] != "GET"]


class AssetFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        for target in release.TARGETS:
            self.write_asset(target)

    def path(self, target):
        suffix = "" if target == "universal" else "-" + target
        return self.directory / f"refyntra-{VERSION}{suffix}.vsix"

    def write_asset(self, target="linux-x64", *, package=None, manifest=None, extra=()):
        package = package if package is not None else {
            "name": "refyntra", "version": VERSION, "publisher": "refyntra"}
        platform = "" if target == "universal" else f' TargetPlatform="{target}"'
        manifest = manifest if manifest is not None else (
            '<PackageManifest xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">'
            f'<Metadata><Identity Id="refyntra" Publisher="refyntra" Version="{VERSION}"'
            f'{platform}/></Metadata></PackageManifest>')
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.path(target), "w") as archive:
                archive.writestr("extension/package.json", json.dumps(package))
                archive.writestr("extension.vsixmanifest", manifest)
                # Contents are opaque, never imported, extracted, or executed.
                archive.writestr("extension/scripts/do-not-run.py", "raise SystemExit(99)")
                for name, data in extra:
                    archive.writestr(name, data)


class VerifyTests(AssetFixture):
    def test_complete_set_and_deterministic_checksums(self):
        paths = release.verify_assets(self.directory, VERSION)
        self.assertEqual(len(paths), 9)
        self.assertEqual({p.name for p in paths}, {
            self.path(target).name for target in release.TARGETS} | {"SHA256SUMS"})
        sums = self.directory / "SHA256SUMS"
        expected = "".join(
            f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
            for path in sorted(self.directory.glob("*.vsix")))
        self.assertEqual(sums.read_text(), expected)
        self.assertEqual(release.verify_assets(self.directory, VERSION), paths)

    def test_missing_target(self):
        self.path("darwin-arm64").unlink()
        with self.assertRaisesRegex(RuntimeError, "missing.*darwin-arm64"):
            release.verify_assets(self.directory, VERSION)
        self.assertFalse((self.directory / "SHA256SUMS").exists())

    def test_extra_files_or_directories(self):
        for name in ("refyntra-9.0.0.vsix", "unexpected.txt", "nested"):
            with self.subTest(name=name):
                path = self.directory / name
                path.write_text("unexpected")
                with self.assertRaisesRegex(RuntimeError, "unexpected"):
                    release.verify_assets(self.directory, VERSION)
                path.unlink()
        (self.directory / "nested").mkdir()
        with self.assertRaisesRegex(RuntimeError, "unexpected"):
            release.verify_assets(self.directory, VERSION)

    def test_wrong_package_identity_or_version(self):
        for key, value in (("name", "other"), ("version", "0.1.0"), ("publisher", "other")):
            with self.subTest(key=key):
                package = {"name": "refyntra", "version": VERSION, "publisher": "refyntra"}
                package[key] = value
                self.write_asset(package=package)
                with self.assertRaisesRegex(RuntimeError, "package.json"):
                    release.verify_assets(self.directory, VERSION)

    def test_wrong_manifest_identity_version_or_target(self):
        for identity in (
            '<Identity Id="other" Publisher="refyntra" Version="0.2.0" TargetPlatform="linux-x64"/>',
            '<Identity Id="refyntra" Publisher="other" Version="0.2.0" TargetPlatform="linux-x64"/>',
            '<Identity Id="refyntra" Publisher="refyntra" Version="0.1.0" TargetPlatform="linux-x64"/>',
            '<Identity Id="refyntra" Publisher="refyntra" Version="0.2.0" TargetPlatform="linux-arm64"/>',
            '<Identity Id="refyntra" Publisher="refyntra" Version="0.2.0"/>',
        ):
            with self.subTest(identity=identity):
                self.write_asset(manifest=f"<PackageManifest><Metadata>{identity}</Metadata></PackageManifest>")
                with self.assertRaisesRegex(RuntimeError, "manifest"):
                    release.verify_assets(self.directory, VERSION)

    def test_universal_must_have_no_platform(self):
        self.write_asset("universal", manifest=(
            f'<PackageManifest><Metadata><Identity Id="refyntra" Publisher="refyntra" Version="{VERSION}" '
            'TargetPlatform="linux-x64"/></Metadata></PackageManifest>'))
        with self.assertRaisesRegex(RuntimeError, "manifest"):
            release.verify_assets(self.directory, VERSION)

    def test_duplicate_zip_members_and_identity(self):
        self.write_asset(extra=[("extension/package.json", "{}")])
        with self.assertRaisesRegex(RuntimeError, "duplicate"):
            release.verify_assets(self.directory, VERSION)
        self.write_asset(manifest="<PackageManifest><Metadata><Identity/><Identity/></Metadata></PackageManifest>")
        with self.assertRaisesRegex(RuntimeError, "Identity"):
            release.verify_assets(self.directory, VERSION)

    def test_reject_symlink_assets_and_checksums(self):
        original = self.path("linux-x64")
        original.unlink()
        original.symlink_to(self.path("linux-arm64"))
        with self.assertRaisesRegex(RuntimeError, "regular file"):
            release.verify_assets(self.directory, VERSION)
        original.unlink()
        self.write_asset()
        (self.directory / "SHA256SUMS").symlink_to(self.path("linux-x64"))
        with self.assertRaisesRegex(RuntimeError, "regular file"):
            release.verify_assets(self.directory, VERSION)

    def test_malformed_archives_and_xml_are_rejected(self):
        self.path("linux-x64").write_bytes(b"not a zip")
        with self.assertRaisesRegex(RuntimeError, "Invalid VSIX"):
            release.verify_assets(self.directory, VERSION)
        for xml in ("<broken>", '<!DOCTYPE x [<!ENTITY x "x">]><PackageManifest/>'):
            self.write_asset(manifest=xml)
            with self.assertRaises(RuntimeError):
                release.verify_assets(self.directory, VERSION)

    def test_changed_asset_never_overwrites_previous_checksums(self):
        release.verify_assets(self.directory, VERSION)
        checksums = (self.directory / "SHA256SUMS").read_bytes()
        self.write_asset(extra=[("extension/changed", "changed")])
        with self.assertRaisesRegex(RuntimeError, "SHA256SUMS"):
            release.verify_assets(self.directory, VERSION)
        self.assertEqual((self.directory / "SHA256SUMS").read_bytes(), checksums)

    def test_invalid_versions(self):
        for version in ("v0.2.0", "01.2.0", "1.2", "1.2.3-beta.1", "1.2.3+build", "1.2.3\n", "../1.2.3"):
            with self.subTest(version=version), self.assertRaisesRegex(RuntimeError, "version"):
                release.verify_assets(self.directory, version)


class PublishTests(AssetFixture):
    def setUp(self):
        super().setUp()
        self.api = FakeGitHub()

    def publish(self, env=None):
        return release.publish(self.api, env or ENV, self.directory, VERSION)

    def test_success_reserves_exact_tested_sha_before_release(self):
        self.api.add_release()
        self.publish()
        self.assertEqual(self.api.mutations[0], ("POST", "git/refs", {
            "ref": "refs/tags/" + TAG, "sha": SHA}))
        self.assertEqual(self.api.mutations[1][0:2], ("POST", "releases"))
        self.assertTrue(self.api.mutations[1][2]["draft"])
        self.assertEqual(self.api.mutations[1][2]["target_commitish"], SHA)
        self.assertEqual(len(self.api.publications), 1)
        self.assertEqual(len(self.api.uploads), 9)
        self.assertEqual(sum(name.endswith(".vsix") for name in self.api.uploads), 8)
        self.assertIn("SHA256SUMS", self.api.uploads)
        self.assertEqual(self.api.mutations[-1], ("PATCH", "releases/1001", {
            "draft": False, "make_latest": "true"}))
        self.assertTrue(all(method in ("POST", "PATCH") for method, _, _ in self.api.mutations))

    def test_dispatch_allowed_but_other_contexts_fail_before_io(self):
        self.publish({**ENV, "GITHUB_EVENT_NAME": "workflow_dispatch"})
        for key, value in (
            ("GITHUB_REPOSITORY", "other/Refyntra"),
            ("GITHUB_EVENT_NAME", "pull_request"),
            ("GITHUB_REF", "refs/heads/feature"),
            ("GITHUB_WORKFLOW_REF", "bitcodepro/Refyntra/.github/workflows/other.yml@refs/heads/main"),
            ("GITHUB_SHA", "main"), ("RELEASE_TAG", "v0.3.0"),
        ):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                release.validate_context({**ENV, key: value}, VERSION)
        with self.assertRaises(RuntimeError):
            release.validate_context({}, VERSION)

    def test_invalid_assets_never_contact_api(self):
        self.path("linux-x64").unlink()
        with self.assertRaises(RuntimeError):
            self.publish()
        self.assertEqual(self.api.calls, [])

    def test_occupied_tag_and_draft_release_are_never_reused(self):
        self.api.refs[TAG] = reference(TAG, SHA)
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            self.publish()
        self.assertEqual(self.api.mutations, [])
        self.api.refs.clear()
        self.api.releases.append({"tag_name": TAG, "draft": True, "prerelease": False})
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            self.publish()
        self.assertEqual(self.api.mutations, [])
        self.assertEqual(self.api.uploads, [])

    def test_stable_version_must_exceed_tags_and_drafts(self):
        for draft in (True, False):
            self.api = FakeGitHub()
            self.api.add_release("v1.0.0", OLD, draft=draft)
            with self.subTest(draft=draft), self.assertRaisesRegex(RuntimeError, "highest stable"):
                self.publish()
            self.assertEqual(self.api.mutations, [])

    def test_duplicate_sha_rejected_even_for_published_prerelease(self):
        for prerelease in (False, True):
            self.api = FakeGitHub()
            self.api.add_release("v0.1.0", SHA, prerelease=prerelease)
            with self.subTest(prerelease=prerelease), self.assertRaisesRegex(
                    release.DuplicateRelease, "new tested main commit"):
                self.publish()
            self.assertEqual(self.api.mutations, [])

    def test_sha_must_remain_ancestor_of_main(self):
        self.api.main = NEW
        self.publish()  # A newer main commit does not invalidate an ancestor build.
        for status, base in (("behind", NEW), ("diverged", OLD), ("ahead", OLD)):
            self.api = FakeGitHub()
            self.api.main = NEW
            self.api.comparisons[(SHA, NEW)] = {
                "status": status, "merge_base_commit": {"sha": base}}
            with self.subTest(status=status), self.assertRaisesRegex(RuntimeError, "ancestor of main"):
                self.publish()
            self.assertEqual(self.api.mutations, [])

    def test_stale_or_divergent_from_published_release_rejected(self):
        for status in ("behind", "diverged"):
            self.api = FakeGitHub()
            self.api.add_release()
            self.api.comparisons[(OLD, SHA)] = {
                "status": status, "merge_base_commit": {"sha": OLD}}
            with self.subTest(status=status), self.assertRaisesRegex(RuntimeError, "older than or diverges"):
                self.publish()
            self.assertEqual(self.api.mutations, [])

    def test_paginated_history_includes_older_release(self):
        for i in range(100):
            self.api.add_release(f"other-{i}", OLD, draft=True)
        self.api.add_release("v0.1.0", SHA)
        with self.assertRaises(release.DuplicateRelease):
            self.publish()
        self.assertTrue(any("page=2" in path for _, path, _ in self.api.calls))

    def test_annotated_tags_are_peeled(self):
        self.api.add_release()
        self.api.refs["v0.1.0"] = reference("v0.1.0", NEW, "tag")
        self.api.objects[NEW] = {"type": "commit", "sha": OLD}
        self.publish()
        self.assertIn(("GET", "git/tags/" + NEW, None), self.api.calls)

    def test_unresolvable_published_tag_fails_closed(self):
        self.api.releases.append({"tag_name": "old-release", "draft": False, "prerelease": False})
        with self.assertRaisesRegex(RuntimeError, "Missing release tag"):
            self.publish()
        self.assertEqual(self.api.mutations, [])

    def test_racing_release_after_reservation_is_not_overwritten(self):
        self.api.after_reserve = lambda api: api.releases.append({"tag_name": TAG, "draft": True})
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            self.publish()
        self.assertEqual(len(self.api.mutations), 1)
        self.assertEqual(self.api.uploads, [])

    def test_newer_stable_after_reservation_blocks_publication(self):
        self.api.after_reserve = lambda api: api.add_release("v1.0.0", NEW)
        with self.assertRaisesRegex(RuntimeError, "highest stable"):
            self.publish()
        self.assertEqual(self.api.uploads, [])
        self.assertIn(TAG, self.api.refs)  # Never delete a reserved tag.

    def test_changed_tag_or_main_after_reservation_blocks_publication(self):
        self.api.after_reserve = lambda api: api.refs.update({TAG: reference(TAG, NEW)})
        with self.assertRaisesRegex(RuntimeError, "tag changed"):
            self.publish()
        self.assertEqual(self.api.uploads, [])
        self.api = FakeGitHub()
        def force_push(api):
            api.main = NEW
            api.comparisons[(SHA, NEW)] = {"status": "diverged", "merge_base_commit": {"sha": OLD}}
        self.api.after_reserve = force_push
        with self.assertRaisesRegex(RuntimeError, "ancestor of main"):
            self.publish()
        self.assertEqual(self.api.uploads, [])

    def test_mutated_asset_after_reservation_blocks_publication(self):
        self.api.after_reserve = lambda api: self.write_asset(extra=[("extension/new", "changed")])
        with self.assertRaisesRegex(RuntimeError, "SHA256SUMS"):
            self.publish()
        self.assertEqual(self.api.uploads, [])

    def test_partial_failure_has_no_cleanup_or_automatic_retry(self):
        def fail(api, item, path):
            raise OSError("Connection reset during upload")
        self.api.before_upload = fail
        with self.assertRaisesRegex(RuntimeError, "Do not move/delete.*replace release assets"):
            self.publish()
        self.assertEqual(len(self.api.uploads), 1)
        self.assertEqual(len(self.api.mutations), 3)
        self.assertTrue(self.api.releases[0]["draft"])
        self.assertIn(TAG, self.api.refs)
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            self.publish()
        self.assertEqual(len(self.api.uploads), 1)
        self.assertEqual(len(self.api.mutations), 3)
        self.assertEqual(self.api.publications, [])

    def test_uncertain_success_hint_never_suggests_releasing_same_sha_again(self):
        def uncertain(api, item):
            item["draft"] = False
            raise OSError("Publish response lost")
        self.api.before_finalize = uncertain
        with self.assertRaisesRegex(RuntimeError, "may have succeeded") as caught:
            self.publish()
        self.assertNotIn("release_version=", str(caught.exception))
        self.assertIn("new tested main commit", str(caught.exception))
        self.assertFalse(self.api.releases[0]["draft"])
        self.assertEqual(sum(method == "PATCH" for method, _, _ in self.api.calls), 1)

    def test_uncertain_draft_create_is_never_retried_or_deleted(self):
        def uncertain(api, item):
            raise OSError("Create response lost")
        self.api.after_create = uncertain
        with self.assertRaisesRegex(RuntimeError, "partial draft"):
            self.publish()
        self.assertEqual(len(self.api.releases), 1)
        self.assertTrue(self.api.releases[0]["draft"])
        self.assertEqual(self.api.uploads, [])
        self.assertEqual(len(self.api.mutations), 2)

    def test_uncertain_tag_create_is_never_retried_or_deleted(self):
        def uncertain(api):
            raise OSError("Tag creation response lost")
        self.api.after_reserve = uncertain
        with self.assertRaisesRegex(RuntimeError, "reserved tag"):
            self.publish()
        self.assertIn(TAG, self.api.refs)
        self.assertEqual(self.api.releases, [])
        self.assertEqual(len(self.api.mutations), 1)

    def test_tag_race_returns_create_failure_without_force_update(self):
        original = self.api.request
        def race(method, path, data=None, **kwargs):
            if method == "POST" and path == "git/refs":
                self.api.refs[TAG] = reference(TAG, NEW)
            return original(method, path, data, **kwargs)
        self.api.request = race
        with self.assertRaisesRegex(RuntimeError, "422"):
            self.publish()
        self.assertEqual(self.api.refs[TAG]["object"]["sha"], NEW)
        self.assertEqual(self.api.releases, [])
        self.assertEqual(len(self.api.mutations), 1)

    def test_uploaded_asset_with_lost_response_is_preserved_without_retry(self):
        original_upload = self.api.upload
        def uncertain(release_id, path):
            original_upload(release_id, path)
            raise OSError("Upload response lost")
        self.api.upload = uncertain
        with self.assertRaisesRegex(RuntimeError, "Upload response lost"):
            self.publish()
        self.assertEqual(len(self.api.uploads), 1)
        self.assertEqual(len(self.api.releases[0]["assets"]), 1)
        self.assertTrue(self.api.releases[0]["draft"])
        self.assertEqual(self.api.publications, [])

    def test_failed_finalization_preserves_complete_draft(self):
        def fail(api, item):
            raise OSError("Finalization rejected")
        self.api.before_finalize = fail
        with self.assertRaisesRegex(RuntimeError, "Finalization rejected"):
            self.publish()
        self.assertEqual(len(self.api.releases[0]["assets"]), 9)
        self.assertTrue(self.api.releases[0]["draft"])
        self.assertEqual(sum(method == "PATCH" for method, _, _ in self.api.calls), 1)

    def test_invalid_new_draft_identity_is_never_uploaded(self):
        self.api.after_create = lambda api, item: item.update(tag_name="v99.0.0")
        with self.assertRaisesRegex(RuntimeError, "draft identity"):
            self.publish()
        self.assertEqual(self.api.uploads, [])

    def test_incomplete_or_extra_remote_assets_block_publication(self):
        def add_extra(api, item, path):
            if not item["assets"]:
                item["assets"].append({"name": "extra"})
        self.api.before_upload = add_extra
        with self.assertRaisesRegex(RuntimeError, "asset set"):
            self.publish()
        self.assertEqual(self.api.publications, [])
        self.assertTrue(self.api.releases[0]["draft"])

    def test_remote_checksum_mismatch_blocks_publication(self):
        original_upload = self.api.upload
        def wrong_checksum(release_id, path):
            item = original_upload(release_id, path)
            item["digest"] = "sha256:" + "0" * 64
            return item
        self.api.upload = wrong_checksum
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            self.publish()
        self.assertEqual(self.api.publications, [])
        self.assertEqual(len(self.api.uploads), 1)

    def test_newer_release_during_upload_blocks_finalization(self):
        def newer(api, item, path):
            if len(api.uploads) == 1:
                api.add_release("v1.0.0", NEW)
        self.api.before_upload = newer
        with self.assertRaisesRegex(RuntimeError, "highest stable"):
            self.publish()
        self.assertEqual(self.api.publications, [])


class ApiTests(AssetFixture):
    def test_only_own_new_draft_can_be_finalized_or_uploaded(self):
        api = release.GitHub(release.REPOSITORY, "test-token")
        with self.assertRaisesRegex(RuntimeError, "newly created draft"):
            api.request("PATCH", "releases/42", {"draft": False, "make_latest": "true"})
        with self.assertRaisesRegex(RuntimeError, "newly created draft"):
            api.upload(42, self.path("linux-x64"))
        with self.assertRaisesRegex(RuntimeError, "destructive"):
            api.request("DELETE", "git/refs/tags/v0.2.0")
        draft = {"id": 42, "tag_name": TAG, "draft": True, "prerelease": False}
        with patch.object(api, "send", return_value=draft):
            api.request("POST", "releases", {"tag_name": TAG})
            api.request("PATCH", "releases/42", {"draft": False, "make_latest": "true"})
        with self.assertRaisesRegex(RuntimeError, "newly created draft"):
            api.request("PATCH", "releases/42", {"tag_name": "other"})

    def test_upload_uses_fixed_host_and_binary_bytes_without_redirects(self):
        api = release.GitHub(release.REPOSITORY, "test-token")
        api.created_release_ids.add(42)
        path = self.path("linux-x64")
        def send(request):
            self.assertEqual(request.full_url,
                f"https://uploads.github.com/repos/bitcodepro/Refyntra/releases/42/assets?name={path.name}")
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.get_header("Content-length"), str(path.stat().st_size))
            self.assertEqual(request.data.read(), path.read_bytes())
            return {}
        with patch.object(api, "send", side_effect=send) as mocked:
            api.upload(42, path)
        self.assertEqual(mocked.call_count, 1)
        with self.assertRaisesRegex(RuntimeError, "redirect"):
            release.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.invalid")


if __name__ == "__main__":
    unittest.main()
