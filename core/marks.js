// Marks on card files: "ready" (import it) or "skip" (leave it out of imports), and a
// log per card of every mark change and import. Marks only steer CardMap; nothing on
// the card is touched.
const { tx } = require('./db');
const { nowIso } = require('./util');

const MARKS = new Set(['ready', 'skip']);

/** Set (or clear, with mark null) the mark on these files. Logs one row per file changed. */
function setMarks(db, cardId, fileIds, mark) {
  const m = MARKS.has(mark) ? mark : null;
  const get = db.prepare('SELECT id, name, mark FROM files WHERE id = ? AND card_id = ?');
  const upd = db.prepare('UPDATE files SET mark = ? WHERE id = ?');
  const log = db.prepare('INSERT INTO card_log (at, card_id, file_id, name, action, detail) VALUES (?, ?, ?, ?, ?, ?)');
  const at = nowIso();
  return tx(db, () => {
    let changed = 0;
    for (const id of fileIds) {
      const f = get.get(id, cardId);
      if (!f || (f.mark || null) === m) continue;
      upd.run(m, f.id);
      log.run(at, cardId, f.id, f.name, m || 'clear', f.mark ? `was ${f.mark}` : null);
      changed += 1;
    }
    return { changed };
  });
}

/** One log row for a finished import. */
function logImport(db, cardId, result, leftOut) {
  const parts = [`${result.copied} copied`, `${result.skipped} already copied`];
  if (result.failed) parts.push(`${result.failed} failed`);
  if (leftOut.skip) parts.push(`${leftOut.skip} marked skip left out`);
  if (leftOut.unready) parts.push(`${leftOut.unready} not marked ready left out`);
  if (result.cancelled) parts.push('stopped before the end');
  db.prepare('INSERT INTO card_log (at, card_id, file_id, name, action, detail) VALUES (?, ?, NULL, NULL, ?, ?)').run(
    nowIso(), cardId, 'import', parts.join(', ')
  );
}

/** A card's log, newest first. */
function cardLog(db, cardId, limit = 1000) {
  return db.prepare('SELECT at, file_id AS fileId, name, action, detail FROM card_log WHERE card_id = ? ORDER BY id DESC LIMIT ?').all(cardId, limit);
}

/**
 * Put these files in an import group: a profile name plus a shoot name (or take them
 * out, with profile null). Grouped files are marked ready. Logs one row per file changed.
 */
function setGroup(db, cardId, fileIds, profile, shoot) {
  const p = profile ? String(profile) : null;
  const sh = p ? String(shoot || '').trim() : null;
  const get = db.prepare('SELECT id, name, mark, grp, grp_shoot FROM files WHERE id = ? AND card_id = ?');
  const upd = db.prepare('UPDATE files SET grp = ?, grp_shoot = ?, mark = ? WHERE id = ?');
  const log = db.prepare('INSERT INTO card_log (at, card_id, file_id, name, action, detail) VALUES (?, ?, ?, ?, ?, ?)');
  const at = nowIso();
  const label = (g, s) => (g ? [g, s].filter(Boolean).join(': ') : 'no group');
  return tx(db, () => {
    let changed = 0;
    for (const id of fileIds) {
      const f = get.get(id, cardId);
      if (!f || ((f.grp || null) === p && (f.grp_shoot || null) === (sh || null))) continue;
      upd.run(p, sh || null, p ? 'ready' : f.mark === 'ready' && f.grp ? null : f.mark, f.id);
      log.run(at, cardId, f.id, f.name, 'group', `${label(p, sh)} (was ${label(f.grp, f.grp_shoot)})`);
      changed += 1;
    }
    return { changed };
  });
}

/** A card's import groups: [{ profile, shoot, files, bytes, fileIds }]. */
function cardGroups(db, cardId) {
  const groups = new Map();
  for (const f of db.prepare("SELECT id, size, grp, grp_shoot, capture_date FROM files WHERE card_id = ? AND grp IS NOT NULL AND coalesce(mark, '') != 'skip'").all(cardId)) {
    const key = `${f.grp}\u0000${f.grp_shoot || ''}`;
    const g = groups.get(key) || { profile: f.grp, shoot: f.grp_shoot || '', files: 0, bytes: 0, fileIds: [], firstDate: f.capture_date };
    if (f.capture_date && (!g.firstDate || f.capture_date < g.firstDate)) g.firstDate = f.capture_date;
    g.files += 1;
    g.bytes += f.size;
    g.fileIds.push(f.id);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.profile.localeCompare(b.profile) || a.shoot.localeCompare(b.shoot));
}

module.exports = { setMarks, setGroup, cardGroups, logImport, cardLog };
