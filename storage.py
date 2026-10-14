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
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS suite_name ON entities(json_extract(data,'$.project_id'),json_extract(data,'$.name')) WHERE kind='suite'")
        rows = db.execute("SELECT data FROM entities WHERE kind='case'").fetchall()
        for row in rows:
            case = json.loads(row[0])
            name = case.get('suite')
            if name:
                item = {'id': uuid.uuid4().hex, 'project_id': case['project_id'], 'name': name, 'created_at': now()}
                db.execute("INSERT OR IGNORE INTO entities(kind,id,data) VALUES ('suite',?,?)", (item['id'], json.dumps(item, ensure_ascii=False)))


def ensure_suite(project_id, name, fail_duplicate=False):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute("SELECT data FROM entities WHERE kind='suite' AND json_extract(data,'$.project_id')=? AND json_extract(data,'$.name')=?", (project_id, name)).fetchone()
        if row:
            if fail_duplicate:
                raise ValueError('项目内测试集名称不能重复')
            return json.loads(row[0])
        item = {'id': uuid.uuid4().hex, 'project_id': project_id, 'name': name, 'created_at': now()}
        db.execute("INSERT INTO entities(kind,id,data) VALUES ('suite',?,?)", (item['id'], json.dumps(item, ensure_ascii=False)))
        return item


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


def delete_project(identifier, confirmation):
    with connection() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute("SELECT data FROM entities WHERE kind='project' AND id=?", (identifier,)).fetchone()
        if not row:
            raise ValueError('项目不存在或已删除')
        if confirmation != json.loads(row[0])['name']:
            raise ValueError('项目名称不匹配，未删除')
        if db.execute("SELECT 1 FROM entities WHERE kind='run' AND json_extract(data,'$.project_id')=? AND json_extract(data,'$.status')='running'", (identifier,)).fetchone():
            raise ValueError('项目有评测正在运行，请等待完成后再删除')
        db.execute("DELETE FROM entities WHERE kind IN ('result','review') AND json_extract(data,'$.run_id') IN (SELECT id FROM entities WHERE kind='run' AND json_extract(data,'$.project_id')=?)", (identifier,))
        db.execute("DELETE FROM entities WHERE kind IN ('version','case','suite','run') AND json_extract(data,'$.project_id')=?", (identifier,))
        db.execute("DELETE FROM entities WHERE kind='project' AND id=?", (identifier,))
        return {'ok': True}
