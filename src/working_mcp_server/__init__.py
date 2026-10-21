"""CLI and desktop-owned FastMCP server entry point."""
import argparse
import errno
import json
import os
import shutil
import socket
import sys
import threading
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='Programming MCP server with a local management UI')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--read-only', action='store_true')
    parser.add_argument('--config', type=Path)
    parser.add_argument('--desktop', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    from platformdirs import user_config_path
    from .state import State
    from .credentials import Credentials
    from .server import Application
    import uvicorn
    config = args.config or user_config_path('working-mcp-server') / 'config.json'
    admin_token = os.environ.pop('WORKING_MCP_ADMIN_TOKEN', '') if args.desktop else None
    if args.desktop and (not admin_token or args.host != '127.0.0.1'):
        parser.error('Desktop mode requires an internal administration token and loopback binding')
    store = None
    try:
        if args.desktop:
            store = Credentials(config.parent / 'credentials.json')
            key = store.key
        else:
            key = os.environ.get('WORKING_MCP_API_KEY', '')
            if not key:
                parser.error('Set WORKING_MCP_API_KEY before starting the server')
        for executable in ('bash', 'git', 'rg'):
            if not shutil.which(executable):
                parser.error(f'Required executable not found: {executable}')
        state = State(config, Path.cwd(), args.read_only)
        application = Application(state, key, admin_token=admin_token, credentials=store)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    if not args.desktop:
        print(f'Management: http://{args.host}:{args.port}/admin')
        print(f'MCP: http://{args.host}:{args.port}/mcp')
        uvicorn.run(application.app, host=args.host, port=args.port)
        return
    # Binding before announcing the port avoids the pick-a-free-port race.
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind((args.host, args.port))
    except OSError as error:
        if error.errno != errno.EADDRINUSE:
            raise
        listener.bind((args.host, 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(application.app, host=args.host, port=port, log_level='warning'))
    def parent_pipe():
        # Gracefully stop both when Electron asks and when its pipe closes
        # unexpectedly (including a main-process crash).
        for line in sys.stdin:
            if line.strip() == 'shutdown':
                break
        server.should_exit = True
    threading.Thread(target=parent_pipe, daemon=True).start()
    print(json.dumps({'event': 'ready', 'port': port}), flush=True)
    try:
        server.run(sockets=[listener])
    finally:
        listener.close()
