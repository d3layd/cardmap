const fs = require('node:fs');
const path = require('node:path');
const { addLocation } = require('./db');
const { hashFile, shiftDate, throttle, pickFiles } = require('./util');
const { refreshIndex } = require('./lrcatalog');

/** Prefix for a location that is a Lightroom catalog entry rather than a file on disk. */
const LR_PREFIX = 'lightroom:';

/**
 * True when this card file is known to be in Lightroom: a confirmed cloud record, or a
 * copy in Lightroom's local cache that still exists. Lightroom clears its cache once a
 * photo is uploaded, so a cache path that is gone means "check again", not "in Lightroom".
 */
function knownInLightroom(db, fileId) {
  return db
    .prepare("SELECT path FROM locations WHERE file_id = ? AND kind = 'lightroom' AND verified = 1")
    .all(fileId)
    .some((l) => l.path.startsWith(LR_PREFIX) || fs.existsSync(l.path));
}

/** Record the confirmed cloud copy, and drop cache paths for this file that are gone. */
function recordUploaded(db, fileId, assetId) {
  addLocation(db, fileId, 'lightroom', `${LR_PREFIX}${assetId}`, true, null);
  for (const l of db.prepare("SELECT id, path FROM locations WHERE file_id = ? AND kind = 'lightroom'").all(fileId)) {
    if (!l.path.startsWith(LR_PREFIX) && !fs.existsSync(l.path)) db.prepare('DELETE FROM locations WHERE id = ?').run(l.id);
  }
}

/** Lightroom (cloud) keeps recently added originals in <data>\<account id>\originals\YYYY\YYYY-MM-DD\. */
function findOriginalsRoots(override) {
  if (override) return fs.existsSync(override) ? [override] : [];
  const base = path.join(process.env.LOCALAPPDATA || '', 'Adobe', 'Lightroom CC', 'Data');
  const out = [];
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      const p = path.join(base, e.name, 'originals');
      if (e.isDirectory() && fs.existsSync(p)) out.push(p);
    }
  } catch {
    /* Lightroom not installed */
  }
  return out;
}

/** Finds a file of a given size in Lightroom's local originals cache, near a date. */
function originalsFinder(roots) {
  const dirCache = new Map();
  const listDir = (dir) => {
    if (dirCache.has(dir)) return dirCache.get(dir);
    const bySize = new Map();
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isFile()) continue;
        const p = path.join(dir, e.name);
        const size = fs.statSync(p).size;
        if (!bySize.has(size)) bySize.set(size, []);
        bySize.get(size).push(p);
      }
    } catch {
      /* no folder for that date */
    }
    dirCache.set(dir, bySize);
    return bySize;
  };
  return (size, dates, name) => {
    const out = [];
    for (const root of roots) {
      for (const d0 of dates.filter(Boolean)) {
        for (const d of [d0, shiftDate(d0, -1), shiftDate(d0, 1)]) {
          for (const p of listDir(path.join(root, d.slice(0, 4), d)).get(size) || []) if (!out.includes(p)) out.push(p);
        }
      }
    }
    return out.sort((a, b) => Number(path.basename(b) === name) - Number(path.basename(a) === name));
  };
}

/**
 * Check which of a card's files are in Lightroom.
 *
 * With a catalog: every photo and video in Lightroom's catalog records the
 * original file's size and SHA-256. A card file is "in Lightroom" when its
 * checksum equals a catalog entry's. Only files whose size matches some catalog
 * entry need to be read from the card; the rest are ruled out without reading.
 *
 * Without a catalog (not found): falls back to looking in Lightroom's local
 * originals cache, which only holds recently added files.
 *
 * opts: { cardId, letter (if mounted), dates[] | folders[] (optional), catalogs[], roots[], maxFiles }
 */
