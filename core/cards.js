const fs = require('node:fs');
const path = require('node:path');
const { tx } = require('./db');
const { walkMedia, localDate, nowIso, existsCache, cardFolder, Cancelled } = require('./util');

/**
 * Read a mounted card and record every media file on it. Never writes to the card.
 * Returns { cardId, presentIds } where presentIds are the files on the card right now.
 */
async function scanCard(db, drive, job, emit) {
  const root = `${drive.letter}\\`;
  const found = [];
  for await (const full of walkMedia(root)) {
    if (job && job.cancelled) throw new Cancelled();
    let st;
    try {
      st = await fs.promises.stat(full);
    } catch {
      continue;
    }
    found.push({ rel: full.slice(root.length), name: path.basename(full), size: st.size, mtime: Math.round(st.mtimeMs) });
    if (emit && found.length % 100 === 0) emit({ label: `Reading card: ${found.length} files` });
  }

  const now = nowIso();
  return tx(db, () => {
    db.prepare(
      `INSERT INTO cards (serial, label, size, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(serial) DO UPDATE SET label = excluded.label, size = excluded.size, last_seen = excluded.last_seen`
    ).run(drive.serial, drive.label, drive.size, now, now);
    const cardId = db.prepare('SELECT id FROM cards WHERE serial = ?').get(drive.serial).id;

    const sel = db.prepare('SELECT id FROM files WHERE card_id = ? AND rel_path = ? AND size = ?');
    const ins = db.prepare(
      'INSERT INTO files (card_id, rel_path, name, size, mtime_ms, capture_date, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const presentIds = [];
    for (const f of found) {
      const row = sel.get(cardId, f.rel, f.size);
      if (row) presentIds.push(row.id);
      else presentIds.push(Number(ins.run(cardId, f.rel, f.name, f.size, f.mtime, localDate(f.mtime), now).lastInsertRowid));
    }
    return { cardId, presentIds };
  });
}

/**
 * Per-date status for a card. If presentIds is given, only those files (what is
 * on the card now) are counted; otherwise everything ever seen on that card.
 */
function cardSummary(db, cardId, presentIds) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) return null;
  let files = db.prepare('SELECT id, rel_path, size, capture_date, shoot FROM files WHERE card_id = ?').all(cardId);
  if (presentIds) {
    const set = new Set(presentIds);
    files = files.filter((f) => set.has(f.id));
  }
  const locs = db
    .prepare('SELECT l.file_id, l.kind, l.path, l.vol, l.verified FROM locations l JOIN files f ON f.id = l.file_id WHERE f.card_id = ?')
    .all(cardId);
  const exists = existsCache();
  const byFile = new Map();
  for (const l of locs) {
    if (!l.verified || !exists(l.path, l.vol)) continue;
    if (!byFile.has(l.file_id)) byFile.set(l.file_id, []);
    byFile.get(l.file_id).push(l);
  }

  // The same files grouped two ways: by capture date and by folder on the card.
  const byDate = new Map();
  const byFolder = new Map();
  const blank = (key) => ({ key, count: 0, bytes: 0, copied: 0, lightroom: 0, safe: 0, shoots: new Set(), dates: new Set() });
  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, blank(key));
    return map.get(key);
  };
  const totals = { count: 0, bytes: 0, copied: 0, lightroom: 0, safe: 0 };
  for (const f of files) {
    const g = bucket(byDate, f.capture_date);
    const d = bucket(byFolder, cardFolder(f.rel_path));
    const ls = byFile.get(f.id) || [];
    const copied = ls.some((l) => l.kind !== 'lightroom');
    const lr = ls.some((l) => l.kind === 'lightroom');
    const safe = ls.length >= 2;
    for (const t of [g, d, totals]) {
      t.count += 1;
      t.bytes += f.size;
      if (copied) t.copied += 1;
      if (lr) t.lightroom += 1;
      if (safe) t.safe += 1;
    }
    for (const t of [g, d]) {
      if (f.shoot) t.shoots.add(f.shoot);
      t.dates.add(f.capture_date);
    }
  }
  const out = (map, desc) =>
    [...map.values()]
      .sort((a, b) => (a.key < b.key ? -1 : 1) * (desc ? -1 : 1))
      .map((g) => {
        const dates = [...g.dates].sort();
        return { ...g, shoots: [...g.shoots], dates: undefined, firstDate: dates[0], lastDate: dates[dates.length - 1] };
      });

  return {
    card,
    totals,
    safeToFormat: totals.count > 0 && totals.safe === totals.count,
    groups: out(byDate, true),
    folders: out(byFolder, false),
  };
}

module.exports = { scanCard, cardSummary };
