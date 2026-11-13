const { DatabaseSync } = require('node:sqlite');
const { pin } = require('./volumes');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- One row per card *format*: the volume serial changes when a card is formatted.
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  label TEXT,
  size INTEGER,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- One row per media file seen on a card.
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  rel_path TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  capture_date TEXT NOT NULL,
  sha256 TEXT,
  shoot TEXT,
  first_seen TEXT NOT NULL,
  UNIQUE (card_id, rel_path, size)
);
CREATE INDEX IF NOT EXISTS files_size_name ON files (size, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS files_date ON files (capture_date);

-- Every place a file is known to live. kind: primary | backup | lightroom | found
-- verified = 1 means the copy's checksum matched the card file.
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  import_id INTEGER,
  UNIQUE (file_id, path)
);
CREATE INDEX IF NOT EXISTS locations_file ON locations (file_id);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  shoot TEXT,
  dest TEXT,
  backup TEXT,
  started TEXT NOT NULL,
  finished TEXT,
  files_copied INTEGER DEFAULT 0,
  files_skipped INTEGER DEFAULT 0,
  files_failed INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // A name the user gives the physical card ("Card 3"). The volume serial changes on
  // every format, so the name is what ties one physical card's history together.
  if (!db.prepare('PRAGMA table_info(cards)').all().some((c) => c.name === 'nickname')) {
    db.exec('ALTER TABLE cards ADD COLUMN nickname TEXT');
  }
  // Locations are tied to the drive they are on (vol = volume serial, rel = path within
  // it), so they survive the drive coming back under a different letter. See volumes.js.
  if (!db.prepare('PRAGMA table_info(locations)').all().some((c) => c.name === 'vol')) {
    db.exec('ALTER TABLE locations ADD COLUMN vol TEXT; ALTER TABLE locations ADD COLUMN rel TEXT;');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS volumes (serial TEXT PRIMARY KEY, label TEXT, last_letter TEXT, last_seen TEXT);
           CREATE INDEX IF NOT EXISTS locations_vol ON locations (vol);`);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function setSettings(db, obj) {
  const st = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  tx(db, () => {
    for (const [k, v] of Object.entries(obj)) st.run(k, v == null ? '' : String(v));
  });
}

/** Record that a file lives at a path. Upserts on (file, path). */
function addLocation(db, fileId, kind, p, verified, importId) {
  const { vol, rel } = pin(p);
  db.prepare(
    `INSERT INTO locations (file_id, kind, path, verified, verified_at, import_id, vol, rel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_id, path) DO UPDATE SET
       verified = MAX(verified, excluded.verified),
       verified_at = COALESCE(excluded.verified_at, verified_at),
       vol = COALESCE(excluded.vol, vol),
       rel = COALESCE(excluded.rel, rel)`
  ).run(fileId, kind, p, verified ? 1 : 0, verified ? new Date().toISOString() : null, importId ?? null, vol, rel);
}

module.exports = { openDb, tx, getSettings, setSettings, addLocation };
