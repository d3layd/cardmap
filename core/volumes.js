// Drive letters move around (a USB hub re-enumerates and J: becomes K:), so a
// recorded path is tied to the drive itself, by its volume serial number, and the
// letter is looked up fresh each time.
//
// A location is stored as: vol (volume serial), rel (path after the drive letter)
// and path (the full path as last seen). When a drive shows up under a new letter,
// the stored paths for that drive are rewritten to match.
const fs = require('node:fs');

let letterBySerial = new Map(); // "1A2B3C4D" -> "J:"
let serialByLetter = new Map(); // "J:" -> "1A2B3C4D"

/** list: [{ letter: "J:", serial, label }] for every volume connected right now. */
function setVolumes(list) {
  letterBySerial = new Map();
  serialByLetter = new Map();
  for (const v of list) {
    if (!v.serial || !v.letter) continue;
    const letter = v.letter.toUpperCase();
    letterBySerial.set(v.serial, letter);
    serialByLetter.set(letter, v.serial);
  }
}

/** Split "J:\Photos\a.nef" into the drive it is on and the path within it. */
function pin(p) {
  const m = /^([A-Za-z]:)([\\/].*)?$/.exec(p || '');
  const vol = m ? serialByLetter.get(m[1].toUpperCase()) || null : null;
  return { path: p, vol, rel: vol ? m[2] || '\\' : null };
}

/** Where a pinned path is right now. Falls back to the last-seen path if the drive is away. */
function currentPath(pinned) {
  if (!pinned) return '';
  if (typeof pinned === 'string') return pinned;
  const letter = pinned.vol ? letterBySerial.get(pinned.vol) : null;
  return letter ? `${letter}${pinned.rel}` : pinned.path;
}

/** Is the drive this location lives on connected? (True when the drive is not tracked.) */
const online = (vol) => !vol || letterBySerial.has(vol);

/** Does this recorded location exist right now? */
function pathExists(p, vol) {
  if (p.startsWith('lightroom:')) return true; // a Lightroom catalog entry, not a file on disk
  if (vol && !letterBySerial.has(vol)) return false; // its drive is not connected
  return fs.existsSync(p);
}

/**
 * Bring the database in line with the drives connected now:
 *  - remember each drive's name, so a missing one can be named;
 *  - tie older records (made before drives were tracked) to the drive under their letter;
 *  - rewrite paths for any drive that has come back under a different letter.
 * Returns how many locations were re-lettered.
 */
function syncDb(db, list) {
  const now = new Date().toISOString();
  const up = db.prepare(
    `INSERT INTO volumes (serial, label, last_letter, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(serial) DO UPDATE SET label = excluded.label, last_letter = excluded.last_letter, last_seen = excluded.last_seen`
  );
  let moved = 0;
  db.exec('BEGIN');
  try {
    for (const v of list) if (v.serial) up.run(v.serial, v.label || '', v.letter.toUpperCase(), now);

    const setVol = db.prepare('UPDATE locations SET vol = ?, rel = ? WHERE id = ?');
    for (const l of db.prepare("SELECT id, path FROM locations WHERE vol IS NULL AND path NOT LIKE 'lightroom:%'").all()) {
      const p = pin(l.path);
      if (p.vol) setVol.run(p.vol, p.rel, l.id);
    }

    const stale = db.prepare('SELECT id, file_id, rel FROM locations WHERE vol = ? AND upper(substr(path, 1, 2)) != ?');
    const clash = db.prepare('SELECT id FROM locations WHERE file_id = ? AND path = ?');
    const setPath = db.prepare('UPDATE locations SET path = ? WHERE id = ?');
    const drop = db.prepare('DELETE FROM locations WHERE id = ?');
    for (const [serial, letter] of letterBySerial) {
      for (const l of stale.all(serial, letter)) {
        const next = `${letter}${l.rel}`;
        if (clash.get(l.file_id, next)) drop.run(l.id); // already recorded under the new letter
        else setPath.run(next, l.id);
        moved += 1;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return moved;
}

/** Name of a drive for display, e.g. 'drive "Projects" (was J:)'. */
function describe(db, vol) {
  if (!vol) return '';
  const v = db.prepare('SELECT label, last_letter FROM volumes WHERE serial = ?').get(vol);
  if (!v) return 'a drive that is not connected';
  return `drive ${v.label ? `"${v.label}"` : 'with no name'}, last seen as ${v.last_letter}`;
}

module.exports = { setVolumes, pin, currentPath, online, pathExists, syncDb, describe };
