"""Bounded file tools with optimistic concurrency checks."""
from __future__ import annotations
import hashlib
import os
import tempfile
from pathlib import Path
from .state import State

MAX_BYTES = 51200


def fingerprint(path: Path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


class Files:
    def __init__(self):
        self.observed = {}

    def read(self, session, workspace, path, offset=1, limit=200):
        if offset < 1 or not 1 <= limit <= 2000:
            raise ValueError('offset >= 1 and 1 <= limit <= 2000 required')
        target = State.path(workspace, path)
        if target.stat().st_size > 20_000_000:
            raise ValueError('File exceeds 20 MB read limit')
        raw = target.read_bytes()
        text = raw.decode('utf-8')
        if '\x00' in text:
            raise ValueError('Binary files are not supported')
        self.observed[(session, str(target))] = hashlib.sha256(raw).hexdigest()
        lines = text.splitlines()
        selected, size = [], 0
        for index in range(offset - 1, min(len(lines), offset - 1 + limit)):
            line = lines[index]
            clipped = line.encode()[:MAX_BYTES].decode('utf-8', errors='ignore')
            if selected and size + len(clipped.encode()) > MAX_BYTES:
                break
            selected.append({'line': index + 1, 'text': clipped, 'truncated': clipped != line})
            size += len(clipped.encode())
        next_line = offset + len(selected)
        return {'lines': selected, 'total_lines': len(lines), 'next_offset': next_line if next_line <= len(lines) else None}

    def mutate(self, session, workspace, path, content=None, edits=None):
        target = State.path(workspace, path)
        before = fingerprint(target)
        if before is not None and self.observed.get((session, str(target))) != before:
            raise ValueError('Read the current file before editing or overwriting it; file is unread or changed')
        if edits is not None:
            if before is None:
                raise ValueError('File does not exist')
            original = target.read_bytes().decode('utf-8')
            spans = []
            for edit in edits:
                old, new = edit['old_text'], edit['new_text']
                if not old or original.count(old) != 1:
                    raise ValueError('Each old_text must match exactly once')
                start = original.index(old)
                spans.append((start, start + len(old), new))
            spans.sort()
            if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
                raise ValueError('Edits overlap')
            content = original
            for start, end, replacement in reversed(spans):
                content = content[:start] + replacement + content[end:]
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=target.parent, prefix='.working-mcp-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content.encode('utf-8'))
            if target.exists():
                os.chmod(temporary, target.stat().st_mode & 0o777)
            if fingerprint(target) != before:
                raise ValueError('File changed during edit; read again')
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        self.observed[(session, str(target))] = fingerprint(target)
        return {'path': str(target), 'bytes_written': len(content.encode()), 'created': before is None}

    def ls(self, workspace, path='.', depth=1, limit=200):
        if not 1 <= depth <= 5 or not 1 <= limit <= 2000:
            raise ValueError('depth must be 1..5; limit must be 1..2000')
        root = State.path(workspace, path)
        entries = []
        def visit(folder, level):
            for item in sorted(folder.iterdir(), key=lambda p: p.name):
                if len(entries) > limit:
                    return
                entries.append({'path': str(item.relative_to(Path(workspace['absolute_path']))), 'type': 'symlink' if item.is_symlink() else 'directory' if item.is_dir() else 'file'})
                if level < depth and item.is_dir() and not item.is_symlink() and item.name not in {'.git', 'node_modules', '.venv'}:
                    visit(item, level + 1)
        visit(root, 1)
        return {'entries': entries[:limit], 'truncated': len(entries) > limit}
