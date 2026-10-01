from __future__ import annotations
import json
from pathlib import Path
import sqlite3
import time
import uuid
from contextlib import contextmanager
from fastapi import HTTPException


def ident():
    return uuid.uuid4().hex


def audit(task, event, detail=''):
    task.setdefault('audit', []).append({'at': time.time(), 'event': event, 'detail': detail})


class InspectionStore:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.root.chmod(0o700)
        self.path = self.root / 'inspection.sqlite3'
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS documents(kind TEXT, id TEXT, owner TEXT, body TEXT, updated REAL, PRIMARY KEY(kind,id))')
            db.execute('CREATE INDEX IF NOT EXISTS document_owner ON documents(kind,owner,updated)')
        # 重启只恢复本模块任务，保留已完成结果与待重试的回填快照。
        for task in self.list('task', None):
            if task.get('run', {}).get('status') in ('queued','running'):
                self.change('task', task['id'], task['owner'], self._interrupt)
            elif task.get('transfer', {}).get('status') == 'sending':
                def interrupted(t):
                    t['transfer'].update(status='failed', error='服务重启，回填确认中断。请重试查询原回执。')
                self.change('task', task['id'], task['owner'], interrupted)

    @staticmethod
    def _interrupt(t):
        t['run'].update(status='stopped', error='服务重启，已完成结果已保留。可以继续识别。')
        audit(t, 'service_interrupted')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.execute('PRAGMA journal_mode=WAL')
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, kind, owner, value):
        value = {**value, 'id': value.get('id') or ident(), 'owner': owner, 'updated': time.time()}
        with self.connect() as db:
            db.execute('INSERT INTO documents VALUES (?,?,?,?,?)', (kind,value['id'],owner,json.dumps(value,ensure_ascii=False),value['updated']))
        return value

    def get(self, kind, key, owner=None):
        with self.connect() as db:
            row = db.execute('SELECT owner,body FROM documents WHERE kind=? AND id=?',(kind,key)).fetchone()
        if not row or (owner is not None and row[0] != owner):
            raise HTTPException(404,'记录不存在。')
        return json.loads(row[1])

    def list(self, kind, owner):
        with self.connect() as db:
            if owner is None:
                rows = db.execute('SELECT body FROM documents WHERE kind=? ORDER BY updated DESC',(kind,)).fetchall()
            else:
                rows = db.execute('SELECT body FROM documents WHERE kind=? AND owner=? ORDER BY updated DESC',(kind,owner)).fetchall()
        return [json.loads(r[0]) for r in rows]

    def change(self, kind, key, owner, fn):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT owner,body FROM documents WHERE kind=? AND id=?',(kind,key)).fetchone()
            if not row or row[0] != owner:
                raise HTTPException(404,'记录不存在。')
            value = json.loads(row[1])
            fn(value)
            value['updated'] = time.time()
            db.execute('UPDATE documents SET body=?,updated=? WHERE kind=? AND id=?',
                       (json.dumps(value,ensure_ascii=False),value['updated'],kind,key))
        return value

    def folder(self, kind, key):
        if not key.isalnum() or len(key)>64:
            raise HTTPException(404,'路径不存在。')
        folder = self.root / kind / key
        folder.mkdir(parents=True,exist_ok=True)
        return folder
