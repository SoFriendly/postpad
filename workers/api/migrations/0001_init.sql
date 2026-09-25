-- PostPad schema. One pad per PO Box; each delivery address is an entry in it.
-- No accounts: a random box key opens the box; senders only ever hold an entry token.

CREATE TABLE boxes (
  id         TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL UNIQUE,     -- sha-256 of the box key (the key is shown once)
  created_at TEXT NOT NULL
);

CREATE TABLE entries (
  id                  TEXT PRIMARY KEY,  -- opaque; the delivery address is /v1/ingest/<id> and never changes
  box_id              TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,     -- the entry's H1 in the pad
  slug                TEXT NOT NULL,     -- anchor in the pad; follows the title, never the address
  position            INTEGER NOT NULL,  -- order in the pad
  tags                TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  pinned              INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,     -- ISO-8601
  updated_at          TEXT NOT NULL,     -- last time the entry changed (delivery, rename, pin)
  current_revision_id TEXT,
  current_markdown    TEXT NOT NULL DEFAULT '',  -- latest body (no H1: the title is the H1)
  ingest_token_hash   TEXT NOT NULL,     -- sha-256 of the entry's write-only token
  ingest_filter       TEXT,              -- delivery rules, JSON {include, exclude}; NULL = accept every post
  last_skipped_at     TEXT,              -- last post returned unopened by the delivery rules
  last_skip_reason    TEXT,
  allow_url_token     INTEGER NOT NULL DEFAULT 0,  -- accept ?token=<entry token>
  signing_secret      TEXT,              -- HMAC-SHA256 webhook secret; NULL = signatures off
  signing_header      TEXT,              -- header carrying the signature, e.g. X-Hub-Signature-256
  UNIQUE (box_id, slug)
);
CREATE INDEX idx_entries_pad ON entries(box_id, position);

CREATE TABLE revisions (
  id                TEXT PRIMARY KEY,
  entry_id          TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL,
  source            TEXT,              -- X-PostPad-Source or user-agent: who wrote it
  raw_json          TEXT NOT NULL,     -- the post, normalized to JSON
  rendered_markdown TEXT NOT NULL,
  content_hash      TEXT NOT NULL      -- sha-256 of rendered_markdown
);
CREATE INDEX idx_revisions_entry ON revisions(entry_id, created_at DESC);
