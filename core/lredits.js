// Archive Lightroom (cloud) edits so photos can be taken off Lightroom without losing them.
//
// Lightroom keeps each photo's edit settings as an XMP file named by its checksum, in the
// catalog's "settings" folder, but only for photos whose settings are on this computer.
// The rest live in Adobe's cloud until Lightroom needs them. Read-only on Lightroom's side.
//
// An export writes, into a folder you choose:
//   - one .xmp file per edited photo, by date, named after the original file;
//   - lightroom-catalog.json: every photo with its checksum, name, date, rating, albums,
//     whether it was edited, its exported .xmp (if any) and where its local copies are.
// Optionally it also puts the .xmp next to each local raw file of the same photo
// (same name, .xmp extension), which is how Lightroom Classic, Camera Raw and Bridge pick
// up edits. Existing .xmp files are never overwritten.
const fs = require('node:fs');
const path = require('node:path');
const { ensureSchema, albumPaths } = require('./lrcatalog');
const { RAW } = require('./discover');
const { currentPath, online } = require('./volumes');
const { throttle, sanitizeName } = require('./util');

const settingsDirs = (catalogs) => catalogs.map((c) => path.join(path.dirname(c), 'settings'));

// Every edit settings file Lightroom has on this computer: checksum -> path.
function settingsIndex(dirs) {
  const m = new Map();
  for (const d of dirs) {
    try {
      for (const n of fs.readdirSync(d)) m.set(n.toLowerCase(), path.join(d, n));
    } catch {
      /* no settings folder */
    }
  }
  return m;
}
const findSettings = (idx, sha) => (sha && idx.get(sha.toLowerCase())) || null;

const isRaw = (p) => RAW.has(path.extname(p).slice(1).toLowerCase());
const sidecarOf = (p) => p.slice(0, p.length - path.extname(p).length) + '.xmp';

// Where each local copy is: at its drive's current letter, or the last letter it had if
// the drive is not connected.
function localCopies(db, sha) {
  const last = db.prepare('SELECT last_letter FROM volumes WHERE serial = ?');
  return db
    .prepare('SELECT vol, rel FROM lib_files WHERE sha256 = ?')
    .all(sha)
    .map((r) => {
      const on = online(r.vol);
      return { path: on ? currentPath({ vol: r.vol, rel: r.rel }) : `${(last.get(r.vol) || {}).last_letter || '?:'}${r.rel}`, online: on };
    });
}

/** How many edits there are, how many can be archived from this computer, and how many have a local raw. */
function editsStatus(db, catalogs) {
  ensureSchema(db);
  const dirs = settingsIndex(settingsDirs(catalogs));
  const edited = db.prepare('SELECT asset_id, sha256, name, xmp_sha FROM lr_assets WHERE edited = 1').all();
  let here = 0;
  let withRaw = 0;
  let hereWithRaw = 0;
  const hasRaw = db.prepare('SELECT rel FROM lib_files WHERE sha256 = ?');
  for (const a of edited) {
    const local = Boolean(a.xmp_sha && findSettings(dirs, a.xmp_sha));
    const raw = hasRaw.all(a.sha256).some((r) => isRaw(r.rel));
    if (local) here += 1;
    if (raw) withRaw += 1;
    if (local && raw) hereWithRaw += 1;
  }
  return { assets: db.prepare('SELECT count(*) AS n FROM lr_assets').get().n, edited: edited.length, here, withRaw, hereWithRaw, cloudOnly: edited.length - here };
}

/**
 * opts: { catalogs, dest, sidecars: boolean }
 */
