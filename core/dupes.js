// Duplicates in the library index, and which extra copies are safe to delete.
//
// CardMap never deletes anything. It only makes a list.
//
// A copy is listed as safe to delete only when all of these hold:
//  - the file, matched by checksum, will still be in at least two places afterwards,
//    on different physical disks (two partitions, or a virtual disk and the disk its file
//    sits on, count as one). Lightroom's cloud copy can count as one place (a setting);
//  - every copy involved is on a connected drive and still has the size and date it had
//    when its checksum was read (anything changed since is left alone);
//  - the copy is not in a folder, or under a folder, that holds a Premiere, After Effects
//    or similar project file, since deleting it could break that project.
// Which copies are kept follows the drive order you set: the first drive in the list
// keeps its copy, then the next drive, until the file is in enough places.
const fs = require('node:fs');
const path = require('node:path');
const { currentPath, online } = require('./volumes');
const { hashFile, throttle } = require('./util');

const PROJECT_EXT = new Set(['.prproj', '.aep', '.aepx', '.drp', '.veg', '.fcpbundle', '.psb']);

// Folder names that suggest a dump or a stray copy rather than the organised home of a
// file. On the same disk, a copy elsewhere is kept in preference to one in these.
const MESSY = /\\(new folder( \(\d+\))?|extra space|[^\\]*dump[^\\]*|downloads?|backups?|[^\\]*\bcopy\b[^\\]*|temp|tmp|misc|old|unsorted|to organi[sz]e|recover(e)?d? files?)\\/i;
const messy = (p) => (MESSY.test(p) ? 1 : 0);

/**
 * Choose which copies to keep. Pure. Returns:
 *  status 'safe'      remove[] can go and the file stays in enough places;
 *  status 'onedisk'   the file is only on one disk: extras[] are further copies on it;
 *  status 'needed'    every copy is one of the places (e.g. one copy on each of two disks);
 *  status 'unchecked' fewer than two copies could be checked.
 */
function decide(copies, opts) {
  const minPlaces = opts.minPlaces || 2;
  const lrPlace = opts.countLightroom && opts.inLightroom ? 1 : 0;
  const usable = copies.filter((c) => c.ok);
  if (usable.length < 2) return { status: 'unchecked', keep: copies, remove: [], extras: [], places: 0 };
  const rank = (c) => (opts.priority[c.vol] ?? 999);
  const order = usable.slice().sort((a, b) =>
    rank(a) - rank(b) // your drive order
    || Number(Boolean(b.protected)) - Number(Boolean(a.protected)) // a copy that must stay anyway
    || messy(a.path) - messy(b.path) // not a dump folder
    || a.path.split('\\').length - b.path.split('\\').length
    || a.path.localeCompare(b.path));
  // One keeper per physical disk, best first, until the file is in enough places.
  const keep = [];
  const disks = new Set();
  for (const c of order) {
    if (disks.size + lrPlace >= minPlaces) break;
    if (disks.has(c.phys)) continue;
    keep.push(c);
    disks.add(c.phys);
  }
  // Copies next to a project file always stay.
  for (const c of usable) if (c.protected && !keep.includes(c)) keep.push(c);
  const places = disks.size + lrPlace;
  const rest = usable.filter((c) => !keep.includes(c));
  if (places >= minPlaces) return { status: rest.length ? 'safe' : 'needed', keep, remove: rest, extras: [], places };
  return { status: rest.length ? 'onedisk' : 'needed', keep, remove: [], extras: rest, places };
}

