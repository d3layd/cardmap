// Filing rules: checks whether the library follows the user's own filing rules.
// The settings (which drive is which, folder names, patterns) are user data loaded from a
// rules file outside the repo; this module only knows generic check types.
// Read-only: it reads the database and lists folders, and never changes anything.

const fs = require('node:fs');
const path = require('node:path');
const { albumPaths } = require('./lrcatalog');

const MAX_ROWS = 2000;
const DAY = 86400000;

const PHOTO_EXT = new Set([
  'nef', 'nrw', 'cr2', 'cr3', 'crw', 'arw', 'srf', 'sr2', 'raf', 'dng', 'orf', 'rw2', 'pef', 'x3f', '3fr', 'iiq', 'gpr',
  'jpg', 'jpeg', 'heic', 'heif',
]);
const VIDEO_EXT = new Set(['mov', 'mp4', 'm4v', 'mts', 'm2ts', 'avi', 'mxf', 'braw', 'r3d', 'insv', 'lrv', '360']);

const extOf = (rel) => {
  const i = rel.lastIndexOf('.');
  return i < 0 || i < rel.lastIndexOf('\\') ? '' : rel.slice(i + 1).toLowerCase();
};
const dirOf = (rel) => rel.slice(0, Math.max(0, rel.lastIndexOf('\\')));
const baseOf = (rel) => rel.slice(rel.lastIndexOf('\\') + 1);
const segsOf = (rel) => rel.split('\\').filter(Boolean);
const isSet = (s) => typeof s === 'string' && s.trim() !== '';
const list = (a) => (Array.isArray(a) ? a.filter(isSet) : []);

/** Default helpers from the volumes table, used when the caller passes none. */
function defaultHelpers(db) {
  const vols = db.prepare('SELECT serial, label, last_letter FROM volumes').all();
  const letterBy = new Map(vols.map((v) => [v.serial, v.last_letter ? normLetter(v.last_letter) : null]));
  const volBy = new Map(vols.filter((v) => v.last_letter).map((v) => [normLetter(v.last_letter), v.serial]));
  return {
    letterOf: (vol) => letterBy.get(vol) || null,
    volOfPath: (p) => volBy.get(normLetter(String(p || '').slice(0, 2))) || null,
    diskOfVol: (vol) => vol,
    now: new Date(),
  };
}
const normLetter = (s) => String(s).slice(0, 2).toUpperCase();

/** A rule result with rows capped at MAX_ROWS. */
function result(rule, { status, summary, count = 0, bytes = 0, rows = [] }) {
  return {
    ...rule,
    status: status || (count ? 'warn' : 'ok'),
    summary,
    count,
    bytes,
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
  };
}
const off = (rule, setting) => result(rule, { status: 'off', summary: `Not set up: fill in ${setting} in the rules file.` });
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || `${one}s`}`;
const gb = (n) => `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;

