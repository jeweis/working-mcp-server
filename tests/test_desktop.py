import json
import os
from pathlib import Path

import httpx
import pytest
from working_mcp_server.credentials import Credentials
from working_mcp_server.state import State
from working_mcp_server.server import Application


def test_generated_key_is_persisted_and_private(tmp_path):
    path = tmp_path / 'credentials.json'
    first = Credentials(path)
    assert first.key.startswith('wmcp_')
    assert len(first.key) >= 40
    assert Credentials(path).key == first.key
    first.save('new-secret-with-16-characters')
    assert Credentials(path).key == 'new-secret-with-16-characters'
    if os.name != 'nt':
        assert path.stat().st_mode & 0o077 == 0
    for invalid in ['', 'short', 'a' * 513, 'x' * 20 + '\n', '中文' * 16]:
        with pytest.raises(ValueError):
            first.save(invalid)
    assert Credentials(path).key == 'new-secret-with-16-characters'


@pytest.mark.asyncio
async def test_private_management_token_and_live_key_rotation(tmp_path):
    credentials = Credentials(tmp_path / 'credentials.json')
    old = credentials.key
    app = Application(State(tmp_path / 'config.json', tmp_path), old,
                      admin_token='private-electron-token', credentials=credentials)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url='http://localhost') as client:
        assert '连接你的工作台' in (await client.get('/admin')).text
        assert (await client.get('/api/state')).status_code == 401
        assert (await client.get('/api/state', headers={'Authorization': 'Bearer ' + old})).status_code == 401
        assert await app.mcp.auth.verify_token('private-electron-token') is None
        headers = {'Authorization': 'Bearer private-electron-token'}
        state = await client.get('/api/state', headers=headers)
        assert state.status_code == 200
        assert old not in state.text
        assert old not in (tmp_path / 'config.json').read_text()
        assert (await client.get('/api/credentials', headers=headers)).json()['api_key'] == old
        assert await app.mcp.auth.verify_token(old) is not None
        response = await client.post('/api/credentials', headers=headers, json={'api_key': 'changed-secret-1234567890'})
        assert response.status_code == 200
        assert await app.mcp.auth.verify_token(old) is None
        assert await app.mcp.auth.verify_token('changed-secret-1234567890') is not None
        assert (await client.get('/api/state', headers=headers)).status_code == 200
        assert Credentials(credentials.path).key == 'changed-secret-1234567890'
        invalid = await client.post('/api/credentials', headers=headers, json={'api_key': 'bad'})
        assert invalid.status_code == 400
        assert app.api_key == 'changed-secret-1234567890'
        generated = (await client.post('/api/credentials', headers=headers, json={'generate': True})).json()['api_key']
        assert generated.startswith('wmcp_')
        assert await app.mcp.auth.verify_token('changed-secret-1234567890') is None
        assert await app.mcp.auth.verify_token(generated) is not None
