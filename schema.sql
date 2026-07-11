DROP TABLE IF EXISTS hotel_calls;

CREATE TABLE hotel_calls (
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
