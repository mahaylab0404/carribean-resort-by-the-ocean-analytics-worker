DROP TABLE IF EXISTS hotel_calls;

CREATE TABLE hotel_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  duration        INTEGER,
  status          TEXT,
  transcript      TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
