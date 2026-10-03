"""已配对设备上的本地试用账号，独立于 MES/企业认证。"""
from __future__ import annotations

import asyncio
import hashlib
import secrets
import sqlite3
import time
from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from .storage import ident


class Credentials(BaseModel):
    model_config = ConfigDict(extra='forbid')
    account: str = Field(min_length=2, max_length=60, pattern=r'^[A-Za-z0-9_.@-]+$')
    password: str = Field(min_length=8, max_length=128)


class Registration(Credentials):
    name: str = Field(min_length=1, max_length=60)


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


class LocalAccounts:
    def __init__(self, store):
        self.store = store
        self.lock = asyncio.Lock()
        with store.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS trial_accounts(account TEXT PRIMARY KEY, salt TEXT, digest TEXT, owner TEXT UNIQUE, name TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS trial_logins(device TEXT PRIMARY KEY, account TEXT, expires REAL)')
            db.execute('CREATE TABLE IF NOT EXISTS trial_attempts(device TEXT PRIMARY KEY, count INTEGER, until REAL)')

    def session(self, device):
        with self.store.connect() as db:
            row = db.execute('SELECT a.account,a.owner,a.name FROM trial_logins l JOIN trial_accounts a ON a.account=l.account WHERE l.device=? AND l.expires>?', (device, time.time())).fetchone()
        return {'account': row[0], 'owner': row[1], 'name': row[2]} if row else None

    def install(self, app):
        prefix = '/api/inspection/auth'

        @app.get(prefix + '/status')
        async def status(request: Request):
            user = self.session(request.state.owner)
            return {'user': {k: v for k, v in user.items() if k != 'owner'} if user else None, 'mode': 'local_trial'}

        async def authenticate(data, request, register=False):
            device, account = request.state.owner, data.account.lower()
            async with self.lock:
                with self.store.connect() as db:
                    rate = db.execute('SELECT count,until FROM trial_attempts WHERE device=?', (device,)).fetchone()
                    if rate and rate[0] >= 8 and rate[1] > time.time():
                        raise HTTPException(429, '尝试次数较多，请 5 分钟后再试。')
                    db.execute('INSERT OR REPLACE INTO trial_attempts VALUES (?,?,?)', (device, rate[0] + 1 if rate and rate[1] > time.time() else 1, time.time() + 300))
                    row = db.execute('SELECT salt,digest,owner FROM trial_accounts WHERE account=?', (account,)).fetchone()
                if register:
                    if row: raise HTTPException(409, '账号已存在，请登录。')
                    if not data.name.strip(): raise HTTPException(400, '请填写姓名。')
                    salt = secrets.token_hex(16)
                    hashed = await asyncio.to_thread(password_hash, data.password, salt)
                    with self.store.connect() as db:
                        # 当前设备首次创建的账号承接旧试用资料；后续账号独立隔离。
                        claimed = db.execute('SELECT 1 FROM trial_accounts WHERE owner=?', (device,)).fetchone()
                        owner = ident() if claimed else device
                        try: db.execute('INSERT INTO trial_accounts VALUES (?,?,?,?,?)', (account, salt, hashed, owner, data.name.strip()))
                        except sqlite3.IntegrityError as exc: raise HTTPException(409, '账号已存在，请登录。') from exc
                    value = {'employee_id': account, 'name': data.name.strip(), 'identity_source': 'local_trial'}
                    profiles = self.store.list('profile', owner)
                    if profiles: self.store.change('profile', profiles[0]['id'], owner, lambda p: p.update(value))
                    else: self.store.create('profile', owner, value)
                else:
                    hashed = await asyncio.to_thread(password_hash, data.password, row[0] if row else '00' * 16)
                    if not row or not secrets.compare_digest(hashed, row[1]):
                        raise HTTPException(401, '账号或密码不正确。')
                with self.store.connect() as db:
                    db.execute('INSERT OR REPLACE INTO trial_logins VALUES (?,?,?)', (device, account, time.time() + 12 * 3600))
                    db.execute('DELETE FROM trial_attempts WHERE device=?', (device,))
            return {'ok': True}

        @app.post(prefix + '/register')
        async def register(data: Registration, request: Request):
            return await authenticate(data, request, True)

        @app.post(prefix + '/login')
        async def login(data: Credentials, request: Request):
            return await authenticate(data, request)

        @app.post(prefix + '/logout')
        async def logout(request: Request):
            with self.store.connect() as db:
                db.execute('DELETE FROM trial_logins WHERE device=?', (request.state.owner,))
            return {'ok': True}
