-- The one device notifications go to: a single row, slot 1, claimed by the first device to subscribe.

CREATE TABLE subscription (
  slot       INTEGER PRIMARY KEY CHECK (slot = 1),
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
