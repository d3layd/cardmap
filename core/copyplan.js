// Copy plan: give the files that exist on only one disk a verified second copy.
//
// buildPlan lists the files on one drive whose checksum is on no other physical disk
// (and, optionally, not in the Lightroom cloud catalog). runPlan copies them into a
// folder on another drive, keeping each file's folder path.
//
// The source is only ever read. The only writes are new files under the destination
// folder (and index rows for them). An existing destination file is never overwritten:
// the same content counts as already there, different content is skipped and reported.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { hashFile, throttle, Cancelled } = require('./util');
const { pin, currentPath, online } = require('./volumes');

const PART = '.cardmap-part';
const sameDisk = (a, b) => a != null && b != null && String(a) === String(b);

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(path.parse(path.resolve(dir)).root);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function rm(p) {
  try {
    await fs.promises.unlink(p);
  } catch {
    /* already gone */
  }
}

/** Read src once, writing it to dest and hashing it on the way through. */
async function copyWithHash(src, dest, job, onBytes) {
  const hash = crypto.createHash('sha256');
  const rs = fs.createReadStream(src, { highWaterMark: 4 << 20 });
  const ws = fs.createWriteStream(dest, { highWaterMark: 4 << 20 });
  let err = null;
  ws.on('error', (e) => { err = err || e; });
  try {
    for await (const chunk of rs) {
      if (job && job.cancelled) throw new Cancelled();
      if (err) throw err;
      hash.update(chunk);
      if (!ws.write(chunk)) await once(ws, 'drain');
      onBytes(chunk.length);
    }
    await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
    if (err) throw err;
  } catch (e) {
    rs.destroy();
    ws.destroy();
    throw e;
  }
  return hash.digest('hex');
}

/**
 * Put a finished temp file in place without ever replacing an existing file.
 * A hard link fails if the name is taken; drives that cannot hard-link (exFAT, FAT)
 * fall back to a rename after checking the name is free. Returns false if taken.
 */
async function placeNew(part, final) {
  try {
    await fs.promises.link(part, final);
    await rm(part);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
  }
  if (fs.existsSync(final)) return false;
  await fs.promises.rename(part, final);
  return true;
}

/** Path within the drive, for building the destination path. Always starts with a backslash. */
function relOf(row) {
  let rel = row.rel;
  if (!row.vol) rel = rel.replace(/^[A-Za-z]:/, '').replace(/^\\\\[^\\]+\\[^\\]+/, ''); // untracked drive: rel is a whole path
  return rel.startsWith('\\') ? rel : `\\${rel}`;
}

/**
 * Files on `vol` that are on no other physical disk.
 * opts: { vol, countLightroom, diskOf(vol) -> physical disk id (default: the vol), folder (rel prefix) }
 * Returns { files, bytes, online, sameDiskCopies, rows: [{ id, path, rel, size, sha256 }] }, largest first.
 * A file with several copies on this drive is listed once.
 */
