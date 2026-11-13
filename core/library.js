const path = require('node:path');
const { albumsForAsset } = require('./lrcatalog');
const { existsCache, cardFolder, pickFiles, LR_PLACE } = require('./util');

/**
 * The map: one row per capture date per card, with every folder those files
 * are known to live in. q filters by file name, shoot, date, card or folder.
 */
function overview(db, q) {
  const like = q ? `%${q}%` : null;
  const where = like
    ? `WHERE f.name LIKE ? OR f.shoot LIKE ? OR f.capture_date LIKE ? OR c.label LIKE ? OR c.nickname LIKE ?
         OR EXISTS (SELECT 1 FROM locations l WHERE l.file_id = f.id AND l.path LIKE ?)`
    : '';
  const files = db
    .prepare(
      `SELECT f.id, f.size, f.capture_date, f.shoot, f.card_id, COALESCE(NULLIF(c.nickname, ''), c.label) AS label, c.serial
       FROM files f JOIN cards c ON c.id = f.card_id ${where}`
    )
    .all(...(like ? [like, like, like, like, like, like] : []));

  const locsByFile = new Map();
  for (const l of db.prepare('SELECT file_id, kind, path, verified FROM locations').all()) {
    if (!locsByFile.has(l.file_id)) locsByFile.set(l.file_id, []);
    locsByFile.get(l.file_id).push(l);
  }

  const exists = existsCache();
  const groups = new Map();
  for (const f of files) {
    const key = `${f.capture_date}|${f.card_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        date: f.capture_date, cardId: f.card_id, cardLabel: f.label, cardSerial: f.serial,
        count: 0, bytes: 0, unplaced: 0, shoots: new Set(), places: new Map(),
      });
    }
    const g = groups.get(key);
    g.count += 1;
    g.bytes += f.size;
    if (f.shoot) g.shoots.add(f.shoot);
    const ls = locsByFile.get(f.id) || [];
    if (!ls.length) g.unplaced += 1;
    for (const l of ls) {
      const dir = l.path.startsWith('lightroom:') ? (l.verified ? LR_PLACE : 'Lightroom library (upload not confirmed)') : path.dirname(l.path);
      const pk = `${l.kind}|${dir}`;
      if (!g.places.has(pk)) {
        const virtual = l.path.startsWith('lightroom:');
        g.places.set(pk, { kind: l.kind, dir, count: 0, exists: virtual || exists(dir), virtual });
      }
      g.places.get(pk).count += 1;
    }
  }

  return [...groups.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.cardId - b.cardId))
    .map((g) => ({ ...g, shoots: [...g.shoots], places: [...g.places.values()] }));
}

/**
 * Individual files with every recorded location.
 * q: { cardId, date } | { cardId, folder } (folder on the card) | { dir } (a folder on disk)
 */
function listFiles(db, q) {
  let files;
  if (q.dir) {
    const sep = q.dir.endsWith('\\') ? '' : '\\';
    files = db
      .prepare(
        `SELECT DISTINCT f.* FROM files f JOIN locations l ON l.file_id = f.id
         WHERE substr(l.path, 1, ?) = ? COLLATE NOCASE AND instr(substr(l.path, ?), '\\') = 0`
      )
      .all(q.dir.length + sep.length, q.dir + sep, q.dir.length + sep.length + 1);
  } else {
    files = db.prepare('SELECT * FROM files WHERE card_id = ?').all(q.cardId);
    const pick = pickFiles({ dates: q.date ? [q.date] : null, folders: q.folder ? [q.folder] : null });
    if (pick) files = files.filter(pick);
  }
  const exists = existsCache();
  const lrAlbums = (assetId) => {
    try {
      return albumsForAsset(db, assetId);
    } catch {
      return []; // no Lightroom cache yet
    }
  };
  const locs = db.prepare('SELECT kind, path, verified, verified_at FROM locations WHERE file_id = ? ORDER BY kind, path');
  return files
    .sort((a, b) => (a.rel_path < b.rel_path ? -1 : 1))
    .map((f) => ({
      id: f.id, name: f.name, relPath: f.rel_path, folder: cardFolder(f.rel_path), size: f.size, mtime: f.mtime_ms,
      date: f.capture_date, shoot: f.shoot, sha256: f.sha256, cardId: f.card_id,
      locations: locs.all(f.id).map((l) => ({
        ...l,
        exists: exists(l.path),
        // For a Lightroom catalog match, the albums that photo is in.
        albums: l.path.startsWith('lightroom:') ? lrAlbums(l.path.slice('lightroom:'.length)) : undefined,
      })),
    }));
}

module.exports = { overview, listFiles };
