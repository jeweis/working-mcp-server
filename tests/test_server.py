import asyncio
import subprocess
from pathlib import Path

import httpx
import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError

from working_mcp_server.server import Application, WRITE_TOOLS
from working_mcp_server.state import State


@pytest.fixture
def application(tmp_path):
    root = tmp_path / 'project'
    root.mkdir()
    return Application(State(tmp_path / 'config.json', root), 'test-secret')


async def call(client, name, **arguments):
    result = await client.call_tool(name, arguments)
    return result.structured_content


@pytest.mark.asyncio
async def test_tools_and_session_workspace_isolation(application, tmp_path):
    other = tmp_path / 'other'
    other.mkdir()
    workspace = application.state.make_workspace('other', str(other))
    application.state.data['workspaces'].append(workspace)
    async with Client(application.mcp) as client:
        assert len(await client.list_tools()) == 17
        first = await call(client, 'workspace_current')
        second = await call(client, 'workspace_current')
        # Distinct application handles model separate modern-protocol clients.
        first_id = first['session_id']
        application.sessions.add('independent-client')
        second_id = 'independent-client'
        switched = await call(client, 'workspace_switch', session_id=first_id, workspace_id=workspace['id'])
        assert switched['workspace']['name'] == 'other'
        current = await call(client, 'workspace_current', session_id=second_id)
        assert current['workspace']['name'] == 'project'
        assert 'absolute_path' in current['workspace']
        with pytest.raises(ToolError, match='Unknown session_id'):
            await call(client, 'read', session_id='invalid', path='missing')


@pytest.mark.asyncio
async def test_file_tools_conflicts_and_escape(application, tmp_path):
    root = Path(application.state.default()['absolute_path'])
    (root / 'file.txt').write_text('hello world\nsecond\n')
    (root / 'escape').symlink_to(tmp_path, target_is_directory=True)
    async with Client(application.mcp) as client:
        sid = (await call(client, 'workspace_current'))['session_id']
        with pytest.raises(ToolError, match='Read the current'):
            await call(client, 'write', path='file.txt', content='oops', session_id=sid)
        content = await call(client, 'read', path='file.txt', offset=2, limit=1, session_id=sid)
        assert content['result']['lines'][0]['line'] == 2
        await call(client, 'edit', path='file.txt', edits=[{'old_text': 'hello', 'new_text': 'goodbye'}], session_id=sid)
        assert (root / 'file.txt').read_text().startswith('goodbye')
        (root / 'file.txt').write_text('external change')
        with pytest.raises(ToolError, match='changed'):
            await call(client, 'write', path='file.txt', content='oops', session_id=sid)
        for path in ['../config.json', 'escape/config.json']:
            with pytest.raises(ToolError, match='outside'):
                await call(client, 'read', path=path, session_id=sid)
        await call(client, 'write', path='new/sub.txt', content='created', session_id=sid)
        assert (root / 'new/sub.txt').read_text() == 'created'


@pytest.mark.asyncio
async def test_mode_kills_process_and_hides_tools(application):
    async with Client(application.mcp) as client:
        started = await call(client, 'bash', command='echo ready; sleep 60', background=True)
        pid = started['result']['process_id']
        item = application.processes.get(pid)
        await application.set_mode(True)
        assert item.child.returncode is not None
        names = {tool.name for tool in await client.list_tools()}
        assert len(names) == 11
        assert names.isdisjoint(WRITE_TOOLS)
        with pytest.raises(ToolError):
            await call(client, 'bash', command='echo forbidden')
        await application.set_mode(False)
        assert len(await client.list_tools()) == 17
        output = await call(client, 'process_output', process_id=pid)
        assert output['workspace'] == item.workspace
        assert output['result']['status'] == 'exited'


@pytest.mark.asyncio
async def test_bash_timeout_and_incremental_output(application):
    async with Client(application.mcp) as client:
        result = await call(client, 'bash', command='printf hello', timeout=5)
        assert result['result']['output'] == 'hello'
        tail = await call(client, 'process_output', process_id=result['result']['process_id'], cursor=5)
        assert tail['result']['output'] == ''
        result = await call(client, 'bash', command='sleep 60', timeout=0.05)
        assert result['result']['timed_out']
        assert result['result']['status'] == 'exited'


