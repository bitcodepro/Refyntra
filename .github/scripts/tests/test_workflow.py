"""Regression checks for release gates; PyYAML is pinned in the policy job."""
from pathlib import Path
import unittest
import yaml


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).parents[3]
        cls.workflow = yaml.safe_load((cls.root / '.github/workflows/ci.yml').read_text())
        cls.jobs = cls.workflow['jobs']

    def test_only_publisher_can_write(self):
        self.assertEqual(self.workflow['permissions'], {'contents': 'read'})
        for name, job in self.jobs.items():
            if name == 'release':
                self.assertEqual(job['permissions'], {'contents': 'write'})
            else:
                self.assertNotIn('permissions', job)

    def test_all_gates_required(self):
        self.assertEqual(set(self.jobs['release']['needs']), {'release-policy', 'version', 'windows', 'ubuntu', 'package', 'verify-packages'})
        condition = self.jobs['release']['if']
        for required in ["github.repository == 'bitcodepro/Refyntra'", "github.ref == 'refs/heads/main'", "github.event_name == 'push'", "needs.version.outputs.skip != 'true'"]:
            self.assertIn(required, condition)
        self.assertNotIn('always()', condition)
        self.assertNotIn('continue-on-error', (self.root / '.github/workflows/ci.yml').read_text())

    def test_serial_main_not_cancelled(self):
        self.assertEqual(self.workflow['concurrency']['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}")
        self.assertFalse(self.jobs['release']['concurrency']['cancel-in-progress'])

    def test_checkout_exact_sha_without_credentials(self):
        for job in self.jobs.values():
            for step in job['steps']:
                if step.get('uses', '').startswith('actions/checkout@'):
                    self.assertEqual(step['with']['ref'], '${{ github.sha }}')
                    self.assertFalse(step['with']['persist-credentials'])

    def test_all_builds_use_same_version(self):
        for name in ['windows', 'ubuntu', 'package']:
            job = self.jobs[name]
            self.assertEqual(job['needs'], 'version')
            stamp = next(s for s in job['steps'] if s.get('name') == 'Stamp tested package version')
            self.assertEqual(stamp['env']['RELEASE_VERSION'], '${{ needs.version.outputs.version }}')
            self.assertIn('--stamp "$RELEASE_VERSION"', stamp['run'])

    def test_exact_eight_targets_and_no_wildcard_upload(self):
        self.assertEqual(set(self.jobs['package']['strategy']['matrix']['target']), {'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'alpine-x64', 'darwin-x64', 'darwin-arm64', 'universal'})
        upload = next(s for s in self.jobs['package']['steps'] if s.get('name') == 'Upload VSIX')
        self.assertNotIn('*', upload['with']['path'])
        self.assertIn('needs.version.outputs.version', upload['with']['path'])
        self.assertNotIn('refyntra-0.1.0', str(self.workflow))

    def test_existing_test_suites_preserved(self):
        commands = '\n'.join(s.get('run', '') for s in self.jobs['windows']['steps'])
        for command in ['pnpm test:unit', 'pnpm test:architecture', 'dotnet test src/dotnet/Refyntra.sln -c Release --no-build', 'pnpm test:integration', 'pnpm audit:vsix', 'pnpm test:install']:
            self.assertIn(command, commands)
