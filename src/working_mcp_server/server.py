"""FastMCP tools and the authenticated local management application."""
import asyncio
import functools
import hmac
import inspect
import json
import uuid
import weakref
from contextlib import asynccontextmanager
from pathlib import Path

from fastmcp import FastMCP, Context
from fastmcp.dependencies import CurrentContext
from fastmcp.server.auth import TokenVerifier, AccessToken
from fastmcp.tools import ToolResult
from fastmcp.server.transforms import Transform
from fastmcp.server.middleware import Middleware
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from pydantic import BaseModel, ConfigDict, Field

from .state import State
from .files import Files
from .processes import Processes
from .commands import search, git

WRITE_TOOLS = {'write', 'edit', 'bash', 'process_list', 'process_output', 'process_stop'}


class ModeGuard(Middleware):
    """Return workspace metadata even for cached calls to disabled tools."""
    def __init__(self, application):
        self.application = application

    async def on_call_tool(self, context, call_next):
        app = self.application
        if app.state.data['read_only'] and context.message.name in WRITE_TOOLS:
            arguments = context.message.arguments or {}
            workspace = app.state.default().copy()
            sid = arguments.get('session_id', '')
            try:
                sid = app.resolve_session(sid, context.fastmcp_context)
                workspace = app.state.current(sid)
                error = 'Read-only mode: this tool is disabled'
            except ValueError as exception:
                error = str(exception)
            payload = {'workspace': workspace, 'session_id': sid, 'error': error}
            return ToolResult(content=json.dumps(payload, ensure_ascii=False), structured_content=payload, is_error=True)
        return await call_next(context)


class ModeVisibility(Transform):
    """Read the live mode without accumulating a transform per toggle."""
    def __init__(self, state):
        self.state = state

    async def list_tools(self, tools):
        return [tool for tool in tools if not self.state.data['read_only'] or tool.name not in WRITE_TOOLS]

    async def get_tool(self, name, call_next, *, version=None):
        if self.state.data['read_only'] and name in WRITE_TOOLS:
            return None
        return await call_next(name, version=version)


class Edit(BaseModel):
    old_text: str = Field(min_length=1)
    new_text: str
    model_config = ConfigDict(extra='forbid')


class KeyVerifier(TokenVerifier):
    def __init__(self, get_key):
        super().__init__()
        self.get_key = get_key

    async def verify_token(self, token):
        if hmac.compare_digest(token.encode(), self.get_key().encode()):
            return AccessToken(token=token, client_id='working-mcp-admin', scopes=[])
        return None