function runRules(db, config, helpers) {
  const started = Date.now();
  const cfg = config || {};
  const hp = { ...defaultHelpers(db), ...(helpers || {}) };
  const now = hp.now instanceof Date ? hp.now.getTime() : Date.now();
  const drives = cfg.drives || {};
  const folders = cfg.folders || {};
  const photo = cfg.photo || {};
  const video = cfg.video || {};

  // Shared, loaded once: every indexed file.
  let libCache = null;
  const lib = () => {
    if (!libCache) libCache = db.prepare('SELECT vol, rel, size, mtime_ms, sha256 FROM lib_files').all();
    return libCache;
  };
  const where = (vol, rel) => (vol ? `${hp.letterOf(vol) || `[drive ${vol}]`}${rel}` : rel);

  /** A config path as { vol, prefix } (prefix lower case, '' for a drive root), or null when it cannot be matched. */
  const scope = (p) => {
    if (!isSet(p)) return null;
    const vol = hp.volOfPath(p);
    if (!vol) return { vol: null, prefix: '', raw: p };
    const prefix = p.slice(2).replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
    return { vol, prefix, raw: p };
  };
  const inScope = (s, f) => s && s.vol && f.vol === s.vol && (s.prefix === '' || f.rel.toLowerCase().startsWith(`${s.prefix}\\`));
  const work = scope(drives.work);
  const archive = scope(drives.archive);
  const videoScopes = [work, archive].filter((s) => s && s.vol);
  const keepAll = list(photo.keepAll).map((k) => k.toLowerCase());

  const rules = [];
  const check = (rule, fn) => {
    const t = Date.now();
    let r;
    try {
      r = fn(rule);
    } catch (e) {
      r = result(rule, { status: 'warn', summary: `This check failed: ${e.message}` });
    }
    r.ms = Date.now() - t;
    rules.push(r);
  };
  const unreachable = (rule, names) => {
    const bad = names.filter(([, s]) => s && !s.vol).map(([n]) => n);
    return bad.length ? result(rule, { status: 'warn', summary: `The drive for ${bad.join(' and ')} is not in the library index (no known drive letter matches it).` }) : null;
  };
  /** Group file rows by a folder key into { path, size, detail } rows. */
  const byFolder = (files, keyOf, label) => {
    const m = new Map();
    for (const f of files) {
      const k = keyOf(f);
      const g = m.get(k) || { path: k, size: 0, n: 0 };
      g.size += f.size || 0;
      g.n++;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.size - a.size).map((g) => ({ path: g.path, size: g.size, detail: plural(g.n, label) }));
  };

  // ---- Photos ----

  check({ id: 'photo-in-lightroom', group: 'photo', title: 'Every photo goes into Lightroom' }, (rule) => {
    const inLr = new Set(db.prepare('SELECT sha256 FROM lr_assets WHERE sha256 IS NOT NULL').all().map((r) => r.sha256));
    const miss = [];
    let unhashed = 0;
    for (const f of lib()) {
      if (!PHOTO_EXT.has(extOf(f.rel))) continue;
      const full = where(f.vol, f.rel);
      if (keepAll.some((k) => full.toLowerCase().startsWith(k))) continue;
      if (!f.sha256) { unhashed++; continue; }
      if (!inLr.has(f.sha256)) miss.push({ ...f, full });
    }
    const bytes = miss.reduce((s, f) => s + (f.size || 0), 0);
    const rows = byFolder(miss, (f) => where(f.vol, `\\${segsOf(f.rel)[0] || ''}`), 'photo');
    const extra = unhashed ? ` ${plural(unhashed, 'photo')} have no checksum yet and were not checked.` : '';
    return result(rule, {
      count: miss.length, bytes, rows,
      summary: (miss.length ? `${plural(miss.length, 'photo file')} on your drives (${gb(bytes)}) are not in Lightroom.` : 'Every indexed photo with a checksum is in Lightroom.') + extra,
    });
  });

  check({ id: 'photo-album', group: 'photo', title: 'Every photo is in a correctly named album' }, (rule) => {
    // Topics are Lightroom's automatic groupings, not albums: membership in one does not count.
    const loose = db.prepare(`SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM lr_assets WHERE asset_id NOT IN
      (SELECT l.asset_id FROM lr_album_assets l JOIN lr_albums a ON a.album_id = l.album_id WHERE coalesce(a.subtype, '') != 'topic')`).get();
    const { albums, pathOf } = albumPaths(db);
    const pattern = isSet(photo.albumPattern) ? new RegExp(photo.albumPattern) : null;
    const parents = new Set(list(photo.albumParents).map((p) => p.trim().toLowerCase()));
    const rootOf = (a) => {
      let cur = a;
      for (let i = 0; i < 12 && cur.parent_id && albums.get(cur.parent_id); i++) cur = albums.get(cur.parent_id);
      return cur === a ? null : cur;
    };
    const rows = [];
    if (loose.n) rows.push({ name: 'Photos and videos in no album', size: loose.bytes, detail: plural(loose.n, 'item') });
    let badAlbums = 0;
    for (const a of albums.values()) {
      if (a.subtype !== 'collection') continue; // skips album folders (collection_set) and topics
      const p = pathOf(a.album_id) || a.name;
      if (keepAll.some((k) => p.toLowerCase().startsWith(k))) continue;
      const problems = [];
      if (pattern && !pattern.test((a.name || '').trim())) problems.push('name does not match the album pattern');
      if (parents.size) {
        const root = rootOf(a);
        if (!root) problems.push('not inside an album folder');
        else if (!parents.has((root.name || '').trim().toLowerCase())) problems.push(`top folder "${root.name.trim()}" is not one of the album parents`);
      }
      if (problems.length) {
        badAlbums++;
        rows.push({ name: p, size: null, detail: problems.join('; ') });
      }
    }
    const parts = [];
    if (loose.n) parts.push(`${plural(loose.n, 'Lightroom item')} (${gb(loose.bytes)}) are in no album`);
    if (badAlbums) parts.push(`${plural(badAlbums, 'album')} break the naming or folder rule`);
    const note = parents.size ? '' : ' Album parents are not set, so album folders were not checked.';
    return result(rule, {
      count: loose.n + badAlbums, bytes: loose.bytes, rows,
      summary: (parts.length ? `${parts.join(', and ')}.` : 'Every Lightroom item is in an album and every album follows the rule.') + note,
    });
  });

  // ---- Video ----

  const subNames = list(video.subfolders);
  const subSet = new Set(subNames.map((s) => s.toLowerCase()));
  const needVideoDrives = (rule) => (videoScopes.length ? null
    : unreachable(rule, [['drives.work', work], ['drives.archive', archive]]) || off(rule, 'drives.work or drives.archive'));
  const videoFiles = () => lib().filter((f) => VIDEO_EXT.has(extOf(f.rel)) && videoScopes.some((s) => inScope(s, f)));

  /** Project folders on a scope: Map lower-case rel -> { rel, vol, seen:Set }. */
  const projectsOf = (s) => {
    const m = new Map();
    for (const f of lib()) {
      if (!inScope(s, f)) continue;
      const segs = segsOf(dirOf(f.rel));
      for (let i = 0; i < segs.length; i++) {
        if (!subSet.has(segs[i].toLowerCase())) continue;
        const rel = `\\${segs.slice(0, i).join('\\')}`;
        const key = rel.toLowerCase();
        const p = m.get(key) || { rel, vol: f.vol, seen: new Set() };
        p.seen.add(segs[i].toLowerCase());
        m.set(key, p);
        break;
      }
    }
    return m;
  };

  check({ id: 'video-in-project', group: 'video', title: 'Every video goes into a project folder' }, (rule) => {
    const pre = needVideoDrives(rule) || (subNames.length ? null : off(rule, 'video.subfolders'));
    if (pre) return pre;
    const loose = videoFiles().filter((f) => !segsOf(dirOf(f.rel)).some((s) => subSet.has(s.toLowerCase())));
    const bytes = loose.reduce((s, f) => s + (f.size || 0), 0);
    return result(rule, {
      count: loose.length, bytes,
      rows: byFolder(loose, (f) => where(f.vol, dirOf(f.rel) || '\\'), 'video'),
      summary: loose.length ? `${plural(loose.length, 'video')} (${gb(bytes)}) on the work and archive drives are not inside ${subNames.join(', ')}.` : 'Every video on the work and archive drives is inside a project folder.',
    });
  });

  check({ id: 'video-subfolders', group: 'video', title: 'Every project has all its subfolders' }, (rule) => {
    const pre = needVideoDrives(rule) || (subNames.length ? null : off(rule, 'video.subfolders'));
    if (pre) return pre;
    const rows = [];
    let total = 0;
    for (const s of videoScopes) {
      for (const p of projectsOf(s).values()) {
        total++;
        const missing = subNames.filter((n) => !p.seen.has(n.toLowerCase()));
        if (missing.length) rows.push({ path: where(p.vol, p.rel), size: null, detail: `no media in ${missing.join(', ')}` });
      }
    }
    if (!total) return result(rule, { status: 'off', summary: `No project folders found yet: none on the work or archive drive has media inside ${subNames.join(', ')}.` });
    return result(rule, {
      count: rows.length, rows,
      summary: `${rows.length ? `${plural(rows.length, 'project folder')} of ${total.toLocaleString()} have no media in one of ${subNames.join(', ')}.` : `All ${plural(total, 'project folder')} have media in every subfolder.`} Empty subfolders cannot be seen, because only media files are indexed.`,
    });
  });

  check({ id: 'video-one-place', group: 'video', title: 'Every project lives in one place' }, (rule) => {
    if (!work || !archive) return off(rule, 'drives.work and drives.archive');
    const bad = unreachable(rule, [['drives.work', work], ['drives.archive', archive]]);
    if (bad) return bad;
    if (!subNames.length) return off(rule, 'video.subfolders');
    /** Project paths relative to the scope, with any root folders shared by all projects removed. */
    const keyed = (s) => {
      const ps = [...projectsOf(s).values()].map((p) => ({ ...p, segs: segsOf(p.rel.slice(s.prefix.length)) }));
      let common = 0;
      if (ps.length > 1) {
        const first = ps[0].segs;
        while (common < first.length - 1 && ps.every((p) => p.segs.length > common + 1 && p.segs[common].toLowerCase() === first[common].toLowerCase())) common++;
      }
      return new Map(ps.map((p) => [p.segs.slice(common).join('\\').toLowerCase(), p]));
    };
    const w = keyed(work);
    const a = keyed(archive);
    if (!w.size && !a.size) return result(rule, { status: 'off', summary: `No project folders found yet: none on the work or archive drive has media inside ${subNames.join(', ')}.` });
    const rows = [];
    for (const [k, p] of w) {
      if (!k || !a.has(k)) continue;
      rows.push({ path: where(p.vol, p.rel), size: null, detail: `also on the archive drive at ${where(a.get(k).vol, a.get(k).rel)}` });
    }
    return result(rule, {
      count: rows.length, rows,
      summary: rows.length ? `${plural(rows.length, 'project')} exist on both the work and the archive drive.` : `No project is on both drives (${w.size.toLocaleString()} on work, ${a.size.toLocaleString()} on archive).`,
    });
  });

  check({ id: 'video-finals-names', group: 'video', title: 'Finished videos follow the naming rule' }, (rule) => {
    const pre = needVideoDrives(rule) || (isSet(video.finalsFolder) ? null : off(rule, 'video.finalsFolder'))
      || (isSet(video.finalsPattern) ? null : off(rule, 'video.finalsPattern'));
    if (pre) return pre;
    const finals = video.finalsFolder.toLowerCase();
    const re = new RegExp(video.finalsPattern);
    const bad = [];
    let seenFinals = 0;
    for (const f of lib()) {
      if (!videoScopes.some((s) => inScope(s, f))) continue;
      if (!segsOf(dirOf(f.rel)).some((s) => s.toLowerCase() === finals)) continue;
      seenFinals += 1;
      const name = baseOf(f.rel);
      const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
      if (!re.test(stem)) bad.push({ path: where(f.vol, f.rel), size: f.size, detail: 'name does not match the pattern' });
    }
    const bytes = bad.reduce((s, r) => s + (r.size || 0), 0);
    if (!seenFinals) return result(rule, { status: 'off', summary: `No ${video.finalsFolder} folders with media found yet on the work or archive drive.` });
    return result(rule, {
      count: bad.length, bytes, rows: bad,
      summary: bad.length ? `${plural(bad.length, 'file')} in ${video.finalsFolder} folders are not named by the pattern.` : `Every file in ${video.finalsFolder} folders follows the naming pattern.`,
    });
  });

  check({ id: 'video-archive-copy', group: 'video', title: 'Archived videos have a second copy' }, (rule) => {
    if (!archive) return off(rule, 'drives.archive');
    const bad = unreachable(rule, [['drives.archive', archive]]);
    if (bad) return bad;
    const disksBySha = new Map();
    for (const f of lib()) {
      if (!f.sha256 || !f.vol) continue;
      const d = hp.diskOfVol(f.vol);
      const s = disksBySha.get(f.sha256) || new Set();
      s.add(d);
      disksBySha.set(f.sha256, s);
    }
    const extraScopes = [['second copy', scope(drives.secondCopy)], ['family backup', scope(drives.familyBackup)]].filter(([, s]) => s && s.vol);
    const shaIn = extraScopes.map(([n, s]) => [n, new Set(lib().filter((f) => f.sha256 && inScope(s, f)).map((f) => f.sha256))]);
    const archDisk = hp.diskOfVol(archive.vol);
    const vids = lib().filter((f) => VIDEO_EXT.has(extOf(f.rel)) && inScope(archive, f));
    const single = [];
    let unhashed = 0;
    const onExtra = shaIn.map(([n]) => ({ n, files: 0, bytes: 0 }));
    for (const f of vids) {
      if (!f.sha256) { unhashed++; continue; }
      const ds = disksBySha.get(f.sha256);
      if (![...ds].some((d) => d !== archDisk)) single.push(f);
      shaIn.forEach(([, set], i) => { if (set.has(f.sha256)) { onExtra[i].files++; onExtra[i].bytes += f.size || 0; } });
    }
    const bytes = single.reduce((s, f) => s + (f.size || 0), 0);
    let summary = single.length ? `${plural(single.length, 'archived video')} (${gb(bytes)}) have no copy on another disk.` : 'Every archived video with a checksum has a copy on another disk.';
    for (const e of onExtra) summary += ` ${plural(e.files, 'archived video')} (${gb(e.bytes)}) are already on the ${e.n} drive.`;
    if (unhashed) summary += ` ${plural(unhashed, 'video')} have no checksum yet and were not checked.`;
    return result(rule, { count: single.length, bytes, rows: byFolder(single, (f) => where(f.vol, dirOf(f.rel) || '\\'), 'video'), summary });
  });

  check({ id: 'video-same-drive-copies', group: 'video', title: 'No extra copies on the same drive' }, (rule) => {
    const groups = new Map();
    for (const f of lib()) {
      if (!f.sha256 || !VIDEO_EXT.has(extOf(f.rel))) continue;
      const k = `${f.vol}|${f.sha256}`;
      const g = groups.get(k);
      if (g) g.push(f); else groups.set(k, [f]);
    }
    const rows = [];
    let extra = 0;
    let wasted = 0;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const w = (g[0].size || 0) * (g.length - 1);
      extra += g.length - 1;
      wasted += w;
      rows.push({ path: where(g[0].vol, g[0].rel), size: w, detail: `${g.length} copies on this drive; also ${g.slice(1, 4).map((f) => f.rel).join(', ')}${g.length > 4 ? ' and more' : ''}` });
    }
    rows.sort((a, b) => b.size - a.size);
    return result(rule, {
      count: extra, bytes: wasted, rows,
      summary: extra ? `${plural(extra, 'extra video copy', 'extra video copies')} sit on the same drive as another copy, wasting ${gb(wasted)}.` : 'No video is stored twice on the same drive.',
    });
  });

  // ---- Cards ----

  check({ id: 'cards-age', group: 'cards', title: 'Cards are backed up within the time limit' }, (rule) => {
    const maxDays = Number(cfg.cards && cfg.cards.maxDays);
    if (!(maxDays > 0)) return off(rule, 'cards.maxDays');
    const disks = new Map();
    for (const l of db.prepare("SELECT file_id, vol, path FROM locations WHERE kind != 'lightroom' AND verified = 1").all()) {
      const vol = l.vol || hp.volOfPath(l.path);
      const s = disks.get(l.file_id) || new Set();
      s.add(vol ? hp.diskOfVol(vol) : `path:${normLetter(l.path || '')}`);
      disks.set(l.file_id, s);
    }
    const cards = new Map();
    for (const f of db.prepare("SELECT id, card_id, size, capture_date, mark FROM files").all()) {
      const c = cards.get(f.card_id) || { newest: '', unsafe: 0, bytes: 0 };
      if (f.capture_date && f.capture_date > c.newest) c.newest = f.capture_date;
      if (f.mark !== 'skip' && (disks.get(f.id) || new Set()).size < 2) { c.unsafe++; c.bytes += f.size || 0; }
      cards.set(f.card_id, c);
    }
    const names = new Map(db.prepare('SELECT id, serial, label, nickname FROM cards').all().map((c) => [c.id, c.nickname || c.label || c.serial || `Card ${c.id}`]));
    const limit = now - maxDays * DAY;
    const rows = [];
    let bytes = 0;
    for (const [id, c] of cards) {
      if (!c.unsafe || !c.newest) continue;
      const t = Date.parse(c.newest.slice(0, 10));
      if (!(t < limit)) continue;
      bytes += c.bytes;
      rows.push({ name: names.get(id) || `Card ${id}`, size: c.bytes, detail: `${plural(c.unsafe, 'file')} not on two disks; newest capture ${c.newest.slice(0, 10)} (${Math.floor((now - t) / DAY)} days ago)` });
    }
    rows.sort((a, b) => b.size - a.size);
    return result(rule, {
      count: rows.length, bytes, rows,
      summary: rows.length ? `${plural(rows.length, 'card')} hold files older than ${maxDays} days without verified copies on two separate disks.` : `No card holds files older than ${maxDays} days without two verified copies.`,
    });
  });

  // ---- General ----

  const ageCheck = (dirs, days, depth) => {
    const limit = now - days * DAY;
    const rows = [];
    let count = 0;
    let bytes = 0;
    const walk = (dir, d) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (d < depth) walk(p, d + 1);
        } else if (e.isFile()) {
          let st;
          try { st = fs.statSync(p); } catch { continue; }
          if (st.mtimeMs >= limit) continue;
          count++;
          bytes += st.size;
          if (rows.length <= MAX_ROWS) rows.push({ path: p, size: st.size, detail: `${Math.floor((now - st.mtimeMs) / DAY)} days old` });
        }
      }
    };
    let missing = 0;
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) { missing++; continue; }
      walk(dir, 1);
    }
    rows.sort((a, b) => b.size - a.size);
    return { rows, count, bytes, missing };
  };
  const missingNote = (n) => (n ? ` ${plural(n, 'configured folder')} could not be found.` : '');

  check({ id: 'inbox-age', group: 'general', title: 'Inbox folders are emptied' }, (rule) => {
    const dirs = list(folders.inbox);
    if (!dirs.length) return off(rule, 'folders.inbox');
    const days = Number(cfg.ages && cfg.ages.inboxDays) || 7;
    const { missing, ...r } = ageCheck(dirs, days, 2);
    return result(rule, {
      ...r,
      status: r.count || missing ? 'warn' : 'ok',
      summary: (r.count ? `${plural(r.count, 'file')} (${gb(r.bytes)}) in your inbox folders are older than ${days} days.` : `Nothing in your inbox folders is older than ${days} days.`) + missingNote(missing),
    });
  });

  check({ id: 'sort-age', group: 'general', title: 'The sort folder is sorted' }, (rule) => {
    if (!isSet(folders.sort)) return off(rule, 'folders.sort');
    const days = Number(cfg.ages && cfg.ages.sortDays) || 31;
    const { missing, ...r } = ageCheck([folders.sort], days, 4);
    return result(rule, {
      ...r,
      status: r.count || missing ? 'warn' : 'ok',
      summary: (r.count ? `${plural(r.count, 'file')} (${gb(r.bytes)}) in the sort folder are older than ${days} days.` : `Nothing in the sort folder is older than ${days} days.`) + missingNote(missing),
    });
  });

  return { checked: new Date(now).toISOString(), ms: Date.now() - started, rules };
}

module.exports = { runRules };
