"""Persist the MCP credential separately from public workspace configuration."""
import json
import os
import secrets
import tempfile
from pathlib import Path


def generate_api_key():
    return 'wmcp_' + secrets.token_urlsafe(32)


class Credentials:
    def __init__(self, path: Path):
        self.path = path
        if path.exists():
            self.key = json.loads(path.read_text(encoding='utf-8'))['api_key']
            self.validate(self.key)
        else:
            self.key = generate_api_key()
            self.save(self.key)

    @staticmethod
    def validate(key):
        if not isinstance(key, str) or not 16 <= len(key) <= 512 or not key.isascii() or any(c.isspace() or ord(c) < 33 for c in key):
            raise ValueError('API Key 必须为 16–512 个非空白 ASCII 字符')

    def save(self, key):
        self.validate(key)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix='.credentials-')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump({'api_key': key}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        self.key = key
