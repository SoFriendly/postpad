// D1-compatible shim over node:sqlite, so the same Hono app runs in Docker/Node.
// Implements only the D1 surface index.ts uses: prepare/bind/first/all/run/batch.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

class Stmt {
  st: StatementSync;
  args: any[];
  constructor(st: StatementSync, args: any[] = []) { this.st = st; this.args = args; }
  bind(...args: any[]) { return new Stmt(this.st, args); }
  async first<T>(): Promise<T | null> { return (this.st.get(...this.args) as T) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.st.all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.st.run(...this.args).changes) } }; }
  // Sync variant for batch(), which must run inside one transaction. Mirrors D1's
  // per-statement result: rows for reads, meta.changes for writes.
  batchSync() {
    if (/^\s*(select|with)\b/i.test(this.st.sourceSQL)) return { results: this.st.all(...this.args), meta: { changes: 0 } };
    return { results: [], meta: { changes: Number(this.st.run(...this.args).changes) } };
  }
}

export function openDb(path: string, migrationsDir: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  migrate(db, migrationsDir);
  return {
    prepare: (sql: string) => new Stmt(db.prepare(sql)),
    async batch(stmts: Stmt[]) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.batchSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}

// Apply migrations/*.sql in name order, once each (same files wrangler applies to D1).
function migrate(db: DatabaseSync, dir: string) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(dir, f), "utf8"));
      db.prepare("INSERT INTO _migrations VALUES (?, ?)").run(f, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
