import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";
import { initSchema } from "./schema.mjs";

/* Single shared connection for the whole process — node:sqlite's
 * DatabaseSync is synchronous (no internal awaits mid-statement), so unlike
 * the old flat-JSON run-store there's no read-modify-write race between
 * concurrent callers to guard with a lock: each statement is one atomic
 * call. WAL mode lets reads and writes not block each other within that one
 * connection. */
mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
const db = new DatabaseSync(path.resolve(config.dbPath));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
initSchema(db);

export function getDb() {
  return db;
}
