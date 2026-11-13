const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { addLocation } = require('./db');
const { pathExists } = require('./volumes');
const { hashFile, nowIso, sanitizeName, throttle, pickFiles, Cancelled } = require('./util');

const PART = '.cardmap-part';

/** Read src once, writing it to every dest and hashing it on the way through. */
async function copyWithHash(src, dests, job, onBytes) {
  const hash = crypto.createHash('sha256');
  const rs = fs.createReadStream(src, { highWaterMark: 4 << 20 });
  const wss = dests.map((d) => fs.createWriteStream(d, { highWaterMark: 4 << 20 }));
  const errs = [];
  for (const w of wss) w.on('error', (e) => errs.push(e));
  try {
    for await (const chunk of rs) {
      if (job.cancelled) throw new Cancelled();
      if (errs.length) throw errs[0];
      hash.update(chunk);
      await Promise.all(wss.map((w) => (w.write(chunk) ? null : once(w, 'drain'))));
      onBytes(chunk.length);
    }
    await Promise.all(wss.map((w) => new Promise((res, rej) => w.end((err) => (err ? rej(err) : res())))));
    if (errs.length) throw errs[0];
  } catch (e) {
    rs.destroy();
    for (const w of wss) w.destroy();
    throw e;
  }
  return hash.digest('hex');
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
}

async function rm(p) {
  try {
    await fs.promises.unlink(p);
  } catch {
    /* already gone */
  }
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(path.parse(path.resolve(dir)).root);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function folderFor(date, shoot) {
  const s = sanitizeName(shoot);
  return s ? `${date} ${s}` : date;
}

/**
 * Copy the chosen dates from a mounted card to dest (and backup, if given).
 * Every copy is re-read from the destination and compared to the card file's
 * checksum before it is recorded. The card is only ever read.
 *
 * opts: { cardId, letter, dates[], shoot, dest, backup, maxFiles }
 */
async function runImport(db, opts, job, emit) {
  const { cardId, letter, shoot, dest, backup } = opts;
  if (!dest) throw new Error('Choose a destination folder first.');
  const pick = pickFiles(opts);
  if (!pick) throw new Error('Select at least one date or folder to import.');
  if (backup && path.resolve(backup).toLowerCase() === path.resolve(dest).toLowerCase()) {
    throw new Error('The backup folder must be different from the destination folder.');
  }
  const roots = [{ kind: 'primary', root: dest }];
  if (backup) roots.push({ kind: 'backup', root: backup });

  // Only files that are on the card right now: ones deleted in-camera since are left out.
  let files = db
    .prepare('SELECT * FROM files WHERE card_id = ? ORDER BY capture_date, rel_path')
    .all(cardId)
    .filter((f) => pick(f) && fs.existsSync(path.join(`${letter}\\`, f.rel_path)));
  if (opts.maxFiles) files = files.slice(0, opts.maxFiles);

  const locStmt = db.prepare('SELECT path, vol FROM locations WHERE file_id = ? AND kind = ? AND verified = 1');
  // Work out what each file still needs.
  const work = [];
  let bytesTotal = 0;
  for (const f of files) {
    const need = roots.filter((r) => !locStmt.all(f.id, r.kind).some((l) => pathExists(l.path, l.vol)));
    if (need.length) bytesTotal += f.size;
    work.push({ f, need });
  }

  for (const r of roots) {
    const needBytes = work.reduce((n, w) => n + (w.need.includes(r) ? w.f.size : 0), 0);
    await fs.promises.mkdir(r.root, { recursive: true });
    const free = freeBytes(r.root);
    if (free != null && needBytes > free) {
      const gb = (n) => (n / 1e9).toFixed(1);
      throw new Error(`Not enough space in ${r.root}: need ${gb(needBytes)} GB, ${gb(free)} GB free.`);
    }
  }

  const importId = Number(
    db
      .prepare('INSERT INTO imports (card_id, shoot, dest, backup, started) VALUES (?, ?, ?, ?, ?)')
      .run(cardId, shoot || null, dest, backup || null, nowIso()).lastInsertRowid
  );

  const result = { importId, copied: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };
  let bytesDone = 0;
  let filesDone = 0;
  const progress = throttle(emit || (() => {}), 150);
  const report = (label) => progress({ label, filesDone, filesTotal: work.length, bytesDone, bytesTotal });
  const setSha = db.prepare('UPDATE files SET sha256 = ? WHERE id = ?');
  const setShoot = db.prepare('UPDATE files SET shoot = ? WHERE id = ?');
  let cancelled = false;

  for (const { f, need } of work) {
    if (job.cancelled) {
      cancelled = true;
      break;
    }
    if (shoot) setShoot.run(shoot, f.id);
    if (!need.length) {
      result.skipped += 1;
      filesDone += 1;
      report(`Already copied: ${f.name}`);
      continue;
    }
    const src = path.join(`${letter}\\`, f.rel_path);
    const parts = [];
    try {
      let sha = f.sha256;
      let todo = [];
      for (const r of need) {
        const dir = path.join(r.root, folderFor(f.capture_date, shoot));
        await fs.promises.mkdir(dir, { recursive: true });
        const final = path.join(dir, f.name);
        // A file of the same name and size is already there, and we know the card
        // file's checksum: compare instead of copying again.
        if (sha && fs.existsSync(final) && fs.statSync(final).size === f.size) {
          report(`Checking existing copy: ${f.name}`);
          if ((await hashFile(final, job)) === sha) {
            addLocation(db, f.id, r.kind, final, true, importId);
            continue;
          }
        }
        todo.push({ r, final, part: `${final}${PART}` });
      }
      if (todo.length) {
        parts.push(...todo.map((t) => t.part));
        report(`Copying ${f.name}`);
        const copiedSha = await copyWithHash(src, parts, job, (n) => {
          bytesDone += n;
          report(`Copying ${f.name}`);
        });
        if (sha && sha !== copiedSha) throw new Error('Card file changed since it was last read.');
        sha = copiedSha;
        setSha.run(sha, f.id);
        for (const t of todo) {
          report(`Verifying ${f.name}`);
          let final = t.final;
          if (fs.existsSync(final)) {
            if ((await hashFile(final, job)) === sha) {
              await rm(t.part); // identical file already in place
              addLocation(db, f.id, t.r.kind, final, true, importId);
              continue;
            }
            final = uniquePath(final); // different file with the same name: keep both
          }
          await fs.promises.rename(t.part, final);
          if ((await hashFile(final, job)) !== sha) {
            await rm(final);
            throw new Error(`Copy in ${t.r.root} did not match the card file and was removed.`);
          }
          await fs.promises.utimes(final, new Date(), new Date(f.mtime_ms));
          addLocation(db, f.id, t.r.kind, final, true, importId);
        }
        result.copied += 1;
        result.bytes += f.size;
      } else {
        result.skipped += 1;
      }
    } catch (e) {
      for (const p of parts) await rm(p);
      if (e.cancelled) {
        cancelled = true;
        break;
      }
      result.failed += 1;
      result.errors.push({ name: f.name, message: e.message });
    }
    filesDone += 1;
    report(`Done ${f.name}`);
  }
  progress.flush();

  result.cancelled = cancelled;
  db.prepare('UPDATE imports SET finished = ?, files_copied = ?, files_skipped = ?, files_failed = ?, status = ? WHERE id = ?').run(
    nowIso(),
    result.copied,
    result.skipped,
    result.failed,
    cancelled ? 'cancelled' : result.failed ? 'finished with errors' : 'finished',
    importId
  );
  return result;
}

module.exports = { runImport, folderFor };
