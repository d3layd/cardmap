// Compare two drives or folders in the library index: what is only on one side, only on
// the other, and on both. Files are matched by checksum, not by name or place.
//
// Read-only: it looks at the index and never touches the files themselves. Files with no
// checksum yet are counted but left out of the comparison.

const MAX_ROWS = 5000;

/** "j:/photos/2024/" -> { letter: 'J:', folder: '\\photos\\2024' }; a drive root has folder ''. */
function parseSide(input) {
  const s = String(input || '').trim().replace(/\//g, '\\');
  const m = /^([a-zA-Z]):(.*)$/.exec(s);
  if (!m) return null;
  let folder = m[2].replace(/\\+/g, '\\').replace(/\\+$/, '');
  if (folder && !folder.startsWith('\\')) folder = `\\${folder}`;
  return { letter: `${m[1].toUpperCase()}:`, folder };
}

/** The volume that last had this letter. Several can share one: take the one with most indexed files. */
function volumeFor(db, letter) {
  return db
    .prepare(
      `SELECT v.serial, v.label, v.last_letter,
              (SELECT count(*) FROM lib_files f WHERE f.vol = v.serial) AS files
       FROM volumes v WHERE upper(v.last_letter) = ?
       ORDER BY files DESC, v.last_seen DESC LIMIT 1`
    )
    .get(letter);
}

function loadSide(db, input, name) {
  const side = parseSide(input);
  if (!side) return { error: `${name}: type a full path that starts with a drive letter, like E:\\ or E:\\Folder.` };
  const vol = volumeFor(db, side.letter);
  if (!vol) return { error: `${name}: CardMap does not know a drive ${side.letter}` };
  const shown = `${side.letter}${side.folder || '\\'}`;
  const want = side.folder.toLowerCase();
  const all = db.prepare('SELECT rel, size, sha256 FROM lib_files WHERE vol = ?').all(vol.serial);
  const rows = want
    ? all.filter((r) => {
      const rel = r.rel.toLowerCase();
      return rel === want || rel.startsWith(`${want}\\`);
    })
    : all;
  if (!rows.length) {
    return { error: all.length ? `${name}: no indexed files under ${shown}` : `${name}: nothing on ${side.letter} has been indexed yet.` };
  }
  return { path: shown, letter: side.letter, rows };
}

function onlyOn(side, other) {
  const out = { files: 0, bytes: 0, rows: [], truncated: false };
  for (const r of side.rows) {
    if (!r.sha256 || other.has(r.sha256)) continue;
    out.files += 1;
    out.bytes += r.size;
    out.rows.push({ path: side.letter + r.rel, size: r.size, sha256: r.sha256 });
  }
  out.rows.sort((x, y) => y.size - x.size || x.path.localeCompare(y.path));
  if (out.rows.length > MAX_ROWS) {
    out.rows.length = MAX_ROWS;
    out.truncated = true;
  }
  return out;
}

function summary(side, other) {
  const s = { path: side.path, files: side.rows.length, bytes: 0, unhashed: 0, inBoth: 0, inBothBytes: 0 };
  for (const r of side.rows) {
    s.bytes += r.size;
    if (!r.sha256) s.unhashed += 1;
    else if (other.has(r.sha256)) {
      s.inBoth += 1;
      s.inBothBytes += r.size;
    }
  }
  return s;
}

/**
 * a, b: full paths as typed, a drive root ("J:\") or a folder ("E:\Backups\2024").
 * Returns { a, b, both, onlyA, onlyB } or { error }.
 *  a, b:  { path, files, bytes, unhashed, inBoth, inBothBytes } (inBoth counts that side's files)
 *  both:  { files, bytes } counted once per distinct checksum found on both sides
 *  onlyA, onlyB: { files, bytes, rows: [{ path, size, sha256 }], truncated } largest first
 */
function compareSides(db, { a, b } = {}) {
  const A = loadSide(db, a, 'A');
  if (A.error) return { error: A.error };
  const B = loadSide(db, b, 'B');
  if (B.error) return { error: B.error };
  const shasA = new Map();
  for (const r of A.rows) if (r.sha256 && !shasA.has(r.sha256)) shasA.set(r.sha256, r.size);
  const shasB = new Set();
  for (const r of B.rows) if (r.sha256) shasB.add(r.sha256);
  const both = { files: 0, bytes: 0 };
  for (const [sha, size] of shasA) {
    if (!shasB.has(sha)) continue;
    both.files += 1;
    both.bytes += size;
  }
  return {
    a: summary(A, shasB),
    b: summary(B, shasA),
    both,
    onlyA: onlyOn(A, shasB),
    onlyB: onlyOn(B, shasA),
  };
}

/** Drives that have indexed files, with their top-level folders, to fill a picker. */
function listSides(db) {
  const drives = new Map();
  const vols = db.prepare('SELECT serial, label, last_letter FROM volumes WHERE last_letter IS NOT NULL').all();
  const count = db.prepare('SELECT count(*) AS n FROM lib_files WHERE vol = ?');
  for (const v of vols) {
    const files = count.get(v.serial).n;
    if (!files) continue;
    const letter = String(v.last_letter).toUpperCase();
    const had = drives.get(letter);
    if (!had || files > had.files) drives.set(letter, { letter, label: v.label || '', files, serial: v.serial });
  }
  const out = [];
  for (const d of [...drives.values()].sort((x, y) => x.letter.localeCompare(y.letter))) {
    const tops = new Map();
    for (const r of db.prepare('SELECT rel FROM lib_files WHERE vol = ?').all(d.serial)) {
      const end = r.rel.indexOf('\\', 1);
      if (end < 0) continue; // a file in the drive root
      const top = r.rel.slice(1, end);
      const key = top.toLowerCase();
      const t = tops.get(key) || { name: top, path: `${d.letter}\\${top}`, files: 0 };
      t.files += 1;
      tops.set(key, t);
    }
    out.push({
      letter: d.letter, label: d.label, files: d.files, path: `${d.letter}\\`,
      folders: [...tops.values()].sort((x, y) => x.name.localeCompare(y.name)),
    });
  }
  return out;
}

module.exports = { compareSides, listSides, parseSide };
