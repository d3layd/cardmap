// Finds imported camera media on a drive without reading any file contents: it only
// lists folders and looks at each file's name, type, size and where it sits.
//
// The aim is to pick out what came off a camera, drone or phone, and leave out
// screenshots, web graphics, stock footage, exports, caches and app files, so the
// library index can be built from those files alone instead of from whole drives.
const fs = require('node:fs');
const path = require('node:path');

const RAW = new Set(['nef', 'nrw', 'cr2', 'cr3', 'crw', 'arw', 'srf', 'sr2', 'raf', 'dng', 'orf', 'rw2', 'pef', 'x3f', '3fr', 'iiq', 'gpr', 'braw', 'r3d']);
const STILL = new Set(['jpg', 'jpeg', 'heic', 'heif']);
const VIDEO = new Set(['mov', 'mp4', 'm4v', 'mts', 'm2ts', 'mxf', 'avi', 'insv', 'insp', '360']);

// Folders that are never walked into.
const SKIP_DIRS = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'appdata', '$recycle.bin', 'system volume information',
  'node_modules', '.git', '.cache', 'steamlibrary', 'steamapps', 'xampp', 'wsl', 'windowsapps', 'wpsystem', 'perflogs', 'recovery',
  'msocache', 'config.msi', '$windows.~bt', '$windows.~ws', 'onedrivetemp',
]);

const inFolder = (names) => new RegExp('\\\\(' + names.join('|') + ')\\\\', 'i');

// Folders whose contents are never camera originals, whatever the file type.
const JUNK_PATH = inFolder([
  'cache', 'caches', 'temp', 'tmp', 'thumbnails?', '\\.thumbnails', 'thumbs',
  'adobe premiere pro (auto-save|video previews|audio previews|captured audio)', 'media cache( files)?', 'peak files', 'adobemediacache',
  'motion array[^\\\\]*', 'envato[^\\\\]*', 'htdocs', 'wp-content', 'public_html', 'vendor', 'dist', 'icons?', 'sprites?',
]);

// Folders that hold finished or borrowed work. A JPG or video in one of these is an
// export, a screenshot or stock; a raw file is still a camera original.
const OUTPUT_PATH = inFolder([
  'stock( footage| photos| video| assets)?', 'templates?', 'screenshots?', 'screen ?recordings?', 'screen ?captures?', 'captures',
  'exports?', 'exported', 'renders?', 'rendered', 'deliver(y|ed|ables)', 'finals?', 'edited', 'edits', 'web( ?size| ?res)?', 'social( media)?', 'proofs?', 'build',
]);

// File names that mark a still or video as not straight off a camera.
const JUNK_NAME = /screen ?shot|screen ?record|screencast|screen ?capture|^capture|^snip|adobestock|shutterstock|istock|pexels|pixabay|envato|motion ?array|unsplash|whatsapp|^fb_img|^received_|^signal-|^telegram|thumb|icon|logo|banner|export|render|\bfinal\b|\bedit(ed)?\b|\bcopy\b|-edit|_edit|sneak ?peek|watermark|proof/i;

// A screen recorder's default name: "2026-06-10 17-43-53.mp4".
const RECORDER_NAME = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}/;

