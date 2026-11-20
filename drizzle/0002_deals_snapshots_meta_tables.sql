DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE deals (
  node_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  goto_url TEXT,
  merchant_url TEXT,
  image_blob_key TEXT,
  image_source_url TEXT,
  category TEXT NOT NULL,
  tags TEXT NOT NULL,
  description TEXT NOT NULL,
  votes_pos INTEGER NOT NULL,
  votes_neg INTEGER NOT NULL,
  comments INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  pub_at INTEGER NOT NULL,
  expiry_at INTEGER,
  author TEXT NOT NULL,
  heat_score INTEGER NOT NULL,
  votes_per_hour REAL NOT NULL,
  comments_per_hour REAL NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  votes INTEGER NOT NULL,
  comments INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  heat INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX snapshots_node_idx ON snapshots (node_id, captured_at);
--> statement-breakpoint
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
