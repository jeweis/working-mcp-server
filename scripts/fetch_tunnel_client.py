"""Download an official tunnel-client release and verify its published SHA-256."""
import hashlib
import io
import json
import os
import platform
import re
import shutil
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / 'build' / 'desktop-resources' / 'tunnel'


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'working-mcp-desktop'})
    return urllib.request.urlopen(request, timeout=120)


def main():
    system = {'Darwin': 'darwin', 'Windows': 'windows', 'Linux': 'linux'}[platform.system()]
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'amd64', 'AMD64': 'amd64'}[platform.machine()]
    # Resolve the latest release without depending on an authenticated GitHub API.
    tag = fetch('https://github.com/openai/tunnel-client/releases/latest').url.rsplit('/', 1)[-1]
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag):
        raise RuntimeError('Unexpected official tunnel-client release identifier')
    manifest = DESTINATION / 'version.json'
    suffix = '.exe' if system == 'windows' else ''
    if manifest.exists():
        cached = json.loads(manifest.read_text(encoding='utf-8'))
        if cached.get('tag') == tag and cached.get('system') == system and cached.get('arch') == arch and (DESTINATION / ('tunnel-client' + suffix)).exists():
            print(f'Official tunnel-client {tag} already prepared for {system}/{arch}')
            return
    filename = f'tunnel-client-{tag}-{system}-{arch}.zip'
    base = f'https://github.com/openai/tunnel-client/releases/download/{tag}/'
    sums = fetch(base + 'SHA256SUMS.txt').read().decode('utf-8')
    expected = next(line.split()[0] for line in sums.splitlines() if line.split()[-1].lstrip('*') == filename)
    payload = fetch(base + filename).read()
    if hashlib.sha256(payload).hexdigest() != expected:
        raise RuntimeError('Official tunnel-client checksum mismatch')
    temporary = DESTINATION.with_name('tunnel-download')
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir(parents=True)
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for member in archive.infolist():
                target = (temporary / member.filename).resolve()
                if not target.is_relative_to(temporary.resolve()):
                    raise RuntimeError('Unsafe archive path')
            archive.extractall(temporary)
        for name in ('tunnel-client', 'cloudflared'):
            executable = temporary / (name + suffix)
            if executable.exists() and system != 'windows':
                executable.chmod(0o755)
        if not (temporary / ('tunnel-client' + suffix)).is_file():
            raise RuntimeError('Official archive did not contain tunnel-client')
        (temporary / 'version.json').write_text(json.dumps({'tag': tag, 'system': system, 'arch': arch, 'sha256': expected}), encoding='utf-8')
        shutil.rmtree(DESTINATION, ignore_errors=True)
        os.replace(temporary, DESTINATION)
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
    print(f'Verified official tunnel-client {tag} for {system}/{arch}')


if __name__ == '__main__':
    main()
