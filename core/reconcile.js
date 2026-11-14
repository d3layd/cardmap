// Drive reconcile: "what on this drive exists nowhere else?"
//
// Read-only. Works from the library index (lib_files) and, optionally, the Lightroom
// catalog cache (lr_assets). A file is "only here" when it has a checksum and that
// checksum is on no other physical disk in the index (and, when Lightroom counts, not in
// Lightroom either). Further copies on the same physical disk are not a backup.
// Files without a checksum yet cannot be judged; they are counted as "unhashed".

const FILE_CAP = 5000;

/** The top two folder levels of a path, e.g. "E:\Projects\Client", for grouping. */
function topFolder(p) {
  const parts = p.split('\\');
  return parts.slice(0, Math.min(3, parts.length - 1)).join('\\');
}

/**
 * opts: { vol, countLightroom, diskOf(vol) -> physical disk id (default: the vol itself) }
 * Returns { drives: [...] } and, when opts.vol is given, { folders, files, truncated }.
 */
function driveGaps(db, opts = {}) {
  const diskOf = typeof opts.diskOf === 'function' ? opts.diskOf : (v) => v;
  const diskCache = new Map();
  const disk = (vol) => {
    let d = diskCache.get(vol);
    if (d === undefined) {
      d = diskOf(vol);
      if (d == null) d = vol;
      diskCache.set(vol, d);
    }
    return d;
  };

  const rows = db.prepare('SELECT vol, rel, size, sha256 FROM lib_files').all();

  // Checksum -> the one disk it is on, or true once it is on more than one.
  const where = new Map();
  for (const r of rows) {
    if (!r.sha256) continue;
    const d = disk(r.vol);
    const seen = where.get(r.sha256);
    if (seen === undefined) where.set(r.sha256, d);
    else if (seen !== true && seen !== d) where.set(r.sha256, true);
  }

  let inLr = new Set();
  if (opts.countLightroom) {
    try {
      inLr = new Set(db.prepare('SELECT DISTINCT sha256 FROM lr_assets WHERE sha256 IS NOT NULL').all().map((a) => a.sha256));
    } catch {
      /* no Lightroom cache */
    }
  }

  let vols = [];
  try {
    vols = db.prepare('SELECT serial, label, last_letter FROM volumes').all();
  } catch {
    /* no volumes table */
  }
  const info = new Map(vols.map((v) => [v.serial, v]));
  const letterOf = (vol) => (info.get(vol) && info.get(vol).last_letter) || '?:';

  const drives = new Map();
  const folders = new Map();
  const files = [];
  const want = opts.vol == null ? null : opts.vol;
  const wantLetter = want == null ? '' : letterOf(want);

  for (const r of rows) {
    let d = drives.get(r.vol);
    if (!d) {
      const v = info.get(r.vol) || {};
      d = { vol: r.vol, letter: v.last_letter || '', label: v.label || '', files: 0, bytes: 0, onlyHereFiles: 0, onlyHereBytes: 0, unhashedFiles: 0 };
      drives.set(r.vol, d);
    }
    const size = r.size || 0;
    d.files += 1;
    d.bytes += size;
    const only = Boolean(r.sha256) && where.get(r.sha256) !== true && !inLr.has(r.sha256);
    if (!r.sha256) d.unhashedFiles += 1;
    else if (only) {
      d.onlyHereFiles += 1;
      d.onlyHereBytes += size;
    }
    if (want == null || r.vol !== want) continue;

    const p = wantLetter + r.rel;
    const key = topFolder(p);
    let f = folders.get(key);
    if (!f) {
      f = { folder: key, files: 0, bytes: 0, onlyHere: 0, onlyHereBytes: 0, unhashed: 0, status: 'backed' };
      folders.set(key, f);
    }
    f.files += 1;
    f.bytes += size;
    if (!r.sha256) f.unhashed += 1;
    else if (only) {
      f.onlyHere += 1;
      f.onlyHereBytes += size;
      files.push({ path: p, size, sha256: r.sha256 });
    }
  }

  const out = {
    drives: [...drives.values()].sort((a, b) => (a.letter || '~').localeCompare(b.letter || '~') || String(a.vol).localeCompare(String(b.vol))),
  };
  if (want != null) {
    for (const f of folders.values()) {
      // A folder with files not hashed yet is never called fully backed up.
      if (f.onlyHere === f.files) f.status = 'only';
      else if (f.onlyHere === 0 && f.unhashed === 0) f.status = 'backed';
      else f.status = 'partly';
    }
    files.sort((a, b) => b.size - a.size);
    out.vol = want;
    out.folders = [...folders.values()].sort((a, b) => b.onlyHereBytes - a.onlyHereBytes || a.folder.localeCompare(b.folder));
    out.onlyHereTotal = files.length;
    out.truncated = files.length > FILE_CAP;
    out.files = out.truncated ? files.slice(0, FILE_CAP) : files;
  }
  return out;
}

module.exports = { driveGaps, topFolder };
