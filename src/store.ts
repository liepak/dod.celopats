import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const randomToken = () => randomBytes(32).toString('base64url');
export class Store {
  db: DatabaseSync;
  key: Buffer;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyPath = join(dir, 'encryption.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(join(dir, 'dod.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires INTEGER NOT NULL, csrf TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        description TEXT NOT NULL, folder TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        uploads_open INTEGER NOT NULL DEFAULT 1, quota INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id),
        file_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
        offset INTEGER NOT NULL DEFAULT 0, session TEXT, state TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS uploads_collection ON uploads(collection_id);`);
  }
  seal(value: unknown) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  open(value: string) {
    const b = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString());
  }
  set(key: string, value: unknown) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, this.seal(value)); }
  get(key: string) { const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r ? this.open(String(r.value)) : null; }
  setPassword(password: string) { const salt = randomBytes(16).toString('hex'); this.set('password', {salt, hash: scryptSync(password, salt, 64).toString('hex')}); }
  checkPassword(password: string) { const p = this.get('password'); return p && timingSafeEqual(scryptSync(password, p.salt, 64), Buffer.from(p.hash, 'hex')); }
}
