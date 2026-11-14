// Near matches: Lightroom assets with no checksum match in the library index that
// probably do have a local counterpart (a converted or re-encoded copy), found by
// file name and capture day. Nothing here is recorded as a match: it is a report.
const { ensureSchema } = require('./lrcatalog');

const LIMIT = 5000;
// Sidecar files share a base name with the picture but are not a copy of it.
const SIDECAR = new Set(['xmp', 'thm', 'lrv', 'aae', 'json', 'txt']);

/** File name without folder or extension, lower case. */
function baseName(name) {
  let s = String(name || '');
  const slash = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (slash >= 0) s = s.slice(slash + 1);
  const dot = s.lastIndexOf('.');
  if (dot > 0) s = s.slice(0, dot);
  return s.toLowerCase();
}

function extOf(name) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  return dot > 0 ? s.slice(dot + 1).toLowerCase() : '';
}

const pad = (n) => String(n).padStart(2, '0');

/** The day of a modified time, both in UTC and in this computer's time zone. */
function daysOf(ms) {
  if (!ms) return [];
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return [];
  const utc = d.toISOString().slice(0, 10);
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return utc === local ? [utc] : [utc, local];
}

/**
 * opts: { limit } (rows returned, default 5000).
 * Returns { lrOnly, matched, unmatched, high, low, rows, truncated }.
 * Totals cover every asset, not only the rows returned.
 * confidence: 'high' = same base name and a local copy modified on the capture day;
 * 'low' = same base name only (camera counters wrap, so this is weak).
 */
function nearMatches(db, opts = {}) {
  ensureSchemaIfWritable(db);
  const limit = opts.limit || LIMIT;
  const letter = new Map(db.prepare('SELECT serial, last_letter FROM volumes').all().map((v) => [v.serial, v.last_letter]));

  // Index of local files by base name, built once. Checksums seen locally in the same pass.
  const localSha = new Set();
  const byBase = new Map();
  for (const f of db.prepare('SELECT vol, rel, size, mtime_ms, sha256 FROM lib_files').all()) {
    if (f.sha256) localSha.add(f.sha256);
    if (SIDECAR.has(extOf(f.rel))) continue;
    const key = baseName(f.rel);
    if (!key) continue;
    const list = byBase.get(key);
    if (list) list.push(f); else byBase.set(key, [f]);
  }

  const tally = () => ({ files: 0, bytes: 0 });
  const lrOnly = tally();
  const matched = tally();
  const unmatched = tally();
  const high = tally();
  const low = tally();
  const add = (t, size) => { t.files += 1; t.bytes += size || 0; };

  const seen = new Set();
  const rows = [];
  for (const a of db.prepare('SELECT sha256, size, name, capture_date FROM lr_assets WHERE sha256 IS NOT NULL').all()) {
    if (localSha.has(a.sha256) || seen.has(a.sha256)) continue;
    seen.add(a.sha256);
    add(lrOnly, a.size);
    const hits = a.name ? byBase.get(baseName(a.name)) : null;
    if (!hits) { add(unmatched, a.size); continue; }
    const day = a.capture_date ? String(a.capture_date).slice(0, 10) : '';
    const sameDay = day ? hits.filter((f) => daysOf(f.mtime_ms).includes(day)) : [];
    const confidence = sameDay.length ? 'high' : 'low';
    add(matched, a.size);
    add(confidence === 'high' ? high : low, a.size);
    rows.push({
      name: a.name,
      captureDate: a.capture_date || null,
      lrSize: a.size,
      confidence,
      // With a same-day copy, list only those: the other same-named files are likely counter wraps.
      local: (sameDay.length ? sameDay : hits).map((f) => ({ path: `${letter.get(f.vol) || '?'}${f.rel}`, size: f.size })),
    });
  }

  rows.sort((x, y) => (x.confidence === y.confidence ? (y.lrSize || 0) - (x.lrSize || 0) : x.confidence === 'high' ? -1 : 1));
  return { lrOnly, matched, unmatched, high, low, rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Make sure the Lightroom tables exist; skipped on a read-only database. */
function ensureSchemaIfWritable(db) {
  try {
    ensureSchema(db);
  } catch {
    // read-only connection: the tables are already there or the queries below will say so
  }
}

module.exports = { nearMatches };
