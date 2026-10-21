"""Choose a stable release tag; retrying a tagged commit reuses its version."""
import json
import os
import re
import subprocess
from pathlib import Path

VERSION = re.compile(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")


def parse(value):
    match = VERSION.fullmatch(value)
    return tuple(map(int, match.groups())) if match else None


def choose_version(base, tags, head_tags):
    baseline = parse(base)
    if baseline is None:
        raise ValueError(f"Invalid package version: {base}")
    # Only v-prefixed stable release tags belong to this workflow.
    versions = [parse(tag) for tag in tags if tag.startswith('v') and parse(tag)]
    existing = [parse(tag) for tag in head_tags if tag.startswith('v') and parse(tag)]
    if existing:
        chosen = max(existing)
    elif versions:
        major, minor, patch = max(versions)
        chosen = max(baseline, (major, minor, patch + 1))
    else:
        chosen = baseline
    return '.'.join(map(str, chosen))


def main():
    root = Path(__file__).resolve().parents[1]
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=root, text=True).splitlines()
    base = json.loads((root / 'package.json').read_text())['version']
    version = choose_version(base, git('tag', '--list'), git('tag', '--points-at', 'HEAD'))
    output = f'version={version}\ntag=v{version}\n'
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
            stream.write(output)
    print(output, end='')


if __name__ == '__main__':
    main()
