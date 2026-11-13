const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MEDIA_EXT = new Set([
  // raw
  'nef', 'nrw', 'cr2', 'cr3', 'crw', 'arw', 'srf', 'sr2', 'raf', 'dng', 'orf', 'rw2', 'pef', 'x3f', '3fr', 'iiq', 'gpr',
  // rendered stills
  'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'png',
  // video
  'mov', 'mp4', 'm4v', 'mts', 'm2ts', 'avi', 'mxf', 'braw', 'r3d', 'insv', 'insp', 'lrv', '360',
  // audio
  'wav', 'mp3', 'm4a',
]);

const SKIP_DIRS = new Set(['system volume information', '$recycle.bin', '.trashes', '.spotlight-v100', '.fseventsd']);

/** How a Lightroom catalog entry is shown where a folder would be. */
const LR_PLACE = 'Lightroom library (original stored in the cloud)';

class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date (YYYY-MM-DD) for a timestamp in ms. */
function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return localDate(dt.getTime());
}

const nowIso = () => new Date().toISOString();

/** Strip characters Windows does not allow in a folder name. */
function sanitizeName(s) {
  return String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
}

function isMedia(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MEDIA_EXT.has(ext);
}

/** Recursively yield media file paths under dir. Unreadable folders are skipped. */
async function* walkMedia(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
      yield* walkMedia(full);
    } else if (e.isFile() && isMedia(e.name) && !e.name.startsWith('._')) {
      yield full;
    }
  }
}

/** SHA-256 of a file, streaming. onBytes(n) is called per chunk; job.cancelled aborts. */
async function hashFile(file, job, onBytes) {
  const hash = crypto.createHash('sha256');
  const rs = fs.createReadStream(file, { highWaterMark: 4 << 20 });
  try {
    for await (const chunk of rs) {
      if (job && job.cancelled) throw new Cancelled();
      hash.update(chunk);
      if (onBytes) onBytes(chunk.length);
    }
  } catch (e) {
    rs.destroy();
    throw e;
  }
  return hash.digest('hex');
}

/** Returns a function that calls fn at most once per `ms`, plus .flush(). */
function throttle(fn, ms) {
  let last = 0;
  let pending = null;
  const t = (arg) => {
    pending = arg;
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(pending);
      pending = null;
    }
  };
  t.flush = () => {
    if (pending) fn(pending);
    pending = null;
  };
  return t;
}

/** The folder a file sits in on its card, e.g. "DCIM\100NIKON". */
function cardFolder(relPath) {
  const d = path.dirname(relPath);
  return d === '.' ? '(card root)' : d;
}

/** Predicate for the files a job should cover: by capture dates, by card folders, or everything. */
function pickFiles(opts) {
  const dates = opts.dates && opts.dates.length ? new Set(opts.dates) : null;
  const folders = opts.folders && opts.folders.length ? new Set(opts.folders) : null;
  if (!dates && !folders) return null;
  return (f) => (dates ? dates.has(f.capture_date) : false) || (folders ? folders.has(cardFolder(f.rel_path)) : false);
}

function existsCache() {
  const cache = new Map();
  return (p) => {
    // A Lightroom catalog entry is not a path on disk; it counts as present.
    if (p.startsWith('lightroom:') || p === LR_PLACE) return true;
    if (!cache.has(p)) cache.set(p, fs.existsSync(p));
    return cache.get(p);
  };
}

module.exports = {
  MEDIA_EXT, Cancelled, localDate, shiftDate, nowIso, sanitizeName, isMedia, walkMedia, hashFile, throttle, existsCache, cardFolder, pickFiles, LR_PLACE,
};