@pytest.mark.asyncio
async def test_search_and_git(application):
    root = Path(application.state.default()['absolute_path'])
    subprocess.run(['git', 'init', '-q', str(root)], check=True)
    (root / 'hello.py').write_text('def hello():\n    return 1\n')
    (root / '.gitignore').write_text('ignored.txt\n')
    (root / 'ignored.txt').write_text('secret')
    subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
    subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], check=True)
    async with Client(application.mcp) as client:
        assert 'hello.py' in (await call(client, 'glob', pattern='**/*.py'))['result']['output']
        assert 'hello.py:1:' in (await call(client, 'grep', pattern='def hello', fixed=True))['result']['output']
        assert 'ignored.txt' not in (await call(client, 'glob', pattern='*.txt'))['result']['output']
        assert 'ignored.txt' in (await call(client, 'glob', pattern='*.txt', ignored=True))['result']['output']
        assert (await call(client, 'grep', pattern='not found'))['result']['exit_code'] == 1
        assert 'initial' in (await call(client, 'git_log'))['result']['output']
        assert 'def hello' in (await call(client, 'git_show', path='hello.py'))['result']['output']
        assert (await call(client, 'git_diff'))['result']['output'] == ''
        assert (await call(client, 'git_status'))['result']['exit_code'] == 0
        with pytest.raises(ToolError, match='Invalid Git revision'):
            await call(client, 'git_show', revision='--output=bad')


@pytest.mark.asyncio
async def test_admin_auth_persistence_and_workspace_management(application, tmp_path):
    transport = httpx.ASGITransport(app=application.app)
    async with httpx.AsyncClient(transport=transport, base_url='http://test') as client:
        assert (await client.get('/admin')).status_code == 200
        assert (await client.get('/api/state')).status_code == 401
        client.headers['Authorization'] = 'Bearer test-secret'
        assert len((await client.get('/api/state')).json()['tools']) == 17
        other = tmp_path / 'other'
        other.mkdir()
        response = await client.post('/api/state', json={'action': 'add', 'name': '第二项目', 'path': str(other)})
        assert response.status_code == 200
        workspace = response.json()['workspaces'][-1]
        assert (await client.post('/api/state', json={'action': 'add', 'name': 'duplicate', 'path': str(other)})).status_code == 400
        for payload in [
            {'action': 'rename', 'id': workspace['id'], 'name': 'renamed'},
            {'action': 'default', 'id': workspace['id']},
            {'action': 'mode', 'read_only': True},
        ]:
            assert (await client.post('/api/state', json=payload)).status_code == 200
        assert len((await client.get('/api/state')).json()['tools']) == 11
        reloaded = State(application.state.config, tmp_path)
        assert reloaded.default()['name'] == 'renamed'
        assert reloaded.data['read_only'] is True
        assert (await client.post('/api/state', json={'action': 'remove', 'id': workspace['id']})).status_code == 400
        assert (await client.post('/api/state', json={'action': 'mode', 'read_only': 'false'})).status_code == 400


@pytest.mark.asyncio
async def test_read_only_cached_call_returns_workspace_metadata(application):
    async with Client(application.mcp) as client:
        sid = (await call(client, 'workspace_current'))['session_id']
        await application.set_mode(True)
        result = await client.call_tool('write', {'path': 'bad.txt', 'content': 'bad', 'session_id': sid}, raise_on_error=False)
        assert result.is_error
        assert result.structured_content['workspace']['name'] == 'project'
        assert result.structured_content['session_id'] == sid
        assert not (Path(application.state.default()['absolute_path']) / 'bad.txt').exists()


@pytest.mark.asyncio
async def test_overlapping_edit_is_atomic_and_secret_not_in_child(application, monkeypatch):
    root = Path(application.state.default()['absolute_path'])
    (root / 'overlap.txt').write_text('abcdef')
    monkeypatch.setenv('WORKING_MCP_API_KEY', 'must-not-leak')
    async with Client(application.mcp) as client:
        sid = (await call(client, 'workspace_current'))['session_id']
        await call(client, 'read', path='overlap.txt', session_id=sid)
        with pytest.raises(ToolError, match='overlap'):
            await call(client, 'edit', path='overlap.txt', edits=[{'old_text': 'abc', 'new_text': 'one'}, {'old_text': 'bcd', 'new_text': 'two'}], session_id=sid)
        assert (root / 'overlap.txt').read_text() == 'abcdef'
        result = await call(client, 'bash', command='printf "%s" "${WORKING_MCP_API_KEY-unset}"', session_id=sid)
        assert result['result']['output'] == 'unset'
