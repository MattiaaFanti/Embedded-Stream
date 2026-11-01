-- Presence is a short-lived signal from open, authenticated HTSport tabs.
-- Browser/device ids are random and do not identify physical hardware.
-- One device can have multiple tabs; they are deduplicated in admin queries.
CREATE TABLE IF NOT EXISTS presence_tabs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  area TEXT NOT NULL CHECK(area IN ('home','player')),
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id, tab_id)
);
CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON presence_tabs(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_presence_user_last_seen ON presence_tabs(user_id,last_seen_at);