/** True when a folder or any folder above it (below the drive root) holds a project file. */
function projectChecker() {
  const cache = new Map();
  const dirHasProject = (dir) => {
    if (cache.has(dir)) return cache.get(dir);
    let found = null;
    try {
      const hit = fs.readdirSync(dir).find((n) => PROJECT_EXT.has(path.extname(n).toLowerCase()));
      found = hit ? path.join(dir, hit) : null;
    } catch {
      found = null;
    }
    cache.set(dir, found);
    return found;
  };
  return (file) => {
    let dir = path.dirname(file);
    const root = path.parse(file).root;
    while (dir && dir.length > root.length) {
      const hit = dirHasProject(dir);
      if (hit) return hit;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return null;
  };
}

// FAT/exFAT dates can appear to shift by an hour across a daylight-saving change.
const sameTime = (a, b) => {
  const d = Math.abs(a - b);
  return d < 2500 || Math.abs(d - 3600000) < 2500;
};

/** The top two folder levels of a path, e.g. "E:\Projects\Client", for grouping. */
function topFolder(p) {
  const parts = p.split('\\');
  return parts.slice(0, Math.min(3, parts.length - 1)).join('\\');
}

/**
 * Build the report. phys: { 'E:': { id, virtualOf } } from physicalDrives().
 * settings: { priority: { [volSerial]: rank }, countLightroom }
 */
async function buildReport(db, phys, settings, job, emit) {
  const progress = throttle(emit || (() => {}), 200);
  const groups = db
    .prepare(
      `SELECT sha256, size, count(*) AS n FROM lib_files WHERE sha256 IS NOT NULL
       GROUP BY sha256, size HAVING count(*) > 1 ORDER BY size DESC`
    )
    .all();
  const rowsOf = db.prepare('SELECT id, vol, rel, size, mtime_ms, hashed_at FROM lib_files WHERE sha256 = ? AND size = ?');
  let inLr = () => false;
  try {
    const q = db.prepare('SELECT 1 AS x FROM lr_assets WHERE sha256 = ? LIMIT 1');
    inLr = (sha) => Boolean(q.get(sha));
  } catch {
    /* no Lightroom cache */
  }
  const isNearProject = projectChecker();
  const physOf = (p) => {
    const letter = p.slice(0, 2).toUpperCase();
    return (phys[letter] && phys[letter].id) || `letter:${letter}`;
  };

  const files = [];
  const totals = {
    groups: groups.length, extraBytes: 0, safeFiles: 0, safeBytes: 0, oneDiskFiles: 0, oneDiskBytes: 0,
    neededGroups: 0, neededBytes: 0, uncheckedGroups: 0,
  };
  let done = 0;
  for (const g of groups) {
    if (job && job.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    done += 1;
    progress({ label: `Checking duplicates: ${done.toLocaleString()} of ${groups.length.toLocaleString()}`, filesDone: done, filesTotal: groups.length });
    const copies = rowsOf.all(g.sha256, g.size).map((r) => {
      const off = r.vol && !online(r.vol);
      const p = r.vol ? currentPath({ vol: r.vol, rel: r.rel, path: r.rel }) : r.rel;
      let ok = false;
      let why = '';
      if (off) why = 'drive not connected';
      else {
        try {
          const st = fs.statSync(p);
          ok = st.size === r.size && sameTime(Math.round(st.mtimeMs), r.mtime_ms);
          if (!ok) why = 'changed since its checksum was read';
        } catch {
          why = 'not found now';
        }
      }
      return { id: r.id, vol: r.vol, path: off ? r.rel : p, phys: off ? `vol:${r.vol}` : physOf(p), ok, why, hashedAt: r.hashed_at, offline: off, protected: null };
    });
    for (const c of copies) if (c.ok) c.project = isNearProject(c.path);
    for (const c of copies) c.protected = Boolean(c.project);
    const lr = inLr(g.sha256);
    const d = decide(copies, { priority: settings.priority || {}, countLightroom: settings.countLightroom, inLightroom: lr });
    totals.extraBytes += g.size * (g.n - 1);
    if (d.status === 'safe') {
      totals.safeFiles += d.remove.length;
      totals.safeBytes += g.size * d.remove.length;
    } else if (d.status === 'onedisk') {
      totals.oneDiskFiles += d.extras.length;
      totals.oneDiskBytes += g.size * d.extras.length;
    } else if (d.status === 'needed') {
      totals.neededGroups += 1;
      totals.neededBytes += g.size * (g.n - 1);
    } else totals.uncheckedGroups += 1;
    const slim = (c) => ({ path: c.path, project: c.project || null, hashedAt: c.hashedAt });
    files.push({
      sha256: g.sha256, size: g.size, count: g.n, inLightroom: lr, status: d.status, places: d.places,
      keep: d.status === 'unchecked' ? [] : d.keep.map(slim),
      remove: d.remove.map(slim),
      extras: d.extras.map(slim),
      problems: copies.filter((c) => !c.ok).map((c) => ({ path: c.path, why: c.why })),
      folders: [...new Set(copies.map((c) => topFolder(c.path)))].sort(),
    });
    if (done % 200 === 0) await new Promise((r) => setImmediate(r));
  }
  progress.flush();

  // Folder pairs: which folders hold the same files.
  const pairs = new Map();
  for (const f of files) {
    const key = f.folders.join(' | ');
    const p = pairs.get(key) || { folders: f.folders, files: 0, extraBytes: 0, safeBytes: 0, oneDiskBytes: 0, neededBytes: 0 };
    p.files += 1;
    p.extraBytes += f.size * (f.count - 1);
    p.safeBytes += f.size * f.remove.length;
    p.oneDiskBytes += f.size * f.extras.length;
    if (f.status === 'needed') p.neededBytes += f.size * (f.count - 1);
    pairs.set(key, p);
  }

  return {
    builtAt: new Date().toISOString(),
    totals,
    files,
    pairs: [...pairs.values()].sort((a, b) => b.extraBytes - a.extraBytes),
    disks: Object.entries(phys).map(([letter, v]) => ({ letter, virtualOf: v.virtualOf, model: v.model })),
  };
}

/**
 * Read again every copy of the given files and update their checksums, so the list can
 * be checked just before deleting. shas: checksums of the files to re-check.
 */
async function recheck(db, shas, job, emit) {
  const rowsOf = db.prepare('SELECT id, vol, rel, size FROM lib_files WHERE sha256 = ?');
  const setSha = db.prepare("UPDATE lib_files SET sha256 = ?, hashed_at = datetime('now') WHERE id = ?");
  const todo = [];
  for (const s of new Set(shas)) for (const r of rowsOf.all(s)) todo.push({ ...r, was: s });
  const bytesTotal = todo.reduce((n, r) => n + r.size, 0);
  let bytesDone = 0;
  let filesDone = 0;
  const res = { checked: 0, same: 0, changed: 0, unreadable: 0, changedPaths: [] };
  const progress = throttle(emit || (() => {}), 300);
  for (const r of todo) {
    if (job.cancelled) {
      res.cancelled = true;
      break;
    }
    filesDone += 1;
    if (r.vol && !online(r.vol)) {
      res.unreadable += 1;
      continue;
    }
    const p = r.vol ? currentPath({ vol: r.vol, rel: r.rel, path: r.rel }) : r.rel;
    try {
      const sha = await hashFile(p, job, (n) => {
        bytesDone += n;
        progress({ label: `Re-checking ${path.basename(p)}`, filesDone, filesTotal: todo.length, bytesDone, bytesTotal });
      });
      setSha.run(sha, r.id);
      res.checked += 1;
      if (sha === r.was) res.same += 1;
      else {
        res.changed += 1;
        res.changedPaths.push(p);
      }
    } catch (e) {
      if (e.cancelled) {
        res.cancelled = true;
        break;
      }
      res.unreadable += 1;
    }
  }
  progress.flush();
  return res;
}

module.exports = { buildReport, recheck, decide, topFolder };
