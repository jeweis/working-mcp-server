"""Persistent workspace configuration and request-local workspace selection."""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import uuid
from pathlib import Path


class State:
    def __init__(self, config: Path, cwd: Path, read_only: bool = False):
        self.config = config
        self.cwd = cwd.resolve()
        self.lock = asyncio.Lock()
        self.selections: dict[str, str] = {}
        if config.exists():
            self.data = json.loads(config.read_text(encoding='utf-8'))
            if not isinstance(self.data, dict) or type(self.data.get('read_only')) is not bool:
                raise ValueError('Invalid configuration: read_only must be boolean')
            workspaces = self.data.get('workspaces')
            if not isinstance(workspaces, list) or not workspaces:
                raise ValueError('Configuration must contain at least one workspace')
            ids = set()
            for item in workspaces:
                if not isinstance(item, dict) or not all(isinstance(item.get(k), str) and item[k] for k in ('id', 'name', 'path', 'absolute_path')):
                    raise ValueError('Invalid workspace configuration')
                if item['id'] in ids or not Path(item['absolute_path']).is_absolute():
                    raise ValueError('Workspace IDs must be unique and absolute_path must be absolute')
                ids.add(item['id'])
            if self.data.get('default_workspace') not in ids:
                raise ValueError('Default workspace does not exist')
        else:
            workspace = self.make_workspace(self.cwd.name or 'workspace', str(self.cwd))
            self.data = {'read_only': False, 'default_workspace': workspace['id'], 'workspaces': [workspace]}
        if read_only:
            self.data['read_only'] = True
        self.save()

    def make_workspace(self, name: str, path: str) -> dict:
        if not name.strip() or not path.strip():
            raise ValueError('Name and path are required')
        root = Path(path).expanduser()
        root = (self.cwd / root).resolve() if not root.is_absolute() else root.resolve()
        if not root.is_dir():
            raise ValueError('Workspace directory does not exist')
        return {'id': 'ws_' + uuid.uuid4().hex[:12], 'name': name.strip(), 'path': path, 'absolute_path': str(root)}

    def save(self):
        self.config.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=self.config.parent, prefix='.config-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(self.data, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.config)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def current(self, session: str) -> dict:
        selected = self.selections.get(session, self.data['default_workspace'])
        return next((w for w in self.data['workspaces'] if w['id'] == selected), self.default()).copy()

    def default(self):
        return next(w for w in self.data['workspaces'] if w['id'] == self.data['default_workspace'])

    def switch(self, session: str, workspace_id: str) -> dict:
        if not any(w['id'] == workspace_id for w in self.data['workspaces']):
            raise ValueError('Unknown workspace ID; use workspace_list')
        self.selections[session] = workspace_id
        return self.current(session)

    @staticmethod
    def path(workspace: dict, path: str = '.') -> Path:
        root = Path(workspace['absolute_path'])
        candidate = (root / path).resolve()
        if not candidate.is_relative_to(root):
            raise ValueError('Path is outside the workspace')
        return candidate
