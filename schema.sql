CREATE TABLE IF NOT EXISTS hotel_calls (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Core routing
  conversation_id     TEXT NOT NULL,
  status              TEXT,
  caller_phone        TEXT,
  transcript          TEXT,

  -- Dashboard metrics
  duration            INTEGER,
  has_audio           INTEGER,   -- boolean stored as 0/1
  has_user_audio      INTEGER,
  has_response_audio  INTEGER,

  -- ElevenLabs native analysis
  issue_category      TEXT,
  caller_name         TEXT,
  sentiment           TEXT,

  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hotel_reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,       -- 'google' or 'tripadvisor'
  author       TEXT,
  rating       INTEGER,             -- 1-5
  text         TEXT,
  published_at TEXT,
  phone_flag   INTEGER DEFAULT 0,
  suggestion   TEXT,
  fetched_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