// Names cameras, drones and phones give their files.
// Each rule carries a plain description and an example, so the app can show what it looks for.
const CAMERA_RULES = [
  { re: /^_?DSC[_NF]?\d{4,5}/i, label: 'Nikon, Sony, Fujifilm', example: 'DSC_0042.JPG, _DSC0042.JPG, DSCF0042.JPG' },
  { re: /^_?[A-Z]{3}_?\d{4,5}\./i, label: 'Three letters set in the camera, then a number', example: 'ABC_1234.JPG, _ABC1234.JPG' },
  { re: /^(IMG|MVI|_MG|CRW|EOS)_\d{4}/i, label: 'Canon, iPhone', example: 'IMG_1234.JPG, MVI_1234.MOV' },
  { re: /^DJI_\d{4}/i, label: 'DJI drones', example: 'DJI_0327.MP4' },
  { re: /^DJI_\d{14}_\d{4}/i, label: 'DJI drones (dated names)', example: 'DJI_20260506133801_0001.MP4' },
  { re: /^(GOPR|GP|GH|GX|GS|G)\d{6,7}/i, label: 'GoPro', example: 'GOPR0042.MP4, GX010405.MP4' },
  { re: /^C\d{4}\./i, label: 'Sony video', example: 'C0001.MP4' },
  { re: /^MAH\d{5}/i, label: 'Sony video (older)', example: 'MAH00042.MP4' },
  { re: /^P\d{7}/i, label: 'Panasonic', example: 'P1000042.JPG' },
  { re: /^(IMGP|PICT|SAM_|SDC|CIMG|KIF_|DSCF|DSCN|R\d{7})\d*/i, label: 'Pentax, Samsung, Casio, Ricoh and others', example: 'IMGP0042.JPG, SAM_0042.JPG' },
  { re: /^PXL_\d{8}_/i, label: 'Pixel phones', example: 'PXL_20260819_143609.jpg' },
  { re: /^(VID|IMG|PANO|PRO_VID|LRV)_\d{8}_\d{6}/i, label: 'Android phones, Insta360', example: 'VID_20260819_143609.mp4' },
  { re: /^\d{8}_\d{6}/, label: 'Phones (date and time as the name)', example: '20260819_143609.jpg' },
  { re: /^MOV_?\d{4,5}/i, label: 'Camcorders', example: 'MOV_0042.mp4' },
  { re: /^(A|B|C)\d{3}_?C\d{3}/i, label: 'Cinema cameras', example: 'A001_C003.MOV' },
];
const CAMERA_NAMES = CAMERA_RULES.map((r) => r.re);

// A camera card's own folders: DCIM, and names like 100NIKON or 101MEDIA.
const CARD_FOLDER = /\\DCIM\\|\\\d{3}[A-Z0-9_]{5}\\/i;

/**
 * Prefixes this user's own files have, learned from what CardMap has already seen on
 * cards and in the Lightroom catalog cache (names only). A prefix is the letters before
 * the first digit, and it has to turn up often to count.
 */
const LEARN_MIN = 25; // a prefix has to appear on this many files to be learned
const prefixOf = (name) => {
  const m = /^([A-Za-z_\-]{2,24})(?=\d)/.exec(name || '');
  return m ? m[1].toUpperCase() : null;
};
const cleanPrefix = (p) => String(p || '').trim().toUpperCase().replace(/[^A-Z0-9_\- ]/g, '').slice(0, 24);
const readList = (db, key) => {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value ? JSON.parse(row.value) : [];
  } catch {
    return [];
  }
};

/**
 * Every prefix the scan knows about beyond the built-in camera names:
 *  - learned: seen often on your cards or in the Lightroom catalog cache;
 *  - added: ones you typed in.
 * Each has a count of the known files that carry it, an example, and whether it is in use.
 */