async function exportEdits(db, opts, job, emit) {
  ensureSchema(db);
  if (!opts.dest) throw new Error('Choose a folder for the archive.');
  fs.mkdirSync(opts.dest, { recursive: true });
  const dirs = settingsIndex(settingsDirs(opts.catalogs || []));
  const { pathOf } = albumPaths(db);
  const albumsOf = db.prepare('SELECT album_id FROM lr_album_assets WHERE asset_id = ?');
  const assets = db.prepare('SELECT * FROM lr_assets ORDER BY capture_date, name').all();
  const progress = throttle(emit || (() => {}), 300);
  const res = { photos: assets.length, edited: 0, written: 0, cloudOnly: 0, sidecars: 0, sidecarsSame: 0, sidecarsKept: 0, sidecarsOffline: 0, failed: 0 };
  const out = [];
  let done = 0;

  for (const a of assets) {
    if (job.cancelled) {
      res.cancelled = true;
      break;
    }
    done += 1;
    progress({ label: `Archiving ${a.name || a.asset_id}`, filesDone: done, filesTotal: assets.length });
    const copies = a.sha256 ? localCopies(db, a.sha256) : [];
    const entry = {
      assetId: a.asset_id, name: a.name, sha256: a.sha256, size: a.size, captured: a.capture_time, kind: a.kind,
      camera: a.camera, lens: a.lens, rating: a.rating, uploaded: Boolean(a.uploaded), edited: Boolean(a.edited),
      albums: albumsOf.all(a.asset_id).map((r) => pathOf(r.album_id)).filter(Boolean),
      localCopies: copies.map((c) => c.path), xmp: null,
    };
    if (a.edited) {
      res.edited += 1;
      const src = a.xmp_sha ? findSettings(dirs, a.xmp_sha) : null;
      if (!src) {
        res.cloudOnly += 1;
        entry.xmpState = 'in Lightroom\'s cloud only';
      } else {
        try {
          const xmp = fs.readFileSync(src);
          const file = archivePath(opts.dest, a);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, xmp);
          res.written += 1;
          entry.xmp = path.relative(opts.dest, file);
          if (opts.sidecars) {
            for (const c of copies.filter((x) => isRaw(x.path))) {
              if (!c.online) {
                res.sidecarsOffline += 1;
                continue;
              }
              const side = sidecarOf(c.path);
              if (fs.existsSync(side)) {
                if (fs.readFileSync(side).equals(xmp)) res.sidecarsSame += 1;
                else res.sidecarsKept += 1; // an .xmp is already there: never overwritten
                continue;
              }
              fs.writeFileSync(side, xmp, { flag: 'wx' });
              res.sidecars += 1;
            }
          }
        } catch (e) {
          res.failed += 1;
          entry.xmpState = `could not be written: ${e.message}`;
        }
      }
    }
    out.push(entry);
    if (done % 500 === 0) await new Promise((r) => setImmediate(r));
  }
  progress.flush();
  const json = path.join(opts.dest, 'lightroom-catalog.json');
  fs.writeFileSync(json, JSON.stringify({ exportedAt: new Date().toISOString(), note: 'Written by CardMap. Every Lightroom photo with its checksum, albums, rating and edit file.', photos: out }, null, 1));
  res.dest = opts.dest;
  res.json = json;
  return res;
}


// Where an edit file for a photo goes in the archive.
function archivePath(dest, a) {
  const base = sanitizeName(path.basename(a.name || a.asset_id, path.extname(a.name || ''))) || a.asset_id;
  return path.join(dest, 'edits', a.capture_date || 'undated', `${base}.xmp`);
}

/**
 * Pair a folder exported from Lightroom with "Original + Settings" (each original next to
 * its .xmp). Each .xmp is matched to its Lightroom photo by the original's name and size,
 * saved in the archive, and (optionally) put next to the local raw copies already indexed.
 * The export folder itself is not changed.
 * opts: { folder, dest, sidecars }
 */
async function pairExport(db, opts, job, emit) {
  ensureSchema(db);
  if (!opts.folder || !fs.existsSync(opts.folder)) throw new Error('Choose the folder Lightroom exported to.');
  if (!opts.dest) throw new Error('Choose a folder for the archive.');
  const byName = db.prepare('SELECT * FROM lr_assets WHERE name = ? COLLATE NOCASE AND size = ?');
  const res = { xmp: 0, matched: 0, unmatched: 0, written: 0, sidecars: 0, sidecarsSame: 0, sidecarsKept: 0, sidecarsOffline: 0, unmatchedNames: [] };
  const progress = throttle(emit || (() => {}), 300);
  const walk = async function* (dir) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(full);
      else if (e.isFile()) yield full;
    }
  };
  const files = [];
  for await (const f of walk(opts.folder)) files.push(f);
  // The original that goes with an .xmp is the other file in the same folder with the same name.
  const stemOf = (f) => f.slice(0, f.length - path.extname(f).length).toLowerCase();
  const originals = new Map(files.filter((f) => path.extname(f).toLowerCase() !== '.xmp').map((f) => [stemOf(f), f]));
  for (const x of files.filter((f) => path.extname(f).toLowerCase() === '.xmp')) {
    if (job.cancelled) {
      res.cancelled = true;
      break;
    }
    res.xmp += 1;
    progress({ label: `Pairing ${path.basename(x)}`, filesDone: res.xmp });
    const original = originals.get(stemOf(x));
    let asset = null;
    if (original) {
      const size = fs.statSync(original).size;
      asset = byName.get(path.basename(original), size);
    }
    if (!asset) {
      res.unmatched += 1;
      if (res.unmatchedNames.length < 20) res.unmatchedNames.push(path.basename(x));
      continue;
    }
    res.matched += 1;
    const xmp = fs.readFileSync(x);
    const file = archivePath(opts.dest, asset);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, xmp);
    res.written += 1;
    if (opts.sidecars) {
      const inExport = (p) => p.toLowerCase().startsWith(opts.folder.toLowerCase());
      for (const c of localCopies(db, asset.sha256).filter((y) => isRaw(y.path) && !inExport(y.path))) {
        if (!c.online) {
          res.sidecarsOffline += 1;
          continue;
        }
        const side = sidecarOf(c.path);
        if (fs.existsSync(side)) {
          if (fs.readFileSync(side).equals(xmp)) res.sidecarsSame += 1;
          else res.sidecarsKept += 1;
          continue;
        }
        fs.writeFileSync(side, xmp, { flag: 'wx' });
        res.sidecars += 1;
      }
    }
  }
  progress.flush();
  return res;
}

module.exports = { editsStatus, exportEdits, pairExport };
