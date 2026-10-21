"""Build an OS-native backend with its Python runtime included."""
import os
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
subprocess.run([
    sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
    '--name', 'working-mcp-backend', '--distpath', str(root / 'build' / 'desktop-resources' / 'backend-dist'),
    '--workpath', str(root / 'build' / 'pyinstaller'), '--specpath', str(root / 'build'),
    '--paths', str(root / 'src'),
    '--add-data', str(root / 'src' / 'working_mcp_server' / 'static') + os.pathsep + 'working_mcp_server/static',
    '--collect-all', 'fastmcp', '--collect-data', 'mcp', '--collect-all', 'mcp_types',
    '--collect-submodules', 'mcp.server', '--collect-submodules', 'mcp.client', '--collect-submodules', 'mcp.shared',
    '--collect-submodules', 'uvicorn', '--collect-submodules', 'key_value',
    '--recursive-copy-metadata', 'fastmcp',
    str(root / 'desktop' / 'backend-entry.py'),
], cwd=root, check=True, env={**os.environ, 'PYINSTALLER_CONFIG_DIR': str(root / 'build' / 'pyinstaller-cache')})
