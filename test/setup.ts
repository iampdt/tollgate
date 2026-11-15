import { env } from "cloudflare:workers";
import schema from "../migrations/0001_init.sql?raw";

// The tests' database starts empty: create the tables once per test file.
const statements = schema
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

const db = (env as unknown as { DB: D1Database }).DB;
const existing = await db.prepare("SELECT name FROM sqlite_master WHERE name = 'traces'").first();
if (!existing) await db.batch(statements.map((statement) => db.prepare(statement)));
