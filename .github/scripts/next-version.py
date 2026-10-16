"""Select one stable VSIX version before all builds; never commit a version bump."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


PATTERN = r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'


def stable(value):
    match = re.fullmatch(PATTERN, value)
    if not match:
        raise ValueError('VSIX version must be stable X.Y.Z without leading zeroes.')
    return tuple(map(int, match.groups()))


def select(tags, subject, current, override=''):
    stable(current)
    versions = [stable(t[1:]) for t in tags if re.fullmatch('v' + PATTERN, t)]
    latest = max(versions) if versions else None
    if override:
        version = stable(override)
        if 'v' + override in tags or (latest is not None and version <= latest):
            raise ValueError('Explicit version must be unused and above all stable tags.')
        return override, False
    subject = subject.splitlines()[0] if subject else ''
    if re.search(r'\[skip release\]', subject, re.I):
        return current, True
    if latest is None:
        return current, False
    major, minor, patch = latest
    if re.search(r'\[major\]|#major', subject, re.I):
        return f'{major + 1}.0.0', False
    if re.search(r'\[minor\]|#minor', subject, re.I):
        return f'{major}.{minor + 1}.0', False
    return f'{major}.{minor}.{patch + 1}', False


def stamp(path, version):
    stable(version)
    data = json.loads(path.read_text(encoding='utf-8'))
    data['version'] = version
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stamp', metavar='VERSION')
    args = parser.parse_args()
    path = Path('packages/extension/package.json')
    if args.stamp:
        stamp(path, args.stamp)
        return
    current = json.loads(path.read_text(encoding='utf-8'))['version']
    stable(current)
    trusted = (os.environ.get('GITHUB_REPOSITORY') == 'bitcodepro/Refyntra'
               and os.environ.get('GITHUB_REF') == 'refs/heads/main'
               and os.environ.get('GITHUB_EVENT_NAME') in ('push', 'workflow_dispatch'))
    version, skip = current, True
    if trusted:
        tags = subprocess.check_output(['git', 'tag', '--list', 'v*'], text=True).splitlines()
        # Read the tested commit itself, not an interpolated event/PR message.
        subject = subprocess.check_output(['git', 'log', '-1', '--format=%s'], text=True)
        version, skip = select(tags, subject, current, os.environ.get('RELEASE_VERSION', ''))
    output = f'version={version}\ntag=v{version}\nskip={str(skip).lower()}\n'
    print(output, end='')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as file:
            file.write(output)


if __name__ == '__main__':
    main()
