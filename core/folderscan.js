const fs = require('node:fs');
const path = require('node:path');
const { addLocation } = require('./db');
const { online } = require('./volumes');
const { walkMedia, hashFile, quickHash, throttle } = require('./util');

/**
 * Look through folders on disk for copies of files CardMap knows from a card
 * (copied by hand before, renamed, or moved since).
 *
 * A local file is a candidate when it is exactly the same size as a card file;
 * it is recorded as a copy only when its checksum also matches. The name is not
 * used, so renamed copies are found too. Only candidates are read in full.
 *
 * opts: { folders[] (or folder), cardId (optional: only match this card's files),
 *         mounted: { [cardSerial]: 'E:' } }
 */
async function runFolderScan(db, opts, job, emit) {
  const folders = (opts.folders || (opts.folder ? [opts.folder] : [])).filter(Boolean);
  const { mounted = {} } = opts;
  if (!folders.length) throw new Error('Choose at least one folder to search.');
  const missing = folders.filter((f) => !fs.existsSync(f));
  if (missing.length === folders.length) throw new Error(`Not found: ${missing.join(', ')}`);

  const cand = db.prepare(
    `SELECT f.*, c.serial FROM files f JOIN cards c ON c.id = f.card_id
     WHERE f.size = ? ${opts.cardId ? 'AND f.card_id = ?' : ''}`
  );
  const known = db.prepare('SELECT 1 AS x FROM locations WHERE file_id = ? AND path = ? AND verified = 1');
  const setSha = db.prepare('UPDATE files SET sha256 = ? WHERE id = ?');
  const stale = db.prepare("SELECT id, path, vol FROM locations WHERE file_id = ? AND kind != 'lightroom'");
  const dropLoc = db.prepare('DELETE FROM locations WHERE id = ?');
  const result = { scanned: 0, matched: 0, renamed: 0, alreadyKnown: 0, unverifiable: 0, ruledOutEarly: 0, skippedFolders: missing };
  const cardQuick = new Map(); // file id -> fingerprint of the card file
  const matchedFiles = new Set();
  const progress = throttle(emit || (() => {}), 150);

  for (const folder of folders) {
    if (missing.includes(folder)) continue;
    for await (const full of walkMedia(folder)) {
      if (job.cancelled) {
        result.cancelled = true;
        break;
      }
      result.scanned += 1;
      progress({ label: `Searching ${folder}: ${result.scanned} files looked at, ${result.matched} matched` });
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const files = opts.cardId ? cand.all(st.size, opts.cardId) : cand.all(st.size);
      if (!files.length) continue;
      let foundSha = null;
      let foundQuick = null;
      for (const f of files) {
        if (known.get(f.id, full)) {
          result.alreadyKnown += 1;
          matchedFiles.add(f.id);
          continue;
        }
        const src = mounted[f.serial] ? path.join(`${mounted[f.serial]}\\`, f.rel_path) : null;
        const onCard = Boolean(src && fs.existsSync(src));
        // Stage 2 (after size): compare the first and last 64 KB. Different there
        // means a different file, with no need to read either one in full.
        if (onCard) {
          try {
            if (!cardQuick.has(f.id)) cardQuick.set(f.id, await quickHash(src, f.size));
            if (!foundQuick) foundQuick = await quickHash(full, st.size);
            if (cardQuick.get(f.id) !== foundQuick) {
              result.ruledOutEarly += 1;
              continue;
            }
          } catch {
            continue; // unreadable: cannot be confirmed as a copy
          }
        }
        // Stage 3: full checksums.
        let sha = f.sha256;
        if (!sha && onCard) {
          progress({ label: `Reading ${f.name} from the card to compare (${result.matched} matched so far)` });
          sha = await hashFile(src, job);
          setSha.run(sha, f.id);
        }
        if (!sha) {
          result.unverifiable += 1; // need the card inserted to compare
          continue;
        }
        if (!foundSha) {
          progress({ label: `Comparing ${path.basename(full)}` });
          foundSha = await hashFile(full, job);
        }
        if (foundSha === sha) {
          addLocation(db, f.id, 'found', full, true, null);
          result.matched += 1;
          matchedFiles.add(f.id);
          if (path.basename(full).toLowerCase() !== f.name.toLowerCase()) result.renamed += 1;
          // The file has turned up here, so drop records of copies that are gone.
          // Only when their drive is connected: an unplugged drive is not a deleted file.
          for (const l of stale.all(f.id)) {
            const driveHere = l.vol ? online(l.vol) : fs.existsSync(path.parse(l.path).root);
            if (driveHere && !fs.existsSync(l.path)) dropLoc.run(l.id);
          }
        }
      }
    }
    if (result.cancelled) break;
  }
  progress.flush();
  result.filesWithCopies = matchedFiles.size;
  return result;
}

module.exports = { runFolderScan };
