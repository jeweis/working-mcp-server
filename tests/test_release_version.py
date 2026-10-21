import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('release_version', Path(__file__).resolve().parents[1] / 'scripts/release_version.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


def test_first_release_uses_package_version():
    assert release.choose_version('0.1.0', [], []) == '0.1.0'


def test_increment_highest_stable_tag_numerically():
    assert release.choose_version('0.1.0', ['v0.1.9', 'v0.1.10', 'v9.0.0-beta.1', 'unrelated'], []) == '0.1.11'


def test_retry_reuses_tag_on_same_commit():
    assert release.choose_version('0.1.0', ['v0.2.0', 'v0.2.1'], ['v0.2.0']) == '0.2.0'


def test_manual_version_bump_is_respected():
    assert release.choose_version('0.2.0', ['v0.1.7'], []) == '0.2.0'
