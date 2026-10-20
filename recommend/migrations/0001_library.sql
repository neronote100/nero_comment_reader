PRAGMA foreign_keys = ON;
CREATE TABLE members (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, note_username TEXT UNIQUE,
 profile_url TEXT NOT NULL DEFAULT '', account_url TEXT NOT NULL DEFAULT '',
 discord_name TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
 priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 100),
 status TEXT NOT NULL CHECK(status IN ('active','withdraw','pending')),
 received_at TEXT NOT NULL, joined_at TEXT NOT NULL, last_event_at TEXT NOT NULL, last_status_at TEXT NOT NULL DEFAULT '',
 last_introduced_at TEXT, plan TEXT NOT NULL DEFAULT '',
 synced_at TEXT, sync_error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX members_status_joined ON members(status, joined_at);
CREATE TABLE membership_events (
 id TEXT PRIMARY KEY, member_id TEXT REFERENCES members(id),
 received_at TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
 subject TEXT NOT NULL, candidate_username TEXT, candidate_name TEXT, plan_name TEXT,
 reason TEXT, resolved_at TEXT
);
CREATE TABLE articles (
 id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
 title TEXT NOT NULL, url TEXT NOT NULL UNIQUE, published_at TEXT NOT NULL,
 likes INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0,
 tags TEXT NOT NULL DEFAULT '[]', thumbnail TEXT NOT NULL DEFAULT '',
 body TEXT NOT NULL DEFAULT '', body_hash TEXT NOT NULL DEFAULT '',
 body_status TEXT NOT NULL DEFAULT 'unavailable', collected_at TEXT NOT NULL,
 participated INTEGER NOT NULL DEFAULT 0 CHECK(participated IN (0,1)),
 favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
 available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1))
);
CREATE INDEX articles_member ON articles(member_id, published_at);
CREATE TABLE article_snapshots (
 article_id TEXT NOT NULL REFERENCES articles(id), day TEXT NOT NULL,
 likes INTEGER NOT NULL, comments INTEGER NOT NULL, sampled_at TEXT NOT NULL,
 PRIMARY KEY(article_id, day)
);
CREATE TABLE analyses (
 article_id TEXT PRIMARY KEY REFERENCES articles(id), body_hash TEXT NOT NULL,
 data TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE introductions (
 id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id),
 article_id TEXT NOT NULL REFERENCES articles(id), published_url TEXT NOT NULL,
 introduced_at TEXT NOT NULL
);
CREATE INDEX introductions_member ON introductions(member_id, introduced_at);
CREATE TABLE jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 run_after INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX jobs_pending ON jobs(state, run_after, locked_until);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