function buildPlan(db, opts) {
  const { vol, countLightroom } = opts;
  if (vol == null) throw new Error('Choose a drive first.');
  const diskOf = opts.diskOf || ((v) => v);
  const mine = diskOf(vol);

  // Checksums from this drive that are also on a different physical disk.
  const elsewhere = new Set();
  const others = db
    .prepare('SELECT DISTINCT sha256, vol FROM lib_files WHERE vol != ? AND sha256 IN (SELECT sha256 FROM lib_files WHERE vol = ? AND sha256 IS NOT NULL)')
    .all(vol, vol);
  const diskCache = new Map();
  for (const o of others) {
    if (!diskCache.has(o.vol)) diskCache.set(o.vol, diskOf(o.vol));
    if (!sameDisk(diskCache.get(o.vol), mine)) elsewhere.add(o.sha256);
  }

  let inLr = () => false;
  if (countLightroom) {
    try {
      const q = db.prepare('SELECT 1 AS x FROM lr_assets WHERE sha256 = ? LIMIT 1');
      inLr = (sha) => Boolean(q.get(sha));
    } catch {
      /* no Lightroom cache */
    }
  }

  let last = null;
  try {
    last = db.prepare('SELECT last_letter FROM volumes WHERE serial = ?').get(vol);
  } catch {
    /* no volumes table */
  }
  const isOnline = !vol || online(vol);
  const pathOf = (rel) => {
    if (!vol) return rel;
    const fallback = last && last.last_letter ? `${last.last_letter}${rel}` : rel;
    return currentPath({ vol, rel, path: fallback });
  };

  let prefix = null;
  if (opts.folder) {
    let f = String(opts.folder);
    if (vol) f = f.replace(/^[A-Za-z]:/, '');
    prefix = (f.endsWith('\\') ? f : `${f}\\`).toLowerCase();
  }

  const seen = new Set();
  const rows = [];
  let total = 0;
  let sameDiskCopies = 0;
  const all = db.prepare('SELECT id, rel, size, sha256 FROM lib_files WHERE vol = ? AND sha256 IS NOT NULL ORDER BY size DESC, rel').all(vol);
  for (const r of all) {
    if (prefix && !r.rel.toLowerCase().startsWith(prefix)) continue;
    if (elsewhere.has(r.sha256)) continue;
    if (seen.has(r.sha256)) {
      sameDiskCopies += 1; // another copy of a file already in the plan
      continue;
    }
    if (inLr(r.sha256)) continue;
    seen.add(r.sha256);
    rows.push({ id: r.id, path: pathOf(r.rel), rel: r.rel, size: r.size, sha256: r.sha256 });
    total += r.size;
  }
  return { files: rows.length, bytes: total, online: isOnline, sameDiskCopies, rows };
}

/** Returns record(final, row, stamp): adds the new copy to the library index. Null if the index cannot take it. */
function indexer(db) {
  try {
    const src = db.prepare('SELECT src, kind FROM lib_files WHERE id = ?');
    const up = db.prepare(
      `INSERT INTO lib_files (vol, rel, size, mtime_ms, sha256, hashed_at, seen, src, kind, added_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, datetime('now'))
       ON CONFLICT(vol, rel) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256,
         hashed_at = excluded.hashed_at, seen = excluded.seen, quick = NULL, failed = 0`
    );
    return (final, row, stamp) => {
      const k = pin(final);
      const key = k.vol ? { vol: k.vol, rel: k.rel } : { vol: '', rel: final }; // same key the index uses
      const st = fs.statSync(final);
      const from = src.get(row.id) || {};
      up.run(key.vol, key.rel, st.size, Math.round(st.mtimeMs), row.sha256, stamp, from.src || 'folder', from.kind || null);
    };
  } catch {
    return null;
  }
}

/**
 * Copy every planned file to dest + its path within the source drive, and verify each
 * copy by reading it back from the destination.
 * opts: { vol, countLightroom, diskOf, folder, dest }
 * Returns { copied, already, failed, skippedDifferent, bytes, errors, different, cancelled, indexed, needsRescan }.
 */
