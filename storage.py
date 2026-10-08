import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.environ.get('PROMPTPILOT_DB', str(Path(__file__).parent / 'data' / 'promptpilot.sqlite3')))


def now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=30)
    try:
        db.execute('PRAGMA journal_mode=WAL')
        with db:
            yield db
    finally:
        db.close()


def init():
    with connection() as db:
        db.execute('CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, id TEXT PRIMARY KEY, data TEXT NOT NULL)')
        db.execute('CREATE INDEX IF NOT EXISTS entity_kind ON entities(kind)')


def save(kind, item):
    item = dict(item)
    item.setdefault('id', uuid.uuid4().hex)
    item.setdefault('created_at', now())
    with connection() as db:
        db.execute('INSERT INTO entities(kind,id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', (kind, item['id'], json.dumps(item, ensure_ascii=False, allow_nan=False)))
    return item


def get(kind, identifier):
    with connection() as db:
        row = db.execute('SELECT data FROM entities WHERE kind=? AND id=?', (kind, identifier)).fetchone()
    if not row:
        raise ValueError('记录不存在或已删除')
    return json.loads(row[0])


def all_items(kind):
    with connection() as db:
        return [json.loads(r[0]) for r in db.execute('SELECT data FROM entities WHERE kind=? ORDER BY rowid', (kind,))]


def delete(kind, identifier):
    with connection() as db:
        db.execute('DELETE FROM entities WHERE kind=? AND id=?', (kind, identifier))
