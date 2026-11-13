// A saved index of the files in your library folders: where each one is, its size
// and date, and (once it has been read) its SHA-256 checksum.
//
// With checksums saved, matching a card to the library is a lookup instead of a read.
// Building them is the slow part, so it happens in two steps:
//   inventory   - list the folders and record every file's size and date (fast);
//   hashPending - read files that have no checksum yet (slow, resumable, pausable).
// A file is only read again if its size or date changes.
const fs = require('node:fs');
const path = require('node:path');
const { addLocation, tx } = require('./db');
const { walkMedia, hashFile, quickHash, throttle } = require('./util');
const { pin, currentPath, online } = require('./volumes');
const { walkCamera, learnPrefixes, prefixOf } = require('./discover');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lib_files (
  id INTEGER PRIMARY KEY,
  vol TEXT NOT NULL DEFAULT '',   -- volume serial of the drive, '' if the drive is not tracked
  rel TEXT NOT NULL,              -- path within the drive (or the whole path when vol is '')
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  sha256 TEXT,
  quick TEXT,                     -- fingerprint of the first and last 64 KB
  failed INTEGER NOT NULL DEFAULT 0,
  seen TEXT,
  UNIQUE (vol, rel)
);
CREATE INDEX IF NOT EXISTS lib_files_size ON lib_files (size);
CREATE INDEX IF NOT EXISTS lib_files_sha ON lib_files (sha256);
`;
function ensure(db) {
  db.exec(SCHEMA);
  // src: 'folder' = in a folder the user added (everything in it is indexed);
  //      'scan'   = found by the imported-media scan (camera files only).
  // kind: raw | still | video, for files found by the scan.
  if (!db.prepare('PRAGMA table_info(lib_files)').all().some((c) => c.name === 'src')) {
    db.exec("ALTER TABLE lib_files ADD COLUMN src TEXT NOT NULL DEFAULT 'folder'; ALTER TABLE lib_files ADD COLUMN kind TEXT;");
  }
}

/** Returns save(batch): adds new files, keeps checksums of unchanged ones, re-queues changed ones. */
function recorder(db, stamp, src, res) {
  const get = db.prepare('SELECT id, size, mtime_ms FROM lib_files WHERE vol = ? AND rel = ?');
  const ins = db.prepare('INSERT INTO lib_files (vol, rel, size, mtime_ms, seen, src, kind) VALUES (?, ?, ?, ?, ?, ?, ?)');
  // A file in a folder the user added stays "folder" even if a scan also finds it.
  const touch = db.prepare("UPDATE lib_files SET seen = ?, src = CASE WHEN ? = 'folder' THEN 'folder' ELSE src END, kind = COALESCE(?, kind) WHERE id = ?");
  const reset = db.prepare(
    "UPDATE lib_files SET size = ?, mtime_ms = ?, sha256 = NULL, quick = NULL, failed = 0, seen = ?, src = CASE WHEN ? = 'folder' THEN 'folder' ELSE src END, kind = COALESCE(?, kind) WHERE id = ?"
  );
  return (batch) => {
    if (!batch.length) return;
    tx(db, () => {
      for (const e of batch) {
        const row = get.get(e.vol, e.rel);
        if (!row) {
          ins.run(e.vol, e.rel, e.size, e.mtime, stamp, src, e.kind || null);
          res.added += 1;
        } else if (row.size === e.size && sameTime(row.mtime_ms, e.mtime)) {
          touch.run(stamp, src, e.kind || null, row.id);
        } else {
          reset.run(e.size, e.mtime, stamp, src, e.kind || null, row.id);
          res.changed += 1;
        }
      }
    });
  };
}

function dropUnseen(db, folder, stamp, src) {
  const k = keyOf(folder);
  const prefix = k.rel.endsWith('\\') ? k.rel : `${k.rel}\\`;
  return Number(
    db.prepare('DELETE FROM lib_files WHERE vol = ? AND substr(rel, 1, ?) = ? AND src = ? AND seen != ?').run(k.vol, prefix.length, prefix, src, stamp).changes
  );
}

/**
 * Scan drives or folders for imported camera media and put just those files in the
 * index. Lists folders and looks at names, types and sizes only: no file is read.
 * opts: { excluded: [folder paths to leave out] }
 */
async function discover(db, roots, opts, job, emit) {
  ensure(db);
  const stamp = new Date().toISOString();
  const res = { files: 0, bytes: 0, looked: 0, leftOut: 0, added: 0, changed: 0, removed: 0, raw: 0, still: 0, video: 0, skippedFolders: [] };
  const save = recorder(db, stamp, 'scan', res);
  const prefixes = learnPrefixes(db);
  const progress = throttle(emit || (() => {}), 200);
  for (const root of [...new Set(roots.filter(Boolean))]) {
    if (!fs.existsSync(root)) {
      res.skippedFolders.push(root);
      continue;
    }
    let batch = [];
    const walkOpts = {
      prefixes,
      excluded: (opts && opts.excluded) || [],
      onFile: (kept) => {
        res.looked += 1;
        if (!kept) res.leftOut += 1;
      },
    };
    for await (const f of walkCamera(root, walkOpts, job)) {
      batch.push({ ...keyOf(f.full), size: f.size, mtime: f.mtime, kind: f.kind });
      res.files += 1;
      res.bytes += f.size;
      res[f.kind] += 1;
      if (batch.length >= 2000) {
        save(batch);
        batch = [];
        await sleep(0);
      }
      progress({ label: `Scanning ${root} for imported media: ${res.files.toLocaleString()} found, ${res.leftOut.toLocaleString()} left out` });
    }
    save(batch);
    if (job && job.cancelled) {
      res.cancelled = true;
      break;
    }
    res.removed += dropUnseen(db, root, stamp, 'scan');
  }
  // Anything previously found inside a folder that is now excluded leaves the index.
  for (const ex of (opts && opts.excluded) || []) {
    const k = keyOf(ex);
    const prefix = k.rel.endsWith('\\') ? k.rel : `${k.rel}\\`;
    res.removed += Number(db.prepare("DELETE FROM lib_files WHERE vol = ? AND substr(rel, 1, ?) = ? AND src = 'scan'").run(k.vol, prefix.length, prefix).changes);
  }
  progress.flush();
  return res;
}

/**
 * What the found files are called: the letters before the first number in each name,
 * with how many files share them. Shows which naming patterns the scan actually matched.
 */
function foundPrefixes(db) {
  ensure(db);
  const groups = new Map();
  for (const r of db.prepare("SELECT rel, size, kind FROM lib_files WHERE src = 'scan'").all()) {
    const name = r.rel.slice(r.rel.lastIndexOf('\\') + 1);
    const key = prefixOf(name) || (/^\d/.test(name) ? '(starts with a number)' : '(no number in the name)');
    const g = groups.get(key) || { prefix: key, files: 0, bytes: 0, raw: 0, still: 0, video: 0, example: name };
    g.files += 1;
    g.bytes += r.size;
    if (r.kind) g[r.kind] += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.files - a.files);
}

/** Remove the everything-in-the-folder entries for a whole drive (they are replaced by a scan). */
function dropWholeDrive(db, vol) {
  ensure(db);
  return Number(db.prepare("DELETE FROM lib_files WHERE vol = ? AND src = 'folder'").run(vol).changes);
}

/** Remove files the scan found under a folder (used when the user excludes it). */
function dropScanned(db, folder) {
  ensure(db);
  const k = keyOf(folder);
  const prefix = k.rel.endsWith('\\') ? k.rel : `${k.rel}\\`;
  return Number(db.prepare("DELETE FROM lib_files WHERE vol = ? AND substr(rel, 1, ?) = ? AND src = 'scan'").run(k.vol, prefix.length, prefix).changes);
}

/**
 * Where the scan found imported media, grouped by the top two folder levels on each
 * drive (for example "\Projects\Client Work"), largest first.
 */
function foundFolders(db) {
  ensure(db);
  const groups = new Map();
  for (const r of db.prepare("SELECT vol, rel, size, kind, sha256 IS NOT NULL AS hashed FROM lib_files WHERE src = 'scan'").all()) {
    const parts = r.rel.split('\\').filter(Boolean);
    if (!r.vol) parts.shift(); // untracked drive: rel is a full path starting with the letter
    const top = parts.slice(0, Math.min(2, Math.max(parts.length - 1, 0)));
    const lead = r.vol ? '' : r.rel.slice(0, 2);
    const rel = `${lead}\\${top.join('\\')}`;
    const key = `${r.vol}|${rel}`;
    if (!groups.has(key)) groups.set(key, { vol: r.vol, rel, files: 0, bytes: 0, hashedBytes: 0, raw: 0, still: 0, video: 0 });
    const g = groups.get(key);
    g.files += 1;
    g.bytes += r.size;
    if (r.hashed) g.hashedBytes += r.size;
    if (r.kind) g[r.kind] += 1;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, path: pathOf({ vol: g.vol, rel: g.rel }), online: !g.vol || online(g.vol) }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Where an indexed file is right now, or null if its drive is not connected. */
function pathOf(row) {
  if (!row.vol) return row.rel;
  return online(row.vol) ? currentPath({ vol: row.vol, rel: row.rel, path: null }) : null;
}

const keyOf = (p) => {
  const k = pin(p);
  return k.vol ? { vol: k.vol, rel: k.rel } : { vol: '', rel: p };
};

// FAT and exFAT store local time, so a file's date can appear to shift by exactly an
// hour across a daylight-saving change. That is not a changed file.
const sameTime = (a, b) => {
  const d = Math.abs(a - b);
  return d < 2500 || Math.abs(d - 3600000) < 2500;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** List the folders and record every media file's size and date. Reads no file contents. */
async function inventory(db, folders, job, emit) {
  ensure(db);
  const stamp = new Date().toISOString();
  const res = { files: 0, bytes: 0, added: 0, changed: 0, removed: 0, skippedFolders: [] };
  const save = recorder(db, stamp, 'folder', res);
  const progress = throttle(emit || (() => {}), 200);

  for (const folder of [...new Set(folders.filter(Boolean))]) {
    if (!fs.existsSync(folder)) {
      res.skippedFolders.push(folder);
      continue;
    }
    let batch = [];
    const flush = () => {
      save(batch);
      batch = [];
    };
    let complete = true;
    for await (const full of walkMedia(folder)) {
      if (job && job.cancelled) {
        res.cancelled = true;
        complete = false;
        break;
      }
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      batch.push({ ...keyOf(full), size: st.size, mtime: Math.round(st.mtimeMs) });
      res.files += 1;
      res.bytes += st.size;
      if (batch.length >= 2000) {
        flush();
        await sleep(0); // keep the window responsive
      }
      progress({ label: `Listing ${folder}: ${res.files.toLocaleString()} files` });
    }
    flush();
    // Files that were in this folder last time and are gone now leave the index.
    if (complete) res.removed += dropUnseen(db, folder, stamp, 'folder');
    if (res.cancelled) break;
  }
  progress.flush();
  return res;
}

function known(db, fileId, p) {
  return Boolean(db.prepare('SELECT 1 AS x FROM locations WHERE file_id = ? AND path = ? AND verified = 1').get(fileId, p));
}

/** Record that an indexed file is a verified copy of a card file. */
function link(db, f, row, result, matchedFiles) {
  const p = pathOf(row);
  if (!p || !fs.existsSync(p)) return;
  matchedFiles.add(f.id);
  if (known(db, f.id, p)) {
    result.alreadyKnown += 1;
    return;
  }
  addLocation(db, f.id, 'found', p, true, null);
  result.matched += 1;
  if (path.basename(p).toLowerCase() !== f.name.toLowerCase()) result.renamed += 1;
  // The file has turned up here, so drop records of copies that are gone.
  // Only when their drive is connected: an unplugged drive is not a deleted file.
  for (const l of db.prepare("SELECT id, path, vol FROM locations WHERE file_id = ? AND kind != 'lightroom'").all(f.id)) {
    const driveHere = l.vol ? online(l.vol) : fs.existsSync(path.parse(l.path).root);
    if (driveHere && !fs.existsSync(l.path)) db.prepare('DELETE FROM locations WHERE id = ?').run(l.id);
  }
}

/**
 * Match card files to the index.
 *  - Indexed files that already have a checksum: a straight lookup, nothing is read.
 *  - Indexed files of the same size with no checksum yet: compared in stages (first and
 *    last 64 KB, then the full checksum), and the checksum is saved for next time.
 * opts: { cardId (optional), mounted: { [cardSerial]: 'E:' } }
 */
async function matchCards(db, opts, job, emit) {
  ensure(db);
  const { mounted = {} } = opts;
  const result = { matched: 0, renamed: 0, alreadyKnown: 0, unverifiable: 0, ruledOutEarly: 0, lookups: 0, read: 0 };
  const matchedFiles = new Set();
  const files = db
    .prepare(`SELECT f.*, c.serial FROM files f JOIN cards c ON c.id = f.card_id ${opts.cardId ? 'WHERE f.card_id = ?' : ''} ORDER BY f.capture_date, f.rel_path`)
    .all(...(opts.cardId ? [opts.cardId] : []));
  const bySha = db.prepare('SELECT * FROM lib_files WHERE sha256 = ?');
  const unhashed = db.prepare('SELECT * FROM lib_files WHERE size = ? AND sha256 IS NULL AND failed = 0');
  const setCardSha = db.prepare('UPDATE files SET sha256 = ? WHERE id = ?');
  const setQuick = db.prepare('UPDATE lib_files SET quick = ? WHERE id = ?');
  const setSha = db.prepare('UPDATE lib_files SET sha256 = ? WHERE id = ?');
  const setFailed = db.prepare('UPDATE lib_files SET failed = 1 WHERE id = ?');
  const progress = throttle(emit || (() => {}), 150);
  let done = 0;

  for (const f of files) {
    if (job.cancelled) {
      result.cancelled = true;
      break;
    }
    done += 1;
    progress({ label: `Matching ${f.name} (${matchedFiles.size} with a local copy so far)`, filesDone: done, filesTotal: files.length });
    let sha = f.sha256;
    const src = mounted[f.serial] ? path.join(`${mounted[f.serial]}\\`, f.rel_path) : null;
    const onCard = Boolean(src && fs.existsSync(src));
    let cardQuick = null;

    for (const row of unhashed.all(f.size)) {
      const p = pathOf(row);
      if (!p || !fs.existsSync(p)) continue;
      if (!sha && !onCard) {
        result.unverifiable += 1; // same size, but the card is needed to compare
        continue;
      }
      try {
        if (onCard) {
          if (!cardQuick) cardQuick = await quickHash(src, f.size);
          const q = row.quick || (await quickHash(p, row.size));
          if (!row.quick) setQuick.run(q, row.id);
          if (q !== cardQuick) {
            result.ruledOutEarly += 1;
            continue;
          }
        }
        if (!sha) {
          progress({ label: `Reading ${f.name} from the card to compare`, filesDone: done, filesTotal: files.length });
          sha = await hashFile(src, job);
          setCardSha.run(sha, f.id);
        }
        progress({ label: `Comparing ${path.basename(p)}`, filesDone: done, filesTotal: files.length });
        setSha.run(await hashFile(p, job), row.id);
        result.read += 1;
      } catch (e) {
        if (e.cancelled) throw e;
        setFailed.run(row.id);
      }
    }
    if (sha) {
      const rows = bySha.all(sha);
      if (rows.length) result.lookups += 1;
      for (const row of rows) link(db, f, row, result, matchedFiles);
    }
  }
  progress.flush();
  result.filesWithCopies = matchedFiles.size;
  return result;
}

/**
 * Read files that have no checksum yet and save their checksums. Safe to stop and
 * start: it carries on from where it left off. Files the same size as a card file go
 * first, since those are the ones that can turn out to be copies.
 * opts: { shouldPause(): boolean } - e.g. to stand aside while another task runs.
 */
async function hashPending(db, opts, job, emit) {
  ensure(db);
  const rows = db
    .prepare(
      `SELECT id, vol, rel, size FROM lib_files WHERE sha256 IS NULL AND failed = 0
       ORDER BY (size IN (SELECT size FROM files)) DESC, vol, rel`
    )
    .all();
  const res = { hashed: 0, bytes: 0, failed: 0, offline: 0, linked: 0, total: rows.length };
  const bytesTotal = rows.reduce((n, r) => n + r.size, 0);
  const setSha = db.prepare('UPDATE lib_files SET sha256 = ? WHERE id = ?');
  const setFailed = db.prepare('UPDATE lib_files SET failed = 1 WHERE id = ?');
  const cardFiles = db.prepare('SELECT * FROM files WHERE sha256 = ?');
  const progress = throttle(emit || (() => {}), 400);
  const linkResult = { matched: 0, renamed: 0, alreadyKnown: 0 };
  let bytesDone = 0;
  let filesDone = 0;

  for (const row of rows) {
    while (opts && opts.shouldPause && opts.shouldPause() && !job.cancelled) {
      progress({ label: 'Paused while another task runs', filesDone, filesTotal: rows.length, bytesDone, bytesTotal, paused: true });
      progress.flush();
      await sleep(800);
    }
    if (job.cancelled) {
      res.cancelled = true;
      break;
    }
    const p = pathOf(row);
    filesDone += 1;
    if (!p) {
      res.offline += 1;
      continue;
    }
    try {
      const sha = await hashFile(p, job, (n) => {
        bytesDone += n;
        progress({ label: `Indexing ${p}`, filesDone, filesTotal: rows.length, bytesDone, bytesTotal });
      });
      setSha.run(sha, row.id);
      res.hashed += 1;
      res.bytes += row.size;
      // If this is a copy of a card file CardMap already knows, record it straight away.
      for (const f of cardFiles.all(sha)) link(db, f, { ...row, sha256: sha }, linkResult, new Set());
    } catch (e) {
      if (e.cancelled) {
        res.cancelled = true;
        break;
      }
      setFailed.run(row.id);
      res.failed += 1;
    }
  }
  progress.flush();
  res.linked = linkResult.matched;
  return res;
}

/** Totals for the index, and for each library folder. folders: [{ path, exists }] */
function indexStatus(db, folders) {
  ensure(db);
  const t = db
    .prepare(
      `SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes,
              coalesce(sum(sha256 IS NOT NULL), 0) AS hashed, coalesce(sum(CASE WHEN sha256 IS NOT NULL THEN size ELSE 0 END), 0) AS hashedBytes,
              coalesce(sum(failed), 0) AS failed
       FROM lib_files`
    )
    .get();
  const dup = db
    .prepare(
      `SELECT count(*) AS groups, coalesce(sum(extra), 0) AS bytes FROM
         (SELECT size * (count(*) - 1) AS extra FROM lib_files WHERE sha256 IS NOT NULL GROUP BY sha256, size HAVING count(*) > 1)`
    )
    .get();
  const per = db.prepare(
    `SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes, coalesce(sum(CASE WHEN sha256 IS NOT NULL THEN size ELSE 0 END), 0) AS hashedBytes
     FROM lib_files WHERE vol = ? AND substr(rel, 1, ?) = ?`
  );
  return {
    ...t,
    duplicateGroups: dup.groups,
    duplicateBytes: dup.bytes,
    folders: (folders || []).map((f) => {
      const k = keyOf(f.path);
      const prefix = k.rel.endsWith('\\') ? k.rel : `${k.rel}\\`;
      return { ...f, ...per.get(k.vol, prefix.length, prefix) };
    }),
  };
}

/** List the folders, then match card files against the index. Used by "Find local copies". */
async function runFolderScan(db, opts, job, emit) {
  const folders = (opts.folders || (opts.folder ? [opts.folder] : [])).filter(Boolean);
  if (!folders.length) throw new Error('Choose at least one folder to search.');
  const inv = await inventory(db, folders, job, emit);
  if (inv.skippedFolders.length === folders.length) throw new Error(`Not found: ${inv.skippedFolders.join(', ')}`);
  const m = inv.cancelled ? { matched: 0, renamed: 0, alreadyKnown: 0, unverifiable: 0, ruledOutEarly: 0, filesWithCopies: 0, cancelled: true }
    : await matchCards(db, { cardId: opts.cardId || null, mounted: opts.mounted || {} }, job, emit);
  return { scanned: inv.files, ...m, skippedFolders: inv.skippedFolders };
}

module.exports = { inventory, discover, foundFolders, foundPrefixes, dropScanned, dropWholeDrive, matchCards, hashPending, indexStatus, runFolderScan };
