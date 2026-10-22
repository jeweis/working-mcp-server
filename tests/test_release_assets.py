import hashlib
import importlib.util
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location('release_assets', Path(__file__).resolve().parents[1] / 'scripts/release_assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


def fixture(root):
    for suffix in ['mac-arm64.dmg','mac-arm64.zip','mac-x64.dmg','mac-x64.zip','win-x64-setup.exe','win-x64-portable.exe','win-x64.zip']:
        (root / ('Working-MCP-0.1.1-'+suffix)).write_bytes(b'installer fixture')
    for name in ['latest.yml','latest-arm64-mac.yml','latest-x64-mac.yml']:
        (root / name).write_text('version: 0.1.1\nfiles: []\n')


def test_complete_release_checksums_are_repeatable(tmp_path):
    fixture(tmp_path)
    assert assets.verify(tmp_path,'0.1.1') == '0.1.1'
    first = (tmp_path/'SHA256SUMS.txt').read_text()
    assert len(first.splitlines()) == 10
    assert hashlib.sha256(b'installer fixture').hexdigest() in first
    assets.verify(tmp_path)
    assert (tmp_path/'SHA256SUMS.txt').read_text() == first


def test_debug_and_unknown_files_are_never_silently_published(tmp_path):
    fixture(tmp_path)
    (tmp_path/'builder-debug.yml').write_text('build diagnostics')
    with pytest.raises(ValueError,match='extra='):
        assets.verify(tmp_path)


def test_cross_architecture_version_mismatch_is_rejected(tmp_path):
    fixture(tmp_path)
    (tmp_path/'latest-x64-mac.yml').write_text('version: 0.1.2\n')
    with pytest.raises(ValueError,match='versions disagree'):
        assets.verify(tmp_path)
