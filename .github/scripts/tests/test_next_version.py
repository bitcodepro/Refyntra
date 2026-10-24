import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('version', Path(__file__).parents[1] / 'next-version.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class VersionTests(unittest.TestCase):
    def test_first_release_uses_manifest(self):
        self.assertEqual(v.select([], '[major]', '0.1.0'), ('0.1.0', False))

    def test_numeric_order_and_prerelease_ignored(self):
        self.assertEqual(v.select(['v1.9.0', 'v1.10.2', 'v9.0.0-rc.1', 'v01.2.3'], '', '0.1.0'), ('1.10.3', False))

    def test_bumps(self):
        for subject, expected in [('[minor] feature', '1.3.0'), ('feature #minor', '1.3.0'), ('[major] breaking', '2.0.0'), ('#MAJOR', '2.0.0'), ('fix', '1.2.4'), ('fix\n[major]', '1.2.4')]:
            with self.subTest(subject=subject):
                self.assertEqual(v.select(['v1.2.3'], subject, '0.1.0'), (expected, False))

    def test_skip_only_subject(self):
        self.assertEqual(v.select([], '[skip release]', '0.1.0'), ('0.1.0', True))
        self.assertEqual(v.select([], 'fix\n[skip release]', '0.1.0'), ('0.1.0', False))

    def test_override(self):
        self.assertEqual(v.select(['v1.2.3'], '[skip release]', '0.1.0', '2.0.0'), ('2.0.0', False))
        for bad in ['1.2.3', '1.0.0', 'v2.0.0', '2.01.0', '2.0.0-rc.1', '2.0.0\n', '../2.0.0']:
            with self.subTest(version=bad), self.assertRaises(ValueError):
                v.select(['v1.2.3'], '', '0.1.0', bad)

    def test_stamp_changes_only_version(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'package.json'
            original = {'name': 'refyntra', 'version': '0.1.0', 'scripts': {'test': 'original'}}
            path.write_text(json.dumps(original))
            v.stamp(path, '1.2.3')
            self.assertEqual(json.loads(path.read_text()), {**original, 'version': '1.2.3'})
            with self.assertRaises(ValueError):
                v.stamp(path, 'invalid')
            self.assertEqual(json.loads(path.read_text())['version'], '1.2.3')


    def test_stamp_host_changes_only_the_version_element(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'Refyntra.Host.csproj'
            template = '<Project>\n  <PropertyGroup>\n    <Version>{}</Version>\n    <LangVersion>latest</LangVersion>\n  </PropertyGroup>\n</Project>\n'
            path.write_text(template.format('0.1.0'))
            v.stamp_host(path, '1.2.3')
            self.assertEqual(path.read_text(), template.format('1.2.3'))
            with self.assertRaises(ValueError):
                v.stamp_host(path, '1.2')
            path.write_text('<Project />')
            with self.assertRaises(ValueError):
                v.stamp_host(path, '1.2.4')


class VersionCliTests(unittest.TestCase):
    def test_git_subject_outputs_stamp_and_untrusted_context(self):
        import os
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / 'packages/extension/package.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text('{"name":"refyntra","version":"0.1.0"}')
            def git(*args):
                return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True, text=True)
            git('init')
            git('config', 'user.email', 'test@example.invalid')
            git('config', 'user.name', 'Policy Test')
            git('add', '.')
            git('commit', '-m', '[minor] feature\n\n[major] ignored body')
            git('tag', 'v1.2.3')
            output = root / 'output'
            env = {**os.environ, 'GITHUB_REPOSITORY': 'bitcodepro/Refyntra', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'push', 'GITHUB_OUTPUT': str(output), 'RELEASE_VERSION': ''}
            script = str(Path(v.__file__).resolve())
            subprocess.run([sys.executable, script], cwd=root, env=env, check=True, capture_output=True)
            self.assertEqual(output.read_text(), 'version=1.3.0\ntag=v1.3.0\nskip=false\n')
            subprocess.run([sys.executable, script, '--stamp', '1.3.0'], cwd=root, check=True)
            self.assertEqual(json.loads(manifest.read_text())['version'], '1.3.0')
            output.write_text('')
            env['GITHUB_EVENT_NAME'] = 'pull_request'
            env['RELEASE_VERSION'] = '99.0.0'
            subprocess.run([sys.executable, script], cwd=root, env=env, check=True, capture_output=True)
            self.assertEqual(output.read_text(), 'version=1.3.0\ntag=v1.3.0\nskip=true\n')
