CREATE TABLE IF NOT EXISTS SyncJob (
  id TEXT PRIMARY KEY NOT NULL,
  shop TEXT NOT NULL,
  listingType TEXT NOT NULL,
  vendor TEXT NOT NULL,
  isInitialSync INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  cursor INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  deletePayload TEXT,
  deleteCursor INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS SyncJob_shop_idx ON SyncJob(shop);
CREATE INDEX IF NOT EXISTS SyncJob_status_idx ON SyncJob(status);
