// One row per unique file (by checksum), across the library index, camera cards and
// Lightroom: how many copies there are, on which drives, and whether Lightroom has it.
// Lets you ask "what is only in Lightroom?", "what is not in Lightroom?" and
// "what has duplicates?" in one place.
const path = require('node:path');
const { ensureSchema } = require('./lrcatalog');

const SHOW = {
  all: () => true,
  dupes: (r) => r.local > 1,
  single: (r) => r.local === 1,
  both: (r) => r.local > 0 && r.lr,
  lronly: (r) => r.lr && r.local === 0,
  localonly: (r) => r.local > 0 && !r.lr,
  cardonly: (r) => r.cards > 0 && r.local === 0 && !r.lr,
};

let cache = null; // { at, rows }

/** Build (or reuse, for up to a minute) the full list. */
function allRows(db) {
  if (cache && Date.now() - cache.at < 60000) return cache.rows;
  ensureSchema(db);
  const hasLr = true;
  const map = new Map();
  const get = (sha, size) => {
    let r = map.get(sha);
    if (!r) {
      r = { sha256: sha, size, name: null, date: null, local: 0, vols: new Set(), cards: 0, lr: false, uploaded: false, edited: false };
      map.set(sha, r);
    }
    return r;
  };
  for (const f of db.prepare('SELECT vol, rel, size, sha256, mtime_ms FROM lib_files WHERE sha256 IS NOT NULL').all()) {
    const r = get(f.sha256, f.size);
    r.local += 1;
    r.vols.add(f.vol);
    if (!r.name) r.name = path.basename(f.rel);
    if (!r.date && f.mtime_ms) r.date = new Date(f.mtime_ms).toISOString().slice(0, 10);
  }
  for (const f of db.prepare('SELECT sha256, size, name, capture_date FROM files WHERE sha256 IS NOT NULL').all()) {
    const r = get(f.sha256, f.size);
    r.cards += 1;
    r.name = r.name || f.name;
    if (f.capture_date) r.date = f.capture_date;
  }
  if (hasLr) {
    for (const a of db.prepare('SELECT sha256, size, name, capture_date, uploaded, edited FROM lr_assets WHERE sha256 IS NOT NULL').all()) {
      const r = get(a.sha256, a.size);
      r.lr = true;
      r.uploaded = r.uploaded || Boolean(a.uploaded);
      r.edited = r.edited || Boolean(a.edited);
      r.name = r.name || a.name;
      if (a.capture_date) r.date = a.capture_date;
    }
  }
  const letter = new Map(db.prepare('SELECT serial, last_letter FROM volumes').all().map((v) => [v.serial, v.last_letter]));
  const rows = [...map.values()].map((r) => ({ ...r, drives: [...r.vols].map((v) => letter.get(v) || '?').sort().join(' '), vols: undefined }));
  cache = { at: Date.now(), rows };
  return rows;
}

/**
 * opts: { show: one of SHOW's keys, q: text to look for in the name, limit }
 * Returns totals for every view, and the matching rows (largest first, up to limit).
 */
function fileMap(db, opts = {}) {
  const rows = allRows(db);
  const totals = {};
  for (const [k, test] of Object.entries(SHOW)) {
    let n = 0;
    let bytes = 0;
    for (const r of rows) if (test(r)) { n += 1; bytes += r.size || 0; }
    totals[k] = { files: n, bytes };
  }
  const test = SHOW[opts.show] || SHOW.all;
  const q = String(opts.q || '').trim().toLowerCase();
  const hits = rows.filter((r) => test(r) && (!q || (r.name || '').toLowerCase().includes(q) || r.sha256.startsWith(q) || (r.date || '').startsWith(q)));
  hits.sort((a, b) => (b.size || 0) - (a.size || 0));
  const limit = opts.limit || 2000;
  return { totals, matching: hits.length, rows: hits.slice(0, limit), truncated: hits.length > limit, all: opts.all ? hits : undefined };
}

const forget = () => {
  cache = null;
};

module.exports = { fileMap, forget };