function prefixList(db) {
  const seen = new Map(); // prefix -> { count, example }
  const add = (name) => {
    const k = prefixOf(name);
    if (!k) return;
    const e = seen.get(k) || { count: 0, example: name };
    e.count += 1;
    seen.set(k, e);
  };
  for (const r of db.prepare('SELECT name FROM files').all()) add(r.name);
  try {
    for (const r of db.prepare('SELECT name FROM lr_assets').all()) add(r.name);
  } catch {
    /* no Lightroom cache yet */
  }
  const ignored = new Set(readList(db, 'scanIgnoredPrefixes'));
  const custom = readList(db, 'scanPrefixes');
  const out = custom.map((p) => ({ prefix: p, source: 'added', count: (seen.get(p) || {}).count || 0, example: (seen.get(p) || {}).example || '', active: true }));
  for (const [k, e] of seen) {
    if (e.count < LEARN_MIN || custom.includes(k)) continue;
    if (JUNK_NAME.test(k)) continue; // e.g. SCREENSHOT_ or an export prefix: those names are left out anyway
    out.push({ prefix: k, source: 'learned', count: e.count, example: e.example, active: !ignored.has(k) });
  }
  return out.sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

/** The prefixes actually used by a scan. */
function learnPrefixes(db) {
  return prefixList(db).filter((p) => p.active).map((p) => p.prefix);
}

/** What the scan looks for and leaves out, in plain words, for display. */
function describeRules() {
  return {
    raw: [...RAW].sort(),
    still: [...STILL].sort(),
    video: [...VIDEO].sort(),
    minStill: 300 * 1024,
    minVideo: 2 * 1024 * 1024,
    learnMin: LEARN_MIN,
    cameraNames: CAMERA_RULES.map((r) => ({ label: r.label, example: r.example })),
    junkFolders: ['cache', 'temp', 'tmp', 'thumbnails', 'Premiere auto-save and preview folders', 'media cache', 'Motion Array', 'Envato', 'htdocs', 'wp-content', 'vendor', 'dist', 'icons', 'sprites'],
    outputFolders: ['stock', 'templates', 'screenshots', 'screen recordings', 'captures', 'exports', 'renders', 'delivery', 'finals', 'edited', 'edits', 'web', 'social', 'proofs', 'build'],
    // Kept in step with JUNK_NAME and RECORDER_NAME above.
    junkWords: ['screenshot', 'screen recording', 'screencast', 'capture', 'snip', 'AdobeStock', 'Shutterstock', 'iStock', 'Pexels', 'Pixabay', 'Envato', 'Motion Array',
      'Unsplash', 'WhatsApp', 'FB_IMG', 'received_', 'signal-', 'telegram', 'thumb', 'icon', 'logo', 'banner', 'export', 'render', 'final', 'edit', 'edited', 'copy',
      'sneak peek', 'watermark', 'proof', 'a screen recorder\'s date-and-time name (2026-06-10 17-43-53)'],
    neverWalked: [...SKIP_DIRS].sort(),
  };
}

/**
 * Decide what a file is from its name, type, size and folder alone.
 * Returns 'raw' | 'still' | 'video' for imported camera media, or null to leave it out.
 */
function classify(full, size, prefixes) {
  const name = path.basename(full);
  const ext = path.extname(name).slice(1).toLowerCase();
  if (name.startsWith('._')) return null;
  const isRaw = RAW.has(ext);
  if (!isRaw && !STILL.has(ext) && !VIDEO.has(ext)) return null; // png, gif, psd, tif and so on are not camera originals
  if (JUNK_PATH.test(full)) return null;
  if (isRaw) return 'raw'; // a raw file is a camera original wherever it sits
  const kind = STILL.has(ext) ? 'still' : 'video';
  if (size < (kind === 'still' ? 300 * 1024 : 2 * 1024 * 1024)) return null; // thumbnails, web images, clips
  if (CARD_FOLDER.test(full)) return kind;
  if (OUTPUT_PATH.test(full)) return null;
  if (JUNK_NAME.test(name) || RECORDER_NAME.test(name)) return null;
  if (CAMERA_NAMES.some((re) => re.test(name))) return kind;
  const upper = name.toUpperCase();
  if (prefixes && prefixes.some((p) => upper.startsWith(p) && /\d/.test(upper[p.length] || ''))) return kind;
  return null;
}

/** Walk a drive or folder, yielding { full, size, mtime, kind } for imported camera media only. */
async function* walkCamera(root, opts, job) {
  const stack = [root];
  const excluded = (opts.excluded || []).map((p) => p.toLowerCase().replace(/\\+$/, ''));
  while (stack.length) {
    if (job && job.cancelled) return;
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const lower = e.name.toLowerCase();
        if (SKIP_DIRS.has(lower) || lower.startsWith('$')) continue;
        if (excluded.includes(full.toLowerCase())) continue;
        stack.push(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (!RAW.has(ext) && !STILL.has(ext) && !VIDEO.has(ext)) continue; // decided without touching the file
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        const kind = classify(full, st.size, opts.prefixes);
        if (opts.onFile) opts.onFile(Boolean(kind));
        if (kind) yield { full, size: st.size, mtime: Math.round(st.mtimeMs), kind };
      }
    }
  }
}

module.exports = { classify, learnPrefixes, prefixList, prefixOf, cleanPrefix, describeRules, walkCamera, RAW, STILL, VIDEO };