class Application:
    def __init__(self, state: State, api_key: str, *, admin_token: str | None = None, credentials=None):
        if not api_key:
            raise ValueError('WORKING_MCP_API_KEY must be set')
        self.state, self.api_key = state, api_key
        self.admin_token, self.credentials = admin_token, credentials
        self.files, self.processes = Files(), Processes()
        self.sessions: set[str] = set()
        self.connections = weakref.WeakValueDictionary()
        self.mcp = FastMCP('working-mcp-server', auth=KeyVerifier(lambda: self.api_key), instructions=(
            'Programming tools scoped to configured workspaces. Every result includes workspace and session_id. '
            'On stateless clients, call workspace_current first and pass the returned session_id to subsequent tools. '
            'Use read before edit/write on existing files. bash is an unsandboxed Bash command runner.'))
        self.register_tools()
        self.mcp.add_transform(ModeVisibility(self.state))
        self.mcp.add_middleware(ModeGuard(self))
        self.app = self.make_http_app()

    def resolve_session(self, supplied, ctx):
        if supplied:
            if supplied not in self.sessions:
                raise ValueError('Unknown session_id; call workspace_current without session_id to start a session')
            return supplied
        # Legacy connections have a stable negotiated ID. Modern requests each
        # get a new ID, which is explicitly returned for the caller to reuse.
        identifier = ctx.session_id if ctx else 'session_' + uuid.uuid4().hex
        self.sessions.add(identifier)
        return identifier

    def register_tools(self):
        def tool(function):
            signature = inspect.signature(function)
            name = function.__name__
            @functools.wraps(function)
            async def wrapped(*args, **kwargs):
                ctx = kwargs.pop('ctx', None)
                supplied = kwargs.pop('session_id', '')
                sid = supplied
                workspace = self.state.default().copy()
                try:
                    sid = self.resolve_session(supplied, ctx)
                    if ctx:
                        self.connections[ctx.session_id] = ctx.session
                    workspace = self.state.current(sid)
                    if name in {'process_output', 'process_stop'}:
                        workspace = self.processes.get(kwargs['process_id']).workspace.copy()
                    if name in WRITE_TOOLS:
                        async with self.state.lock:
                            if self.state.data['read_only']:
                                raise ValueError('Read-only mode: this tool is disabled')
                            # File mutations and process creation must settle
                            # before a mode transition obtains the same lock.
                            if name == 'bash':
                                item = await self.start_bash(workspace, **kwargs)
                            else:
                                result = await function(workspace, sid, *args, **kwargs)
                        if name == 'bash':
                            result = await self.wait_bash(item, kwargs.get('background', False), kwargs.get('timeout', 30))
                    else:
                        result = await function(workspace, sid, *args, **kwargs)
                    if name == 'workspace_switch':
                        workspace = self.state.current(sid)
                    if name in {'process_output', 'process_stop'}:
                        workspace = self.processes.get(kwargs['process_id']).workspace.copy()
                    return {'workspace': workspace, 'session_id': sid, 'result': result}
                except (ValueError, OSError, UnicodeError, TimeoutError) as error:
                    payload = {'workspace': workspace, 'session_id': sid, 'error': str(error)}
                    return ToolResult(content=json.dumps(payload, ensure_ascii=False), structured_content=payload, is_error=True)
            params = list(signature.parameters.values())[2:]
            params += [inspect.Parameter('session_id', inspect.Parameter.KEYWORD_ONLY, default='', annotation=str),
                       inspect.Parameter('ctx', inspect.Parameter.KEYWORD_ONLY, default=CurrentContext(), annotation=Context)]
            wrapped.__signature__ = signature.replace(parameters=params, return_annotation=dict)
            wrapped.__annotations__ = {p.name: p.annotation for p in params}
            wrapped.__annotations__['return'] = dict
            self.mcp.tool(wrapped, annotations={'readOnlyHint': name not in WRITE_TOOLS, 'destructiveHint': name in WRITE_TOOLS},
                          tags={'write' if name in WRITE_TOOLS else 'read_only'})
            return wrapped

        @tool
        async def workspace_list(ws, sid):
            """List configured workspaces, with names, configured paths and absolute paths."""
            return {'workspaces': self.state.data['workspaces'], 'default_workspace': self.state.data['default_workspace']}

        @tool
        async def workspace_current(ws, sid):
            """Get the current workspace. Keep the returned session_id and pass it to subsequent tools."""
            return ws

        @tool
        async def workspace_switch(ws, sid, workspace_id: str):
            """Switch workspace for this session only. Obtain workspace_id from workspace_list."""
            return self.state.switch(sid, workspace_id)

        @tool
        async def ls(ws, sid, path: str = '.', depth: int = 1, limit: int = 200):
            """List directory contents. depth 1..5; limit 1..2000. Symlink directories are not traversed."""
            return self.files.ls(ws, path, depth, limit)

        @tool
        async def read(ws, sid, path: str, offset: int = 1, limit: int = 200):
            """Read a UTF-8 file with 1-based line numbers. Follow next_offset for more lines. Establishes edit version."""
            return self.files.read(sid, ws, path, offset, limit)

        @tool
        async def grep(ws, sid, pattern: str, path: str = '.', include: str | None = None,
                       fixed: bool = False, ignore_case: bool = False, hidden: bool = False,
                       ignored: bool = False, context: int = 0):
            """Search contents with ripgrep. Regex by default; fixed=true for literal text. Respects gitignore by default."""
            return await search(ws, pattern, path, include, fixed, ignore_case, hidden, ignored, context)

        @tool
        async def glob(ws, sid, pattern: str, path: str = '.', hidden: bool = False, ignored: bool = False):
            """Find files by a glob pattern such as **/*.py. Respects gitignore; does not follow symlinks."""
            return await search(ws, pattern, path, hidden=hidden, ignored=ignored, filenames=True)

        @tool
        async def edit(ws, sid, path: str, edits: list[Edit]):
            """Apply unique exact text replacements against the original file. Read first; overlapping edits fail together."""
            if not edits:
                raise ValueError('At least one edit is required')
            return self.files.mutate(sid, ws, path, edits=[e.model_dump() for e in edits])

        @tool
        async def write(ws, sid, path: str, content: str):
            """Create a UTF-8 file or replace its contents. Existing files must have been read at their current version."""
            return self.files.mutate(sid, ws, path, content=content)

        @tool
        async def bash(ws, sid, command: str, cwd: str = '.', background: bool = False, timeout: float = 30):
            """Run Bash in the workspace. background=true returns process_id; foreground timeout terminates the process group."""
            # Execution is dispatched by the wrapper to release the mutation
            # lock after spawning, so read-only transitions can stop this run.
            raise RuntimeError('bash is dispatched through start_bash')

        @tool
        async def process_list(ws, sid):
            """List server-managed processes across workspaces. One API key shares this process registry."""
            return {'processes': [{**self.processes.snapshot(p, p.base, 1), 'workspace': p.workspace}
                                   for p in self.processes.items.values()]}

        @tool
        async def process_output(ws, sid, process_id: str, cursor: int = 0, limit: int = 51200):
            """Read incremental combined stdout/stderr. Pass next_cursor back; output_lost reports evicted log bytes."""
            return self.processes.snapshot(self.processes.get(process_id), cursor, limit)

        @tool
        async def process_stop(ws, sid, process_id: str):
            """Terminate a server-managed process group, including its child processes."""
            item = self.processes.get(process_id)
            await self.processes.stop(item)
            return self.processes.snapshot(item)

        @tool
        async def git_status(ws, sid):
            """View branch, staged/unstaged changes and untracked files without updating the index."""
            return await git(ws, 'status')

        @tool
        async def git_diff(ws, sid, path: str | None = None, staged: bool = False, base: str | None = None, head: str | None = None):
            """View working-tree, staged, or revision differences. External diff and textconv are disabled."""
            return await git(ws, 'diff', path=path, staged=staged, base=base, head=head)

        @tool
        async def git_log(ws, sid, path: str | None = None, limit: int = 20, offset: int = 0,
                          author: str | None = None, since: str | None = None, until: str | None = None, message: str | None = None):
            """View commit history. Page with offset; filter by file, author, dates or commit-message regex."""
            result = await git(ws, 'log', path=path, limit=limit, offset=offset, author=author, since=since, until=until, message=message)
            result['next_offset'] = offset + limit
            return result

        @tool
        async def git_show(ws, sid, revision: str = 'HEAD', path: str | None = None):
            """Show a commit and its patch, or file contents at a revision when path is supplied."""
            return await git(ws, 'show', revision=revision, path=path)

    async def start_bash(self, workspace, command, cwd='.', background=False, timeout=30):
        if not command.strip() or not 0 < timeout <= 3600:
            raise ValueError('command must be nonempty; timeout must be 0..3600 seconds')
        return await self.processes.start(workspace, command, State.path(workspace, cwd))

    async def wait_bash(self, item, background, timeout):
        if background:
            return self.processes.snapshot(item)
        try:
            await asyncio.wait_for(asyncio.shield(item.reader), timeout)
            return self.processes.snapshot(item)
        except TimeoutError:
            await self.processes.stop(item)
            return {**self.processes.snapshot(item), 'timed_out': True}
        except asyncio.CancelledError:
            await asyncio.shield(self.processes.stop(item))
            raise

    async def set_mode(self, read_only):
        async with self.state.lock:
            if read_only:
                # Do not acknowledge read-only until every owned process group
                # has settled. Existing filesystem mutations use this lock.
                await self.processes.stop_all()
            previous = self.state.data['read_only']
            self.state.data['read_only'] = read_only
            try:
                self.state.save()
            except OSError:
                self.state.data['read_only'] = previous
                raise
            # Legacy connected clients can refresh their cached tool lists.
            # Modern stateless clients discover the new list on their next query.
            async def notify(connection):
                try:
                    await asyncio.wait_for(connection.send_tool_list_changed(), 1)
                except (RuntimeError, OSError, TimeoutError):
                    pass  # A disconnected client will discover the list on reconnect.
            await asyncio.gather(*(notify(c) for c in list(self.connections.values())), return_exceptions=True)

    def make_http_app(self):
        mcp_app = self.mcp.http_app(path='/mcp', stateless_http=False)
        static = Path(__file__).parent / 'static'

        async def index(request):
            return HTMLResponse((static / 'index.html').read_text(encoding='utf-8'), headers={'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'"})

        async def asset(request):
            name = request.path_params['name']
            if name not in {'app.js', 'style.css'}:
                return Response(status_code=404)
            return Response((static / name).read_text(encoding='utf-8'), media_type='text/javascript' if name.endswith('.js') else 'text/css')

        def authorized(request):
            return hmac.compare_digest(request.headers.get('authorization', '').encode(), ('Bearer ' + (self.admin_token or self.api_key)).encode())

        async def api(request: Request):
            if not authorized(request):
                return JSONResponse({'error': 'API Key 无效或缺失'}, status_code=401, headers={'WWW-Authenticate': 'Bearer'})
            try:
                if request.method == 'POST':
                    if int(request.headers.get('content-length', '0')) > 16384:
                        raise ValueError('Request too large')
                    raw_body = await request.body()
                    if len(raw_body) > 16384:
                        raise ValueError('Request too large')
                    payload = json.loads(raw_body)
                    if not isinstance(payload, dict):
                        raise ValueError('JSON object required')
                    action = payload.get('action')
                    if action == 'mode':
                        if type(payload.get('read_only')) is not bool:
                            raise ValueError('read_only must be boolean')
                        await self.set_mode(payload['read_only'])
                    else:
                        async with self.state.lock:
                            # Stage a copy; a failed validation/persist must not
                            # partially change the live workspace configuration.
                            original = self.state.data
                            self.state.data = json.loads(json.dumps(original))
                            try:
                                data = self.state.data
                                if action == 'add':
                                    item = self.state.make_workspace(payload['name'], payload['path'])
                                    if any(w['absolute_path'] == item['absolute_path'] for w in data['workspaces']):
                                        raise ValueError('此目录已添加为工作区')
                                    data['workspaces'].append(item)
                                else:
                                    item = next((w for w in data['workspaces'] if w['id'] == payload.get('id')), None)
                                    if item is None:
                                        raise ValueError('工作区不存在')
                                    if action == 'rename':
                                        if not payload['name'].strip():
                                            raise ValueError('名称不能为空')
                                        item['name'] = payload['name'].strip()
                                    elif action == 'default':
                                        data['default_workspace'] = item['id']
                                    elif action == 'remove':
                                        if data['default_workspace'] == item['id']:
                                            raise ValueError('请先将其他工作区设为默认')
                                        if any(p.workspace['id'] == item['id'] and p.child.returncode is None for p in self.processes.items.values()):
                                            raise ValueError('此工作区还有运行中的进程')
                                        data['workspaces'].remove(item)
                                    else:
                                        raise ValueError('Unknown action')
                                self.state.save()
                            except Exception:
                                self.state.data = original
                                raise
                tool_list = await self.mcp.list_tools()
                return JSONResponse({**self.state.data, 'workspaces': [{**w, 'exists': Path(w['absolute_path']).is_dir()} for w in self.state.data['workspaces']],
                    'tools': [{'name': t.name, 'description': t.description, 'read_only': t.name not in WRITE_TOOLS} for t in tool_list],
                    'processes': [{'id': p.id, 'workspace': p.workspace, 'command': p.command, 'status': 'running' if p.child.returncode is None else 'exited'} for p in self.processes.items.values()]}, headers={'Cache-Control': 'no-store'})
            except (ValueError, OSError, KeyError, TypeError) as error:
                return JSONResponse({'error': str(error)}, status_code=400)

        async def credentials_api(request: Request):
            if not authorized(request):
                return JSONResponse({'error': 'Unauthorized'}, status_code=401)
            if self.credentials is None:
                return JSONResponse({'error': '此服务使用环境变量密钥，请通过桌面模式管理密钥'}, status_code=409)
            try:
                if request.method == 'POST':
                    raw = await request.body()
                    if len(raw) > 2048:
                        raise ValueError('Request too large')
                    payload = json.loads(raw)
                    if not isinstance(payload, dict):
                        raise ValueError('JSON object required')
                    key = payload.get('api_key')
                    from .credentials import generate_api_key
                    if payload.get('generate') is True:
                        key = generate_api_key()
                    async with self.state.lock:
                        self.credentials.save(key)
                        self.api_key = key
                return JSONResponse({'api_key': self.api_key}, headers={'Cache-Control': 'no-store'})
            except (ValueError, OSError, TypeError) as error:
                return JSONResponse({'error': str(error)}, status_code=400)

        @asynccontextmanager
        async def lifespan(app):
            async with mcp_app.lifespan(app):
                try:
                    yield
                finally:
                    await self.processes.stop_all()

        return Starlette(routes=[Route('/', index), Route('/admin', index), Route('/assets/{name}', asset),
                                 Route('/api/state', api, methods=['GET', 'POST']),
                                 Route('/api/credentials', credentials_api, methods=['GET', 'POST']), Mount('/', mcp_app)], lifespan=lifespan)