async function runPlan(db, opts, job, emit) {
  const { vol } = opts;
  job = job || {};
  if (!opts.dest) throw new Error('Choose a destination folder first.');
  const dest = path.resolve(opts.dest);
  const diskOf = opts.diskOf || ((v) => v);
  if (vol && !online(vol)) throw new Error('The source drive is not connected.');

  const plan = buildPlan(db, opts);

  // A copy on the same drive or the same physical disk is not a backup.
  const destVol = opts._testDestVol !== undefined ? opts._testDestVol : pin(dest).vol;
  const same = new Error('The destination is on the same disk as the files. Choose a folder on a different drive.');
  if (destVol) {
    if (destVol === vol || sameDisk(diskOf(destVol), diskOf(vol))) throw same;
  } else {
    // Destination drive is not tracked: compare drive roots instead.
    const destRoot = path.parse(dest).root.toLowerCase();
    const srcRoot = vol ? path.parse(currentPath({ vol, rel: '\\', path: '' }) || '').root.toLowerCase() : null;
    if (srcRoot && srcRoot === destRoot) throw same;
    if (!vol && plan.rows.some((r) => path.parse(r.path).root.toLowerCase() === destRoot)) throw same;
  }

  const destOf = (r) => {
    const final = path.join(dest, relOf(r));
    if (!final.toLowerCase().startsWith(`${dest.toLowerCase().replace(/\\+$/, '')}\\`)) throw new Error('Path leaves the destination folder.');
    return final;
  };

  await fs.promises.mkdir(dest, { recursive: true });
  // Space for everything not already at the destination with the right size.
  let need = 0;
  for (const r of plan.rows) {
    let there = null;
    try {
      there = fs.statSync(destOf(r));
    } catch {
      there = null;
    }
    if (!there) need += r.size;
  }
  const free = freeBytes(dest);
  if (free != null && need > free) {
    const gb = (n) => (n / 1e9).toFixed(1);
    throw new Error(`Not enough space in ${dest}: need ${gb(need)} GB, ${gb(free)} GB free.`);
  }

  const record = indexer(db);
  const stamp = new Date().toISOString();
  const result = { copied: 0, already: 0, failed: 0, skippedDifferent: 0, bytes: 0, errors: [], different: [], cancelled: false, indexed: 0, needsRescan: !record };
  const note = (final, r) => {
    if (!record) return;
    try {
      record(final, r, stamp);
      result.indexed += 1;
    } catch {
      result.needsRescan = true;
    }
  };
  const bytesTotal = plan.bytes;
  let bytesDone = 0;
  let filesDone = 0;
  const progress = throttle(emit || (() => {}), 150);
  const report = (label) => progress({ label, filesDone, filesTotal: plan.rows.length, bytesDone, bytesTotal });

  for (const r of plan.rows) {
    if (job.cancelled) {
      result.cancelled = true;
      break;
    }
    const name = path.basename(r.path);
    const startBytes = bytesDone;
    let part = null;
    try {
      const final = destOf(r);
      const differs = () => {
        result.skippedDifferent += 1;
        if (result.different.length < 10) result.different.push(final);
      };
      if (fs.existsSync(final)) {
        report(`Checking existing copy: ${name}`);
        if (fs.statSync(final).size === r.size && (await hashFile(final, job)) === r.sha256) {
          result.already += 1;
          note(final, r);
        } else differs();
      } else {
        await fs.promises.mkdir(path.dirname(final), { recursive: true });
        part = `${final}${PART}`;
        report(`Copying ${name}`);
        const sha = await copyWithHash(r.path, part, job, (n) => {
          bytesDone += n;
          report(`Copying ${name}`);
        });
        if (sha !== r.sha256) throw new Error('The file has changed since its checksum was read. Re-index it, then try again.');
        if (!(await placeNew(part, final))) {
          await rm(part);
          differs(); // a file appeared under this name while copying: leave it alone
        } else {
          part = null;
          report(`Verifying ${name}`);
          if ((await hashFile(final, job)) !== r.sha256) {
            await rm(final); // our own new copy, and it is bad
            throw new Error('The copy did not match the original and was removed.');
          }
          try {
            const st = fs.statSync(r.path);
            await fs.promises.utimes(final, new Date(), st.mtime);
          } catch {
            /* keeps today's date */
          }
          result.copied += 1;
          result.bytes += r.size;
          note(final, r);
        }
      }
    } catch (e) {
      if (part) await rm(part);
      if (e.cancelled) {
        result.cancelled = true;
        break;
      }
      result.failed += 1;
      if (result.errors.length < 10) result.errors.push({ name, path: r.path, message: e.message });
    }
    bytesDone = startBytes + r.size;
    filesDone += 1;
    report(`Done ${name}`);
  }
  progress.flush();
  return result;
}

module.exports = { buildPlan, runPlan };
