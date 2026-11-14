// Saved reports. The latest build of each report is kept in the database, so it
// shows straight away after a restart instead of being worked out again. Each build
// also leaves a small snapshot of its totals, so you can see how things change.
//
// A report records a signature of what it was built from. When the signature of the
// library now differs, the report is stale and is rebuilt (by hand, or on its own
// when the computer is otherwise idle).

function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS reports (kind TEXT PRIMARY KEY, built_at TEXT NOT NULL, sig TEXT, data TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS report_snapshots (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, at TEXT NOT NULL, totals TEXT NOT NULL);
           CREATE INDEX IF NOT EXISTS report_snapshots_kind ON report_snapshots (kind, at);`);
}

const one = (db, sql) => {
  try {
    return db.prepare(sql).get() || {};
  } catch {
    return {}; // table not there yet
  }
};

/**
 * A cheap fingerprint of what reports are built from: the library index (files,
 * sizes, checksums), card files with checksums and the Lightroom cache. extra: any
 * settings that change the result.
 */
function librarySig(db, extra = '') {
  const lib = one(db, 'SELECT count(*) AS n, total(size) AS b, count(sha256) AS h, max(hashed_at) AS t FROM lib_files');
  const cards = one(db, 'SELECT count(sha256) AS h FROM files');
  const lr = one(db, 'SELECT count(*) AS n, total(uploaded) AS u FROM lr_assets');
  return [lib.n, lib.b, lib.h, lib.t, cards.h, lr.n, lr.u, extra].join('|');
}

function saveReport(db, kind, sig, report, totals) {
  ensure(db);
  const at = report.builtAt || new Date().toISOString();
  db.prepare('INSERT OR REPLACE INTO reports (kind, built_at, sig, data) VALUES (?, ?, ?, ?)').run(kind, at, sig, JSON.stringify(report));
  if (totals) snapshot(db, kind, totals, at);
}

/** Note a report's totals, unless they are the same as last time. */
function snapshot(db, kind, totals, at = new Date().toISOString()) {
  ensure(db);
  const last = db.prepare('SELECT totals FROM report_snapshots WHERE kind = ? ORDER BY at DESC LIMIT 1').get(kind);
  const t = JSON.stringify(totals);
  if (!last || last.totals !== t) db.prepare('INSERT INTO report_snapshots (kind, at, totals) VALUES (?, ?, ?)').run(kind, at, t);
}

/** The saved report: { report, sig, builtAt } or null. */
function loadReport(db, kind) {
  ensure(db);
  const r = db.prepare('SELECT built_at, sig, data FROM reports WHERE kind = ?').get(kind);
  if (!r) return null;
  try {
    return { report: JSON.parse(r.data), sig: r.sig, builtAt: r.built_at };
  } catch {
    return null;
  }
}

/** Past totals for a report, newest first. */
function snapshots(db, kind, limit = 100) {
  ensure(db);
  return db
    .prepare('SELECT at, totals FROM report_snapshots WHERE kind = ? ORDER BY at DESC LIMIT ?')
    .all(kind, limit)
    .map((r) => ({ at: r.at, ...JSON.parse(r.totals) }));
}

module.exports = { librarySig, saveReport, loadReport, snapshot, snapshots };
