"""Owned subprocess groups with bounded logs and explicit cleanup."""
from __future__ import annotations
import asyncio
import os
import signal
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass, field

LOG_LIMIT = 1_000_000


@dataclass
class Process:
    id: str
    workspace: dict
    command: str
    child: asyncio.subprocess.Process
    output: bytearray = field(default_factory=bytearray)
    base: int = 0
    reader: asyncio.Task | None = None
    job: object | None = None


class Processes:
    def __init__(self):
        self.items: dict[str, Process] = {}

    async def start(self, workspace, command, cwd):
        if len([p for p in self.items.values() if p.child.returncode is None]) >= 32:
            raise ValueError('Maximum 32 running processes')
        # Completed handles are retained up to a bounded history size.
        for key in list(self.items):
            if len(self.items) < 200:
                break
            if self.items[key].child.returncode is not None:
                if self.items[key].job is not None:
                    self.items[key].job.close()
                del self.items[key]
        env = os.environ.copy()
        env.pop('WORKING_MCP_API_KEY', None)
        env.pop('WORKING_MCP_ADMIN_TOKEN', None)
        # Windows CreateProcess searches System32 before PATH for a bare name,
        # where bash.exe may be the WSL launcher. Resolve our bundled Git Bash
        # first and pass its absolute path so WSL is never chosen implicitly.
        bash = shutil.which('bash')
        if not bash:
            raise ValueError('Bash is unavailable; install Git Bash or use the desktop application')
        child = await asyncio.create_subprocess_exec(bash, '--noprofile', '--norc', '-c', command,
            cwd=cwd, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL,
            **({'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {'start_new_session': True}))
        item = Process('proc_' + uuid.uuid4().hex[:12], workspace.copy(), command, child)
        if sys.platform == 'win32':
            from .windows_job import WindowsJob
            try:
                item.job = WindowsJob(child.pid)
            except OSError as error:
                # A very short command may have exited before assignment.
                # If it is still running, refuse to leave an unowned process.
                try:
                    await asyncio.wait_for(asyncio.shield(child.wait()), 0.05)
                except TimeoutError:
                    child.kill()
                    await child.wait()
                    raise error
        self.items[item.id] = item
        async def drain():
            while chunk := await child.stdout.read(8192):
                item.output.extend(chunk)
                if len(item.output) > LOG_LIMIT:
                    removed = len(item.output) - LOG_LIMIT
                    del item.output[:removed]
                    item.base += removed
            await child.wait()
        item.reader = asyncio.create_task(drain())
        return item

    def get(self, process_id):
        if process_id not in self.items:
            raise ValueError('Unknown process ID; use process_list')
        return self.items[process_id]

    def snapshot(self, item, cursor=0, limit=51200):
        if cursor < 0 or not 1 <= limit <= 51200:
            raise ValueError('cursor >= 0 and limit 1..51200 required')
        end = item.base + len(item.output)
        if cursor > end:
            raise ValueError('Cursor is past the end of output')
        start = max(cursor, item.base)
        data = bytes(item.output[start - item.base:start - item.base + limit])
        return {'process_id': item.id, 'command': item.command,
                'status': 'running' if item.child.returncode is None else 'exited',
                'exit_code': item.child.returncode, 'output': data.decode('utf-8', errors='replace'),
                'next_cursor': start + len(data), 'output_lost': cursor < item.base,
                'has_more': start + len(data) < end}

    async def stop(self, item):
        if item.job is not None:
            item.job.terminate()
            await item.child.wait()
            if item.reader:
                await asyncio.wait_for(asyncio.shield(item.reader), 5)
            return
        if item.child.returncode is not None and item.reader and item.reader.done():
            return
        if sys.platform == 'win32':
            # taskkill terminates the descendant tree; CREATE_NO_WINDOW keeps
            # packaged desktop runs from flashing console windows.
            killer = await asyncio.create_subprocess_exec('taskkill', '/PID', str(item.child.pid), '/T', '/F',
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW)
            await killer.wait()
            if item.child.returncode is None:
                await item.child.wait()
            if item.reader:
                await asyncio.wait_for(asyncio.shield(item.reader), 5)
            return
        # Kill the group even if its shell exited but left descendants behind.
        try:
            os.killpg(item.child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(asyncio.shield(item.child.wait()), 2)
        except TimeoutError:
            pass
        try:
            os.killpg(item.child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await item.child.wait()
        if item.reader:
            await asyncio.wait_for(asyncio.shield(item.reader), 3)

    async def stop_all(self):
        await asyncio.gather(*(self.stop(item) for item in self.items.values()))
