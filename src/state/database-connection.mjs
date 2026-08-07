import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "../config.mjs";
import { initSchema } from "./database-schema.mjs";

// Make sure the folder the DB file lives in actually exists before opening it.
mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

// One shared connection for the whole process. node:sqlite's DatabaseSync is
// synchronous (no internal awaits mid-statement), so — unlike the old
// flat-JSON run-store — there's no read-modify-write race between concurrent
// callers to guard with a lock: each statement is one atomic call.
const db = new DatabaseSync(path.resolve(config.dbPath));

// WAL mode lets reads and writes not block each other within that one connection.
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
initSchema(db);

export function getDb() {
  return db;
}
