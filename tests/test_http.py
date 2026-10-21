"""Real socket tests; opt in with WORKING_MCP_HTTP_TESTS=1."""
import asyncio
import os
import socket
import subprocess
import sys

import httpx
import pytest
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(os.environ.get('WORKING_MCP_HTTP_TESTS') != '1', reason='Real HTTP tests require an available loopback listener')]


@pytest.mark.parametrize('mode', ['auto', 'legacy'])
async def test_authenticated_http_workspace_isolation_and_live_mode(tmp_path, mode):
    root = tmp_path / 'project'
    other = tmp_path / 'other'
    root.mkdir()
    other.mkdir()
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    endpoint = f'http://127.0.0.1:{port}'
    headers = {'Authorization': 'Bearer integration-key'}
    with (tmp_path / 'server.log').open('w+') as log:
        process = subprocess.Popen([sys.executable, '-c', 'from working_mcp_server import main; main()',
                                    '--port', str(port), '--config', str(tmp_path / 'config.json')],
                                   cwd=root, env={**os.environ, 'WORKING_MCP_API_KEY': 'integration-key'}, stdout=log, stderr=log)
        try:
            async with httpx.AsyncClient(base_url=endpoint, timeout=10) as http:
                for _ in range(100):
                    try:
                        if (await http.get('/admin')).status_code == 200:
                            break
                    except httpx.ConnectError:
                        pass
                    if process.poll() is not None:
                        log.seek(0)
                        pytest.fail(log.read())
                    await asyncio.sleep(0.05)
                else:
                    pytest.fail('Server did not start')
                assert (await http.post('/mcp', json={})).status_code == 401
                assert (await http.get('/api/state', headers={'Authorization': 'Bearer wrong'})).status_code == 401
                response = await http.post('/api/state', headers=headers, json={'action': 'add', 'name': 'other', 'path': str(other)})
                wid = response.json()['workspaces'][-1]['id']
                def transport():
                    return StreamableHttpTransport(endpoint + '/mcp', headers=headers)
                async with Client(transport(), mode=mode) as first, Client(transport(), mode=mode) as second:
                    first_sid = (await first.call_tool('workspace_current')).structured_content['session_id']
                    second_sid = (await second.call_tool('workspace_current')).structured_content['session_id']
                    assert first_sid != second_sid
                    await first.call_tool('workspace_switch', {'workspace_id': wid, 'session_id': first_sid})
                    current = (await second.call_tool('workspace_current', {'session_id': second_sid})).structured_content
                    assert current['workspace']['name'] == 'project'
                    await first.call_tool('write', {'session_id': first_sid, 'path': 'hello.txt', 'content': 'hello HTTP'})
                    assert (other / 'hello.txt').read_text() == 'hello HTTP'
                    started = (await first.call_tool('bash', {'session_id': first_sid, 'command': 'sleep 60', 'background': True})).structured_content
                    process_id = started['result']['process_id']
                    response = await http.post('/api/state', headers=headers, json={'action': 'mode', 'read_only': True})
                    assert response.status_code == 200
                    assert len(response.json()['tools']) == 11
                    assert all(p['status'] == 'exited' for p in response.json()['processes'])
                    assert len(await first.list_tools()) == 11
                    result = await first.call_tool('write', {'session_id': first_sid, 'path': 'blocked.txt', 'content': 'blocked'}, raise_on_error=False)
                    assert result.is_error
                    assert result.structured_content['workspace']['name'] == 'other'
                    assert not (other / 'blocked.txt').exists()
                    response = await http.post('/api/state', headers=headers, json={'action': 'mode', 'read_only': False})
                    assert response.status_code == 200
                    assert len(await first.list_tools()) == 17
                    output = (await first.call_tool('process_output', {'session_id': first_sid, 'process_id': process_id})).structured_content
                    assert output['result']['status'] == 'exited'
                    assert output['workspace']['name'] == 'other'
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
