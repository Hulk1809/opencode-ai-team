import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL,id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS message_key ON records(json_extract(data,'$.idempotencyKey')) WHERE kind='messages';`);
  }
  all(kind: string): any[] { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(r => JSON.parse(r.data as string)); }
  get(kind: string, id: string): any { const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,id); if (!row) throw new Error(`${kind}: not found`); return JSON.parse(row.data as string); }
  put(kind: string, value: any) { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE kind=excluded.kind').run(kind,value.id,JSON.stringify(value)); return value; }
  add(kind: string, value: any) { return this.put(kind,{ ...value,id:randomUUID(),createdAt:new Date().toISOString() }); }
  patch(kind: string,id: string,value: any) { return this.put(kind,{...this.get(kind,id),...value,id}); }
}
