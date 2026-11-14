// Watches the drives and folders in the library index for files being added, changed,
// moved or deleted, and hands them over in batches once things go quiet. Windows reports
// changes for a whole drive through one recursive watch, so this costs next to nothing
// while nothing is happening.
const fs = require('node:fs');
const path = require('node:path');
const { RAW, STILL, VIDEO } = require('./discover');
const { MEDIA_EXT } = require('./util');

const QUIET_MS = 8000; // wait this long after the last change before applying a batch
const SKIP = /\\(\$recycle\.bin|system volume information|\.trash[^\\]*|node_modules|\.git|appdata)(\\|$)/i;

const extOf = (p) => path.extname(p).slice(1).toLowerCase();
const isMediaPath = (p) => {
  const e = extOf(p);
  return RAW.has(e) || STILL.has(e) || VIDEO.has(e) || (MEDIA_EXT && MEDIA_EXT.has && MEDIA_EXT.has(e));
};

/** onBatch({ files, folders }) is called with the paths that changed. */
function createWatcher(onBatch) {
  const watchers = new Map(); // root -> FSWatcher
  let files = new Set();
  let folders = new Set();
  let timer = null;

  const flush = () => {
    timer = null;
    if (!files.size && !folders.size) return;
    const batch = { files: [...files], folders: [...folders] };
    files = new Set();
    folders = new Set();
    onBatch(batch);
  };

  const onEvent = (root, name) => {
    if (!name) return;
    const full = path.join(root, name);
    if (SKIP.test(`\\${name}`)) return; // judged on the part inside the watched folder
    if (isMediaPath(full)) files.add(full);
    else if (!path.extname(name)) folders.add(full); // probably a folder renamed, moved or deleted
    else return; // some other kind of file
    clearTimeout(timer);
    timer = setTimeout(flush, QUIET_MS);
  };

  /** Watch exactly these roots (drive roots or folders); stop watching anything else. */
  function set(roots) {
    const want = new Set(roots.map((r) => r.replace(/[\\/]+$/, '') + '\\'));
    for (const [root, w] of watchers) {
      if (!want.has(root)) {
        w.close();
        watchers.delete(root);
      }
    }
    for (const root of want) {
      if (watchers.has(root) || !fs.existsSync(root)) continue;
      try {
        const w = fs.watch(root, { recursive: true, persistent: false }, (_ev, name) => onEvent(root, name && String(name)));
        w.on('error', () => {
          // Usually the drive was unplugged. It is watched again when it comes back.
          w.close();
          watchers.delete(root);
        });
        watchers.set(root, w);
      } catch {
        /* cannot watch this one (for example a network drive) */
      }
    }
    return [...watchers.keys()];
  }

  const close = () => set([]);
  const watching = () => [...watchers.keys()];
  return { set, close, watching, flush };
}

module.exports = { createWatcher };
