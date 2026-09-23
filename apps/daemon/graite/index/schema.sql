-- Graite database. Page indexes are derived; AI conversations, runs and settings are durable.
-- Use additive migrations in db.py. Never erase the database for a version mismatch.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT NOT NULL,
  path TEXT PRIMARY KEY,
  parent_path TEXT,
  title TEXT NOT NULL,
  icon TEXT,
  frontmatter_json TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  mtime REAL,
  size INTEGER,
  order_key REAL,
  created TEXT,
  updated TEXT,
  has_content INTEGER NOT NULL DEFAULT 0,
  has_view INTEGER NOT NULL DEFAULT 0,
  body_hash TEXT,
  indexed_at TEXT,
  index_error TEXT,
  summary TEXT,
  summary_hash TEXT
);
CREATE INDEX IF NOT EXISTS ix_pages_parent ON pages(parent_path);
CREATE INDEX IF NOT EXISTS ix_pages_id ON pages(id);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  path TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_activities_ts ON activities(ts);

-- Search index: one row per section of a page. Vectors live in chunk_vec, created by the
-- embedder once the embedding model (and therefore the dimension) is known.
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  page_path TEXT NOT NULL,
  page_id TEXT NOT NULL DEFAULT '',
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  heading_path TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'section',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  embedded_model TEXT,
  UNIQUE (page_path, ord)
);
CREATE INDEX IF NOT EXISTS ix_chunks_page ON chunks(page_path);
CREATE INDEX IF NOT EXISTS ix_chunks_hash ON chunks(page_path, text_hash);
CREATE INDEX IF NOT EXISTS ix_chunks_pending ON chunks(embedded_model) WHERE embedded_model IS NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  text, title, heading, content='chunks', content_rowid='id',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunk_fts(rowid, text, title, heading)
    VALUES (new.id, new.text, new.title, new.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text, title, heading)
    VALUES ('delete', old.id, old.text, old.title, old.heading);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text, title, heading ON chunks BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text, title, heading)
    VALUES ('delete', old.id, old.text, old.title, old.heading);
  INSERT INTO chunk_fts(rowid, text, title, heading)
    VALUES (new.id, new.text, new.title, new.heading);
END;

CREATE TABLE IF NOT EXISTS links (
  src_path TEXT NOT NULL,
  target TEXT NOT NULL,
  target_path TEXT,
  kind TEXT NOT NULL,
  heading TEXT,
  alias TEXT,
  chunk_id INTEGER,
  PRIMARY KEY (src_path, target, kind)
);
CREATE INDEX IF NOT EXISTS ix_links_target ON links(target_path);

-- Durable queue: what to do, when, and how often to retry.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  page_path TEXT,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  run_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_by TEXT,
  locked_at TEXT,
  progress_json TEXT,
  result_json TEXT,
  error TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_jobs_ready ON jobs(status, priority, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_key ON jobs(key) WHERE status IN ('pending', 'running');

-- Execution record: what a chat turn, agent, workflow or job actually did.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  conversation_id TEXT,
  job_id TEXT,
  parent_run_id TEXT,
  agent TEXT,
  workflow TEXT,
  page_path TEXT,
  scope_json TEXT NOT NULL DEFAULT '{}',
  mode TEXT,
  provider TEXT,
  model TEXT,
  cloud INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  input_json TEXT,
  state_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER
);
CREATE INDEX IF NOT EXISTS ix_runs_conversation ON runs(conversation_id, started_at);
CREATE INDEX IF NOT EXISTS ix_runs_status ON runs(status, started_at);

CREATE TABLE IF NOT EXISTS run_steps (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  input_json TEXT,
  output_json TEXT,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_run_steps_run ON run_steps(run_id, ord);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  text TEXT,
  text_status TEXT NOT NULL DEFAULT 'pending',
  pages INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attachments_conversation ON attachments(conversation_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  page_id TEXT,
  title TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  scope_json TEXT NOT NULL DEFAULT '{"kind":"vault","roots":[],"excluded":[]}',
  mode TEXT NOT NULL DEFAULT 'ask',
  created_at TEXT,
  updated_at TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'chat'  -- chat | assistant (the personal assistant's sessions)
);
CREATE INDEX IF NOT EXISTS ix_conversations_page ON conversations(page_id, updated_at);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scopes TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_jobs (id TEXT PRIMARY KEY, state TEXT);
CREATE TABLE IF NOT EXISTS model_downloads (id TEXT PRIMARY KEY, state TEXT);

-- Reserved for the review queue, scheduling and entities (later phases).
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  conversation_id TEXT,
  page_path TEXT NOT NULL,
  page_id TEXT,
  kind TEXT NOT NULL,
  base_hash TEXT,
  old_text TEXT,
  new_text TEXT,
  patch TEXT,
  summary TEXT,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  policy TEXT,
  decided_by TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  applied_version TEXT,
  page_title TEXT,
  new_path TEXT,
  snapshot TEXT,
  trash_id TEXT,
  applied_hash TEXT,
  properties_json TEXT,
  base_properties_json TEXT,
  parent_proposal_id TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  reason_delivered INTEGER NOT NULL DEFAULT 0,
  base_body_hash TEXT,
  opt_in_source TEXT
);
CREATE INDEX IF NOT EXISTS ix_proposals_status ON proposals(status, created_at);
CREATE INDEX IF NOT EXISTS ix_proposals_conversation ON proposals(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS ix_proposals_page ON proposals(page_path);

CREATE TABLE IF NOT EXISTS cron (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  expr TEXT NOT NULL,
  source TEXT NOT NULL,
  job_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  page_path TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT,
  page_path TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_entities_name ON entities(kind, lower(name));
CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  page_path TEXT NOT NULL,
  chunk_id INTEGER,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_id, page_path, chunk_id)
);
CREATE INDEX IF NOT EXISTS ix_mentions_page ON entity_mentions(page_path);
