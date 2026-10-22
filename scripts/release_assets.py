"""Verify a complete release and generate download checksums."""
import argparse
import hashlib
import os
import re
from pathlib import Path


def verify(root: Path, expected_version=None):
    metadata = ['latest.yml', 'latest-arm64-mac.yml', 'latest-x64-mac.yml']
    versions = []
    for name in metadata:
        first = (root / name).read_text(encoding='utf-8').splitlines()[0]
        key, _, value = first.partition(':')
        value = value.strip().strip('\"\'')
        if key != 'version' or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
            raise ValueError(f'Invalid update version in {name}')
        versions.append(value)
    if len(set(versions)) != 1 or (expected_version and versions[0] != expected_version):
        raise ValueError('Installer update metadata versions disagree')
    version = versions[0]
    prefix = 'Working-MCP-' + version
    expected = {
        prefix + '-mac-arm64.dmg', prefix + '-mac-arm64.zip',
        prefix + '-mac-x64.dmg', prefix + '-mac-x64.zip',
        prefix + '-win-x64-setup.exe', prefix + '-win-x64-portable.exe', prefix + '-win-x64.zip',
        *metadata,
    }
    actual = {p.name for p in root.iterdir() if p.is_file()} - {'SHA256SUMS.txt'}
    if actual != expected:
        raise ValueError(f'Unexpected installer set: missing={expected-actual}, extra={actual-expected}')
    lines = []
    for name in sorted(expected):
        if (root / name).stat().st_size <= 0:
            raise ValueError(f'Empty release artifact: {name}')
        with (root / name).open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        lines.append(f'{digest}  {name}\n')
    (root / 'SHA256SUMS.txt').write_text(''.join(lines), encoding='utf-8')
    return version


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', default='installers')
    parser.add_argument('--version')
    args = parser.parse_args()
    version = verify(Path(args.directory), args.version)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
            stream.write(f'version={version}\ntag=v{version}\n')
    print(f'Verified all 7 installers and 3 update manifests for v{version}')


if __name__ == '__main__':
    main()
