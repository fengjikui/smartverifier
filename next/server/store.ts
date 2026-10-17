import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Task, Round, Person } from '../shared/types.ts';

export class Store {
  db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'inspection.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, person TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, round_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  tasks(): Task[] { return this.db.prepare('SELECT data FROM tasks ORDER BY id').all().map(row => JSON.parse(String(row.data))); }
  task(id: string): Task | null { const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id); return row ? JSON.parse(String(row.data)) : null; }
  saveTask(task: Task) { this.db.prepare('INSERT INTO tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, JSON.stringify(task)); }
  round(id: string): Round | null { const row = this.db.prepare('SELECT data FROM rounds WHERE id=?').get(id); return row ? JSON.parse(String(row.data)) : null; }
  rounds(): Round[] { return this.db.prepare('SELECT data FROM rounds').all().map(row => JSON.parse(String(row.data))); }
  saveRound(round: Round) { this.db.prepare('INSERT INTO rounds VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(round.id, round.taskId, JSON.stringify(round)); }
  transaction(fn: () => void) { this.db.exec('BEGIN IMMEDIATE'); try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  audit(round: Round, person: Person, action: string, data: unknown) { this.db.prepare('INSERT INTO audit(round_id,actor,action,data,at) VALUES(?,?,?,?,?)').run(round.id, person.id, action, JSON.stringify(data), new Date().toISOString()); }
  close() { this.db.close(); }
}
