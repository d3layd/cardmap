const fs = require('node:fs');
const path = require('node:path');
const { addLocation } = require('./db');
const { walkMedia, hashFile, throttle } = require('./util');

/**
 * Look through a folder for copies of files CardMap already knows about
 * (copied by hand before, or moved since). A match needs the same name and
 * size, then the same checksum.
 *
 * opts: { folder, mounted: { [cardSerial]: 'G:' } }
 */
async function runFolderScan(db, opts, job, emit) {
  const { folder, mounted = {} } = opts;
  if (!folder || !fs.existsSync(folder)) throw new Error('That folder does not exist.');
  const cand = db.prepare(
    `SELECT f.*, c.serial FROM files f JOIN cards c ON c.id = f.card_id
     WHERE f.size = ? AND f.name = ? COLLATE NOCASE`
  );
  const known = db.prepare('SELECT 1 AS x FROM locations WHERE file_id = ? AND path = ? AND verified = 1');
  const setSha = db.prepare('UPDATE files SET sha256 = ? WHERE id = ?');
  const stale = db.prepare("SELECT id, path FROM locations WHERE file_id = ? AND kind != 'lightroom'");
  const dropLoc = db.prepare('DELETE FROM locations WHERE id = ?');
  const result = { scanned: 0, matched: 0, alreadyKnown: 0, unverifiable: 0 };
  const progress = throttle(emit || (() => {}), 150);

  for await (const full of walkMedia(folder)) {
    if (job.cancelled) {
      result.cancelled = true;
      break;
    }
    result.scanned += 1;
    progress({ label: `Scanning ${path.basename(full)} (${result.matched} matched)` });
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const files = cand.all(st.size, path.basename(full));
    let foundSha = null;
    for (const f of files) {
      if (known.get(f.id, full)) {
        result.alreadyKnown += 1;
        continue;
      }
      let sha = f.sha256;
      if (!sha && mounted[f.serial]) {
        const src = path.join(`${mounted[f.serial]}\\`, f.rel_path);
        if (fs.existsSync(src)) {
          sha = await hashFile(src, job);
          setSha.run(sha, f.id);
        }
      }
      if (!sha) {
        result.unverifiable += 1; // need the card inserted to compare
        continue;
      }
      if (!foundSha) foundSha = await hashFile(full, job);
      if (foundSha === sha) {
        addLocation(db, f.id, 'found', full, true, null);
        result.matched += 1;
        // The file has turned up here, so drop records of copies that are gone.
        // Only when their drive is connected: an unplugged drive is not a deleted file.
        for (const l of stale.all(f.id)) {
          if (fs.existsSync(path.parse(l.path).root) && !fs.existsSync(l.path)) dropLoc.run(l.id);
        }
      }
    }
  }
  progress.flush();
  return result;
}

module.exports = { runFolderScan };
