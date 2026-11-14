// Find a file anywhere CardMap knows about: on a card, in your folders (library index
// and recorded copies), or in the Lightroom catalog. Matches by file name or path, by
// checksum, or by date. Results are grouped per file: once a checksum is known, every
// place holding that exact file is listed together, whatever it is called there.
const fs = require('node:fs');
const path = require('node:path');
const { currentPath, online, pathExists, describe } = require('./volumes');
const { albumsForAsset } = require('./lrcatalog');
const { localDate } = require('./util');

const MAX_ROWS = 2000; // per source, before grouping

function lookup(db, query, opts = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return { groups: [], truncated: false };
  const mounted = opts.mounted || {}; // card serial -> letter
  const limit = opts.limit || 300;
  const isSha = /^[0-9a-f]{8,64}$/i.test(q);
  const isDate = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(q);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const shaLike = `${q.toLowerCase()}%`;
  let truncated = false;
  const all = (sql, ...args) => {
    const rows = db.prepare(`${sql} LIMIT ${MAX_ROWS + 1}`).all(...args);
    if (rows.length > MAX_ROWS) {
      truncated = true;
      rows.length = MAX_ROWS;
    }
    return rows;
  };
  const hasLr = Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'lr_assets'").get());
  const hasLib = Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'lib_files'").get());

  // ---- matches from each source ----
  const cardRows = all(
    `SELECT f.*, c.serial, COALESCE(NULLIF(c.nickname, ''), c.label) AS card FROM files f JOIN cards c ON c.id = f.card_id
     WHERE f.name LIKE ? ESCAPE '\\' OR f.rel_path LIKE ? ESCAPE '\\' OR f.shoot LIKE ? ESCAPE '\\'
        ${isSha ? 'OR f.sha256 LIKE ?' : ''} ${isDate ? 'OR f.capture_date LIKE ?' : ''}`,
    like, like, like, ...(isSha ? [shaLike] : []), ...(isDate ? [`${q}%`] : [])
  );
  // Recorded copies (imports, found copies) whose path matches.
  const copyRows = all(
    `SELECT f.*, c.serial, COALESCE(NULLIF(c.nickname, ''), c.label) AS card FROM locations l JOIN files f ON f.id = l.file_id JOIN cards c ON c.id = f.card_id
     WHERE l.kind != 'lightroom' AND l.path LIKE ? ESCAPE '\\'`,
    like
  );
  let libRows = [];
  if (hasLib) {
    const dateRange = isDate ? dayRange(q) : null;
    libRows = all(
      `SELECT * FROM lib_files WHERE rel LIKE ? ESCAPE '\\'
        ${isSha ? 'OR sha256 LIKE ?' : ''} ${dateRange ? 'OR (mtime_ms >= ? AND mtime_ms < ?)' : ''}`,
      like, ...(isSha ? [shaLike] : []), ...(dateRange || [])
    );
  }
  const lrRows = hasLr
    ? all(
        `SELECT * FROM lr_assets WHERE name LIKE ? ESCAPE '\\' ${isSha ? 'OR sha256 LIKE ?' : ''} ${isDate ? 'OR capture_date LIKE ?' : ''}`,
        like, ...(isSha ? [shaLike] : []), ...(isDate ? [`${q}%`] : [])
      )
    : [];

  // ---- group them: one entry per file ----
  const groups = new Map();
  const keyFor = (sha, name, size) => (sha ? `s:${sha}` : `n:${String(name || '').toLowerCase()}|${size}`);
  const group = (sha, name, size) => {
    const k = keyFor(sha, name, size);
    if (!groups.has(k)) groups.set(k, { key: k, sha256: sha || null, names: new Set(), size, date: null, places: [], seen: new Set() });
    const g = groups.get(k);
    if (name) g.names.add(name);
    return g;
  };
  const add = (g, place) => {
    const id = `${place.kind}|${place.path || place.label}`;
    if (g.seen.has(id)) return;
    g.seen.add(id);
    g.places.push(place);
  };

  const addCardFile = (f) => {
    const g = group(f.sha256, f.name, f.size);
    g.date = g.date || f.capture_date;
    const letter = mounted[f.serial];
    const onCard = letter ? path.join(`${letter}\\`, f.rel_path) : null;
    add(g, { kind: 'card', label: `${f.card} · ${f.rel_path}`, path: onCard, exists: Boolean(onCard && fs.existsSync(onCard)), offline: !letter });
    for (const l of db.prepare("SELECT kind, path, vol, verified FROM locations WHERE file_id = ? AND kind != 'lightroom'").all(f.id)) {
      const off = !online(l.vol);
      add(g, { kind: l.kind, path: l.path, label: l.path, exists: pathExists(l.path, l.vol), offline: off, drive: off ? describe(db, l.vol) : '', verified: Boolean(l.verified) });
    }
  };
  const addLibFile = (r) => {
    const g = group(r.sha256, path.basename(r.rel), r.size);
    if (!g.date) g.date = localDate(r.mtime_ms);
    const off = !online(r.vol);
    const p = r.vol ? currentPath({ vol: r.vol, rel: r.rel, path: `?${r.rel}` }) : r.rel;
    add(g, { kind: 'index', path: off ? null : p, label: off ? r.rel : p, exists: !off && fs.existsSync(p), offline: off, drive: off ? describe(db, r.vol) : '', verified: Boolean(r.sha256) });
  };
  const addLr = (a) => {
    const g = group(a.sha256, a.name, a.size);
    g.date = g.date || a.capture_date;
    let albums = [];
    try {
      albums = albumsForAsset(db, a.asset_id);
    } catch {
      albums = [];
    }
    add(g, { kind: 'lightroom', label: albums.length ? albums.join('; ') : 'In the library, not in an album', path: `lightroom:${a.asset_id}`, exists: true, verified: true });
  };

  for (const f of cardRows) addCardFile(f);
  for (const f of copyRows) addCardFile(f);
  for (const r of libRows) addLibFile(r);
  for (const a of lrRows) addLr(a);

  // A file with no checksum yet (a card file not read, say) that has the same name and
  // exact size as a file with one is almost certainly the same file. Show it in that
  // file's row, marked as not compared, instead of as a separate result.
  const bySizeName = new Map();
  for (const g of groups.values()) {
    if (!g.sha256) continue;
    for (const n of g.names) bySizeName.set(`${String(n).toLowerCase()}|${g.size}`, g);
  }
  for (const [k, g] of [...groups]) {
    if (g.sha256) continue;
    const target = bySizeName.get(k.slice(2));
    if (!target) continue;
    for (const p of g.places) add(target, { ...p, unconfirmed: true });
    for (const n of g.names) target.names.add(n);
    target.date = target.date || g.date;
    groups.delete(k);
  }

  // Every other place the same file is known, matched by checksum.
  let list = [...groups.values()];
  if (list.length > limit) truncated = true;
  list = list.sort((a, b) => [...a.names][0].localeCompare([...b.names][0], undefined, { numeric: true })).slice(0, limit);
  const filesBySha = db.prepare('SELECT f.*, c.serial, COALESCE(NULLIF(c.nickname, \'\'), c.label) AS card FROM files f JOIN cards c ON c.id = f.card_id WHERE f.sha256 = ?');
  const libBySha = hasLib ? db.prepare('SELECT * FROM lib_files WHERE sha256 = ?') : null;
  const lrBySha = hasLr ? db.prepare('SELECT * FROM lr_assets WHERE sha256 = ?') : null;
  for (const g of list) {
    if (!g.sha256) continue;
    for (const f of filesBySha.all(g.sha256)) addCardFile(f);
    if (libBySha) for (const r of libBySha.all(g.sha256)) addLibFile(r);
    if (lrBySha) for (const a of lrBySha.all(g.sha256)) addLr(a);
  }

  return {
    truncated,
    groups: list.map((g) => {
      const open = g.places.find((p) => p.exists && p.path && !p.path.startsWith('lightroom:') && p.kind !== 'card')
        || g.places.find((p) => p.exists && p.kind === 'card');
      return {
        key: g.key, names: [...g.names], size: g.size, date: g.date, sha256: g.sha256,
        places: g.places, openPath: open ? open.path : null,
        copies: g.places.filter((p) => p.kind !== 'card').length,
      };
    }),
  };
}

/** Local-time bounds, in ms, for "2026", "2026-05" or "2026-05-06". */
function dayRange(q) {
  const [y, m, d] = q.split('-').map(Number);
  const start = new Date(y, m ? m - 1 : 0, d || 1);
  const end = d ? new Date(y, m - 1, d + 1) : m ? new Date(y, m, 1) : new Date(y + 1, 0, 1);
  return [start.getTime(), end.getTime()];
}

module.exports = { lookup };