async function runLightroomCheck(db, opts, job, emit) {
  const catalogs = opts.catalogs || [];
  const roots = opts.roots || [];
  if (!catalogs.length && !roots.length) throw new Error('Lightroom was not found on this computer.');

  const result = { checked: 0, found: 0, notUploaded: 0, notFound: 0, unverifiable: 0, method: catalogs.length ? 'catalog' : 'originals folder' };
  if (catalogs.length) {
    const idx = await refreshIndex(db, catalogs, job, emit);
    result.catalogAssets = idx.assets;
  }

  let files = db
    .prepare(
      `SELECT f.*
       FROM files f WHERE f.card_id = ? ORDER BY f.capture_date, f.rel_path`
    )
    .all(opts.cardId);
  const pick = pickFiles(opts);
  if (pick) files = files.filter(pick);
  // Files already matched on an earlier check are not read again, but still count as found.
  for (const f of files) f.known = knownInLightroom(db, f.id);
  result.alreadyFound = files.filter((f) => f.known).length;
  files = files.filter((f) => !f.known);
  if (opts.maxFiles) files = files.slice(0, opts.maxFiles);

  const bySize = catalogs.length ? db.prepare('SELECT * FROM lr_assets WHERE size = ?') : null;
  const findOriginal = originalsFinder(roots);
  const lrHashes = new Map();
  const hashLr = async (p) => {
    if (!lrHashes.has(p)) lrHashes.set(p, await hashFile(p, job));
    return lrHashes.get(p);
  };
  const setSha = db.prepare('UPDATE files SET sha256 = ? WHERE id = ?');
  const progress = throttle(emit || (() => {}), 150);

  // The card file's checksum: already known from an import, or read from the card now.
  const shaOf = async (f) => {
    if (f.sha256) return f.sha256;
    if (!opts.letter) return null;
    const src = path.join(`${opts.letter}\\`, f.rel_path);
    if (!fs.existsSync(src)) return null;
    progress({ label: `Reading ${f.name} from the card to compare`, filesDone: result.checked, filesTotal: files.length });
    const sha = await hashFile(src, job);
    setSha.run(sha, f.id);
    return sha;
  };

  for (const f of files) {
    if (job.cancelled) {
      result.cancelled = true;
      break;
    }
    progress({ label: `Checking Lightroom for ${f.name}`, filesDone: result.checked, filesTotal: files.length });
    result.checked += 1;

    if (bySize) {
      const sameSize = bySize.all(f.size);
      if (!sameSize.length) {
        result.notFound += 1; // nothing in the catalog is this size: cannot be the same file
        continue;
      }
      const sha = await shaOf(f);
      if (!sha) {
        result.unverifiable += 1;
        continue;
      }
      const asset = sameSize.find((a) => a.sha256 === sha);
      if (!asset) {
        result.notFound += 1;
        continue;
      }
      if (asset.uploaded) {
        recordUploaded(db, f.id, asset.asset_id);
        result.found += 1;
        continue;
      }
      // In the catalog but the original is not in the cloud yet: the copy that
      // exists is the one in Lightroom's local cache, if it is still there.
      let local = null;
      for (const c of findOriginal(f.size, [asset.capture_date, f.capture_date], f.name)) {
        if ((await hashLr(c)) === sha) {
          local = c;
          break;
        }
      }
      if (local) addLocation(db, f.id, 'lightroom', local, true, null);
      else addLocation(db, f.id, 'lightroom', `${LR_PREFIX}${asset.asset_id}`, false, null);
      result.notUploaded += 1;
      continue;
    }

    // Fallback: no catalog, look in the originals cache only.
    const candidates = findOriginal(f.size, [f.capture_date], f.name);
    if (!candidates.length) {
      result.notFound += 1;
      continue;
    }
    const sha = await shaOf(f);
    if (!sha) {
      result.unverifiable += 1;
      continue;
    }
    let matched = false;
    for (const c of candidates) {
      if ((await hashLr(c)) === sha) {
        addLocation(db, f.id, 'lightroom', c, true, null);
        matched = true;
        break;
      }
    }
    if (matched) result.found += 1;
    else result.notFound += 1;
  }
  progress.flush();
  return result;
}

/**
 * Quick Lightroom match from the cached catalog, with nothing read from disk: every card
 * file whose checksum is known and equals a Lightroom original is recorded as in
 * Lightroom (confirmed only if its upload is). Used once a card's checksums are read.
 * Returns { found, notUploaded }.
 */
function matchLightroomCache(db, cardId) {
  const out = { found: 0, notUploaded: 0 };
  let byKey;
  try {
    byKey = db.prepare('SELECT asset_id, uploaded FROM lr_assets WHERE sha256 = ? AND size = ?');
  } catch {
    return out; // no Lightroom cache yet
  }
  const files = db
    .prepare(
      `SELECT f.id, f.sha256, f.size FROM files f WHERE f.card_id = ? AND f.sha256 IS NOT NULL
`
    )
    .all(cardId)
    .filter((f) => !knownInLightroom(db, f.id));
  for (const f of files) {
    const assets = byKey.all(f.sha256, f.size);
    if (!assets.length) continue;
    const up = assets.find((a) => a.uploaded);
    if (up) recordUploaded(db, f.id, up.asset_id);
    else addLocation(db, f.id, 'lightroom', `${LR_PREFIX}${assets[0].asset_id}`, false, null);
    if (up) out.found += 1;
    else out.notUploaded += 1;
  }
  return out;
}

module.exports = { findOriginalsRoots, runLightroomCheck, matchLightroomCache, LR_PREFIX };
