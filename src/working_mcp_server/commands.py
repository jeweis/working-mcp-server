"""Shell-free search and Git queries. No caller-controlled executable or flags."""
from __future__ import annotations
import asyncio
import fnmatch
import os
import subprocess
import sys
from pathlib import Path
from .state import State


async def capture(args, cwd, accepted=(0,), max_bytes=51200):
    env = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0', 'GIT_PAGER': 'cat', 'GIT_TERMINAL_PROMPT': '0'}
    env.pop('WORKING_MCP_API_KEY', None)
    env.pop('WORKING_MCP_ADMIN_TOKEN', None)
    child = await asyncio.create_subprocess_exec(*args, cwd=cwd, env=env,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        **({'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}))
    async def bounded(stream):
        result = bytearray()
        truncated = False
        while chunk := await stream.read(8192):
            available = max_bytes - len(result)
            result.extend(chunk[:max(0, available)])
            truncated |= len(chunk) > available
        return result.decode('utf-8', errors='replace'), truncated
    tasks = [asyncio.create_task(bounded(child.stdout)), asyncio.create_task(bounded(child.stderr))]
    try:
        await asyncio.wait_for(child.wait(), 30)
        (stdout, truncated), (stderr, _) = await asyncio.gather(*tasks)
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    if child.returncode not in accepted:
        raise ValueError(stderr.strip() or f'Command exited with {child.returncode}')
    return {'output': stdout, 'truncated': truncated, 'exit_code': child.returncode}


def revision(value):
    if not value or value.startswith('-') or '\x00' in value:
        raise ValueError('Invalid Git revision')
    return value


async def search(workspace, pattern, path='.', include=None, fixed=False, ignore_case=False, hidden=False, ignored=False, context=0, filenames=False):
    root = Path(workspace['absolute_path'])
    target = State.path(workspace, path)
    if not 0 <= context <= 10:
        raise ValueError('context must be 0..10')
    args = ['rg', '--color=never', '--glob=!.git/**']
    if filenames:
        args += ['--files']
    else:
        args += ['--line-number', '--with-filename', '--max-columns=2000', '--max-columns-preview', '-C', str(context)]
        if fixed:
            args.append('--fixed-strings')
        if ignore_case:
            args.append('--ignore-case')
        if include:
            args += ['--type-add', f'working:{include}', '--type', 'working']
        args += ['-e', pattern]
    if hidden:
        args.append('--hidden')
    if ignored:
        args.append('--no-ignore')
    args += ['--', str(target.relative_to(root))]
    result = await capture(args, root, accepted=(0, 1), max_bytes=2_000_000 if filenames else 51200)
    if filenames:
        if result['truncated']:
            raise ValueError('Too many files to discover; narrow path')
        paths = [line for line in result['output'].splitlines() if fnmatch.fnmatchcase(line.removeprefix('./'), pattern)
                 or (pattern.startswith('**/') and fnmatch.fnmatchcase(line.removeprefix('./'), pattern[3:]))]
        output = '\n'.join(sorted(paths))
        raw = output.encode()
        result.update(output=raw[:51200].decode('utf-8', errors='ignore'), truncated=len(raw) > 51200)
    return result


async def git(workspace, operation, **options):
    root = Path(workspace['absolute_path'])
    repository = await capture(['git', 'rev-parse', '--show-toplevel'], root)
    if Path(repository['output'].strip()).resolve() != root:
        raise ValueError('Add the Git repository root as a workspace before querying Git')
    # Disable repository-defined fsmonitor, external diff drivers, text conversion,
    # and optional index updates for all read-only queries.
    args = ['git', '--literal-pathspecs', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
            '-c', 'diff.external=', '-c', 'core.quotePath=false', operation]
    path = options.get('path')
    if path:
        path = str(State.path(workspace, path).relative_to(root))
    if operation == 'status':
        args += ['--short', '--branch', '--untracked-files=normal']
    elif operation == 'diff':
        args += ['--no-ext-diff', '--no-textconv', '--no-color']
        if options.get('staged'):
            args.append('--cached')
        for name in ('base', 'head'):
            if options.get(name):
                args.append(revision(options[name]))
        args += ['--']
        if path:
            args.append(path)
    elif operation == 'log':
        limit, offset = options.get('limit', 20), options.get('offset', 0)
        if not 1 <= limit <= 100 or offset < 0:
            raise ValueError('limit must be 1..100 and offset >= 0')
        args += [f'--max-count={limit}', f'--skip={offset}', '--format=%H %aI %an%n%s%n']
        for name, flag in [('author', '--author'), ('since', '--since'), ('until', '--until'), ('message', '--grep')]:
            if options.get(name):
                args.append(f'{flag}={options[name]}')
        args += ['--']
        if path:
            args.append(path)
    elif operation == 'show':
        args += ['--no-ext-diff', '--no-textconv', '--no-color']
        ref = revision(options.get('revision', 'HEAD'))
        if ':' in ref:
            raise ValueError('Use path to select a file, not a revision:path expression')
        args += [f'{ref}:{path}' if path else ref, '--']
    return await capture(args, root)
