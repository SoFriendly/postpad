// Node entrypoint for self-hosting in Docker: same Hono app, SQLite file instead of D1.
import { serve } from "@hono/node-server";
import app from "./index.ts";
import { openDb } from "./sqlite.ts";

const env = {
  DB: openDb(process.env.DB_PATH ?? "postpad.db", new URL("../migrations", import.meta.url).pathname),
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || undefined,
  OPEN_BOXES: process.env.OPEN_BOXES || undefined,
  PUBLIC_URL: process.env.PUBLIC_URL || undefined,
};
if (!env.ADMIN_TOKEN) console.warn("ADMIN_TOKEN not set: anyone who can reach this server can open a PO Box. Set it on any internet-facing host.");

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: (req) => app.fetch(req, env), port }, () => console.log(`postpad api listening on :${port}`));
