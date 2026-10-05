CREATE TABLE IF NOT EXISTS Session (
  id TEXT PRIMARY KEY NOT NULL,
  shop TEXT NOT NULL,
  state TEXT NOT NULL,
  isOnline INTEGER NOT NULL DEFAULT 0,
  scope TEXT,
  expires INTEGER,
  accessToken TEXT NOT NULL,
  userId TEXT
);
CREATE INDEX IF NOT EXISTS Session_shop_idx ON Session(shop);
