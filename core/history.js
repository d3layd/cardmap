// A record of each drive over time: when it was scanned or changed, how many indexed
// files it held, what was added or removed, and how full it was.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS drive_history (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,          -- ISO time
  day TEXT NOT NULL,         -- local date, for folding file changes into one row a day
  vol TEXT NOT NULL,         -- drive serial
  letter TEXT,
  label TEXT,
  reason TEXT NOT NULL,      -- what caused it (see REASONS)
  files INTEGER,             -- indexed files on the drive afterwards
  bytes INTEGER,
  hashed INTEGER,            -- of those, how many have a checksum
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  size INTEGER,              -- drive capacity
  free INTEGER               -- free space at the time
);
CREATE INDEX IF NOT EXISTS drive_history_vol ON drive_history (vol, at);
`;

const REASONS = {
  opened: 'Checked when CardMap opened',
  connected: 'Checked when the drive was connected',
  timer: 'Regular check',
  manual: 'Scan you started',
  changes: 'File changes seen',
};

const ensure = (db) => {
  db.exec(SCHEMA);
  const cols = db.prepare('PRAGMA table_info(lib_files)').all();
  if (cols.length && !cols.some((c) => c.name === 'added_at')) db.exec('ALTER TABLE lib_files ADD COLUMN added_at TEXT');
  // How the drive was checked: walk (every folder listed) or search (Windows Search asked what changed).
  if (!db.prepare('PRAGMA table_info(drive_history)').all().some((c) => c.name === 'method')) db.exec('ALTER TABLE drive_history ADD COLUMN method TEXT');
};
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function totals(db, vol) {
  return db
    .prepare('SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes, coalesce(sum(sha256 IS NOT NULL), 0) AS hashed FROM lib_files WHERE vol = ?')
    .get(vol);
}

/**
 * After a scan: one row per drive with its totals now, and what was added or removed
 * since the drive's previous row. volumes: [{ serial, letter, label, size, free }]
 */
function recordScan(db, volumes, reason, methods = {}) {
  ensure(db);
  const now = new Date();
  const last = db.prepare('SELECT * FROM drive_history WHERE vol = ? ORDER BY at DESC LIMIT 1');
  const addedSince = db.prepare('SELECT count(*) AS n FROM lib_files WHERE vol = ? AND added_at > ?');
  const ins = db.prepare(
    'INSERT INTO drive_history (at, day, vol, letter, label, reason, files, bytes, hashed, added, removed, size, free, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const v of volumes) {
    const t = totals(db, v.serial);
    const prev = last.get(v.serial);
    // added_at is stored by SQLite as "YYYY-MM-DD HH:MM:SS" (UTC).
    const since = prev ? prev.at.replace('T', ' ').slice(0, 19) : '';
    const added = prev ? addedSince.get(v.serial, since).n : 0; // nothing to compare the first record with
    const removed = prev ? Math.max(0, prev.files + added - t.files) : 0;
    ins.run(now.toISOString(), localDay(now), v.serial, v.letter, v.label || '', reason, t.files, t.bytes, t.hashed, added, removed, v.size || null, v.free || null, methods[v.serial] || 'walk');
  }
}

/** File changes seen by the watcher, folded into one row per drive per day. */
function recordChanges(db, byVol, volumes) {
  ensure(db);
  const now = new Date();
  const day = localDay(now);
  const find = db.prepare("SELECT id, added, removed FROM drive_history WHERE vol = ? AND day = ? AND reason = 'changes'");
  const upd = db.prepare('UPDATE drive_history SET at = ?, files = ?, bytes = ?, hashed = ?, added = ?, removed = ?, free = ? WHERE id = ?');
  const ins = db.prepare(
    "INSERT INTO drive_history (at, day, vol, letter, label, reason, files, bytes, hashed, added, removed, size, free) VALUES (?, ?, ?, ?, ?, 'changes', ?, ?, ?, ?, ?, ?, ?)"
  );
  for (const [vol, c] of Object.entries(byVol)) {
    if (!vol || (!c.added && !c.removed)) continue;
    const v = volumes.find((x) => x.serial === vol) || { serial: vol };
    const t = totals(db, vol);
    const row = find.get(vol, day);
    if (row) upd.run(now.toISOString(), t.files, t.bytes, t.hashed, row.added + c.added, row.removed + c.removed, v.free || null, row.id);
    else ins.run(now.toISOString(), day, vol, v.letter || null, v.label || '', t.files, t.bytes, t.hashed, c.added, c.removed, v.size || null, v.free || null);
  }
}

/** Newest first. */
function history(db, limit = 500) {
  ensure(db);
  const first = new Set(db.prepare('SELECT min(id) AS id FROM drive_history GROUP BY vol').all().map((r) => r.id));
  const how = { walk: ' (every folder listed)', search: ' (Windows Search asked what changed)' };
  return db
    .prepare('SELECT * FROM drive_history ORDER BY at DESC LIMIT ?')
    .all(limit)
    .map((r) => {
      const what = (REASONS[r.reason] || r.reason) + (r.reason === 'changes' ? '' : how[r.method] || '');
      return first.has(r.id) && r.reason !== 'changes' ? { ...r, added: 0, removed: 0, what: `First record: ${what}` } : { ...r, what };
    });
}

/** Every drive CardMap has recorded, with its first and latest record. */
function drivesOverTime(db) {
  ensure(db);
  return db
    .prepare(
      `SELECT h.vol, h.letter, h.label, h.files, h.bytes, h.hashed, h.size, h.free, h.at AS lastAt,
              (SELECT min(at) FROM drive_history f WHERE f.vol = h.vol) AS firstAt,
              (SELECT count(*) FROM drive_history c WHERE c.vol = h.vol) AS records,
              (SELECT max(at) FROM drive_history s WHERE s.vol = h.vol AND s.reason != 'changes') AS lastScan,
              (SELECT max(at) FROM drive_history w WHERE w.vol = h.vol AND w.reason != 'changes' AND coalesce(w.method, 'walk') = 'walk') AS lastWalk,
              v.last_seen AS lastSeen
       FROM drive_history h LEFT JOIN volumes v ON v.serial = h.vol
       WHERE h.id = (SELECT id FROM drive_history x WHERE x.vol = h.vol ORDER BY at DESC LIMIT 1)
       ORDER BY h.letter`
    )
    .all();
}

module.exports = { recordScan, recordChanges, history, drivesOverTime, REASONS };
