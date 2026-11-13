const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { isMedia, pickFiles } = require('./core/util');
const { findCatalogs, refreshIndex, cacheStatus, albumsOverview } = require('./core/lrcatalog');
const path = require('node:path');
const fs = require('node:fs');
const { openDb, getSettings, setSettings } = require('./core/db');
const { listDrives } = require('./core/drives');
const { setVolumes, syncDb, pin, currentPath, online, pathExists } = require('./core/volumes');
const { scanCard, cardSummary } = require('./core/cards');
const { runImport } = require('./core/importer');
const { findOriginalsRoots, runLightroomCheck } = require('./core/lightroom');
const { runFolderScan, inventory, hashPending, indexStatus, discover, foundFolders, dropScanned } = require('./core/libindex');
const { overview, listFiles } = require('./core/library');

let win = null;
let db = null;
let drives = [];
let job = null;
let jobSeq = 0;
// cardId -> ids of the files on the card at its last scan
const present = new Map();

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// The background indexer has its own slot, separate from the one-at-a-time task above.
let bg = null;
let bgProgress = null;
let startIndexing = () => {};

let volumesNow = []; // every connected volume: { letter, serial, label }
let volumeKey = null;
async function refreshDrives() {
  try {
    const { cards, volumes } = await listDrives();
    // Drives are known by serial number, so a changed letter is noticed here and the
    // recorded paths for that drive are rewritten to the new letter.
    const key = JSON.stringify(volumes.map((v) => [v.serial, v.letter]));
    if (key !== volumeKey) {
      volumeKey = key;
      volumesNow = volumes;
      setVolumes(volumes);
      const moved = syncDb(db, volumes);
      if (moved) send('volumes', { moved });
    }
    const changed = JSON.stringify(cards.map((d) => d.serial)) !== JSON.stringify(drives.map((d) => d.serial));
    drives = cards;
    if (changed) send('cards', cardList());
  } catch {
    /* keep the last known list */
  }
}

// Folder settings are stored pinned to their drive, and read back at its current letter.
const readPin = (json) => {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
};

function cardList() {
  const known = db.prepare('SELECT * FROM cards ORDER BY last_seen DESC').all();
  const bySerial = new Map(known.map((c) => [c.serial, c]));
  const mountedSerials = new Set(drives.map((d) => d.serial));
  return {
    mounted: drives.map((d) => ({ ...d, cardId: bySerial.get(d.serial)?.id ?? null, nickname: bySerial.get(d.serial)?.nickname || '' })),
    past: known.filter((c) => !mountedSerials.has(c.serial)),
    names: [...new Set(known.map((c) => c.nickname).filter(Boolean))].sort(),
  };
}

function driveFor(cardId) {
  const card = db.prepare('SELECT serial FROM cards WHERE id = ?').get(cardId);
  return card ? drives.find((d) => d.serial === card.serial) : null;
}

function lightroomRoots() {
  return findOriginalsRoots(getSettings(db).lightroomOriginals || '');
}

function startJob(kind, fn, silent = false) {
  if (job) throw new Error('Another task is still running.');
  const j = { id: ++jobSeq, kind, cancelled: false };
  job = j;
  // silent: progress still shows, but no result message when it finishes.
  const emit = (p) => send('job', { id: j.id, kind, silent, ...p });
  emit({ label: 'Starting' });
  fn(j, emit)
    .then(
      (result) => ({ result }),
      (e) => ({ error: e.cancelled ? 'Cancelled' : e.message })
    )
    .then((out) => {
      job = null;
      send('job', { id: j.id, kind, silent, done: true, ...out });
    });
  return j.id;
}

function registerIpc() {
  ipcMain.handle('cards', async () => {
    await refreshDrives();
    return cardList();
  });

  // Read a mounted card and return its per-date status.
  ipcMain.handle('card:scan', async (_e, letter) => {
    const drive = drives.find((d) => d.letter === letter);
    if (!drive) throw new Error('That card is no longer connected.');
    const { cardId, presentIds } = await scanCard(db, drive);
    present.set(cardId, presentIds);
    return { ...cardSummary(db, cardId, presentIds), letter, mounted: true };
  });

  ipcMain.handle('card:summary', (_e, cardId) => {
    const drive = driveFor(cardId);
    const s = cardSummary(db, cardId, drive ? present.get(cardId) : null);
    return s && { ...s, letter: drive?.letter ?? null, mounted: Boolean(drive) };
  });

  ipcMain.handle('import:start', (_e, opts) => {
    const drive = driveFor(opts.cardId);
    if (!drive) throw new Error('Insert the card to import from it.');
    setSettings(db, {
      dest: opts.dest || '', backup: opts.backup || '',
      destPin: opts.dest ? JSON.stringify(pin(opts.dest)) : '', backupPin: opts.backup ? JSON.stringify(pin(opts.backup)) : '',
    });
    return startJob('import', (j, emit) => runImport(db, { ...opts, letter: drive.letter }, j, emit));
  });

  ipcMain.handle('lightroom:start', (_e, opts) => {
    const drive = driveFor(opts.cardId);
    return startJob('lightroom', (j, emit) =>
      runLightroomCheck(db, { ...opts, letter: drive?.letter ?? null, roots: lightroomRoots(), catalogs: findCatalogs('') }, j, emit)
    );
  });

  // Search folders on disk for copies of card files. arg: a folder path, or { folders, cardId }.
  ipcMain.handle('folderscan:start', (_e, arg) => {
    const opts = typeof arg === 'string' ? { folders: [arg] } : arg || {};
    const mounted = Object.fromEntries(drives.map((d) => [d.serial, d.letter]));
    return startJob('folderscan', (j, emit) => runFolderScan(db, { folders: opts.folders, cardId: opts.cardId || null, mounted }, j, emit));
  });

  // The folders the user keeps media in, remembered for "Find local copies".
  // Each is pinned to its drive, so it still points at the right place if the letter changes.
  const libraryFolders = () => {
    let pins = [];
    try {
      pins = JSON.parse(getSettings(db).libraryFolders || '[]');
    } catch {
      pins = [];
    }
    return pins.map((p) => {
      const pinned = typeof p === 'string' ? pin(p) : p;
      const now = currentPath(pinned);
      return { path: now, exists: online(pinned.vol) && fs.existsSync(now) };
    });
  };
  ipcMain.handle('library:folders', libraryFolders);

  // ----- The library index: saved checksums for the files in those folders -----
  const onlineFolders = () => libraryFolders().filter((f) => f.exists).map((f) => f.path);
  // Which drives the imported-media scan covers (by drive ID), and folders left out of it.
  const scanSerials = () => {
    try {
      return JSON.parse(getSettings(db).indexDrives || '[]');
    } catch {
      return [];
    }
  };
  const excludedPins = () => {
    try {
      return JSON.parse(getSettings(db).indexExcludes || '[]');
    } catch {
      return [];
    }
  };
  const cardSerials = () => new Set(drives.map((d) => d.serial));
  const scanRoots = () => volumesNow.filter((v) => scanSerials().includes(v.serial) && !cardSerials().has(v.serial)).map((v) => `${v.letter}\\`);

  ipcMain.handle('index:status', () => ({
    ...indexStatus(db, libraryFolders()),
    running: Boolean(bg),
    progress: bgProgress,
    // Every connected drive except camera cards; ticked ones are scanned.
    drives: volumesNow.filter((v) => !cardSerials().has(v.serial)).map((v) => ({ ...v, selected: scanSerials().includes(v.serial) })),
    found: foundFolders(db).slice(0, 80).map((g) => ({ ...g, path: g.path || `${g.rel} (drive not connected)` })),
    excluded: excludedPins().map((p) => currentPath(p)),
  }));
  ipcMain.handle('index:setDrives', (_e, serials) => setSettings(db, { indexDrives: JSON.stringify([...new Set(serials || [])]) }));
  ipcMain.handle('index:exclude', (_e, folder) => {
    const pins = excludedPins().filter((p) => currentPath(p).toLowerCase() !== String(folder).toLowerCase());
    pins.push(pin(folder));
    setSettings(db, { indexExcludes: JSON.stringify(pins) });
    return dropScanned(db, folder);
  });
  ipcMain.handle('index:include', (_e, folder) => {
    setSettings(db, { indexExcludes: JSON.stringify(excludedPins().filter((p) => currentPath(p).toLowerCase() !== String(folder).toLowerCase())) });
  });

  // Quick: list the extra folders and note sizes and dates. Reads no file contents.
  ipcMain.handle('index:inventory', () => startJob('inventory', (j, emit) => inventory(db, onlineFolders(), j, emit)));

  // The background pipeline. It runs beside other work and stands aside whenever
  // another task (an import, a check) is running.
  //   1. scan the ticked drives for imported camera media (names and sizes only);
  //   2. list the extra folders;
  //   3. if asked, read every file that has no checksum yet (the slow part).
  startIndexing = (withChecksums = true) => {
    if (bg) return;
    const j = { cancelled: false };
    bg = j;
    bgProgress = { label: 'Starting' };
    if (withChecksums) setSettings(db, { libIndexAuto: '1' });
    const emit = (p) => {
      bgProgress = p;
      send('bg', p);
    };
    (async () => {
      const scan = await discover(db, scanRoots(), { excluded: excludedPins().map((p) => currentPath(p)) }, j, emit);
      if (j.cancelled) return { ...scan, scanOnly: true, cancelled: true };
      await inventory(db, onlineFolders(), j, emit);
      if (!withChecksums) return { ...scan, scanOnly: true };
      return { scan, ...(await hashPending(db, { shouldPause: () => Boolean(job) }, j, emit)) };
    })()
      .then(
        (result) => ({ result }),
        (e) => ({ error: e.cancelled ? 'Stopped' : e.message })
      )
      .then((out) => {
        bg = null;
        bgProgress = null;
        // Finished everything it could reach: nothing to resume next launch.
        if (out.result && !out.result.cancelled && !out.result.scanOnly) setSettings(db, { libIndexAuto: '' });
        send('bg', { done: true, ...out });
      });
  };
  ipcMain.handle('index:start', () => startIndexing(true));
  ipcMain.handle('index:scan', () => startIndexing(false));
  ipcMain.handle('index:stop', () => {
    setSettings(db, { libIndexAuto: '' });
    if (bg) bg.cancelled = true;
  });
  ipcMain.handle('library:setFolders', (_e, list) => {
    const clean = [...new Set((list || []).map((p) => String(p).trim()).filter(Boolean))];
    setSettings(db, { libraryFolders: JSON.stringify(clean.map(pin)) });
    return libraryFolders();
  });

  // The cached copy of Lightroom's catalog metadata.
  ipcMain.handle('lrcache:status', () => cacheStatus(db, findCatalogs('')));
  ipcMain.handle('lrcache:albums', () => albumsOverview(db));
  ipcMain.handle('lrcache:refresh', (_e, rebuild) =>
    startJob('lrcache', (j, emit) => refreshIndex(db, findCatalogs(''), j, emit, { rebuild: Boolean(rebuild) }))
  );

  ipcMain.handle('job:cancel', () => {
    if (job) job.cancelled = true;
  });

  ipcMain.handle('map', (_e, q) => overview(db, q || ''));

  // Individual files. Each gets `openPath`: the best file to preview or open,
  // preferring a copy on disk over the (slower) card.
  ipcMain.handle('files', (_e, q) => {
    const letters = new Map();
    for (const d of drives) {
      const c = db.prepare('SELECT id FROM cards WHERE serial = ?').get(d.serial);
      if (c) letters.set(c.id, d.letter);
    }
    return listFiles(db, q).map((f) => {
      const copy = f.locations.find((l) => l.exists && !l.path.startsWith('lightroom:'));
      const onCard = letters.has(f.cardId) ? path.join(`${letters.get(f.cardId)}\\`, f.relPath) : null;
      const openPath = copy ? copy.path : onCard && fs.existsSync(onCard) ? onCard : null;
      return { ...f, openPath, openFrom: copy ? 'copy' : openPath ? 'card' : null };
    });
  });

  // Small preview image, made by Windows (the same thumbnails File Explorer shows).
  ipcMain.handle('thumb', async (_e, p) => {
    if (!p || !isMedia(p) || !fs.existsSync(p)) return null;
    try {
      const img = await nativeImage.createThumbnailFromPath(p, { width: 192, height: 192 });
      return img.isEmpty() ? null : img.toDataURL();
    } catch {
      return null;
    }
  });

  // Files in the chosen dates/folders that are not yet recorded as being in Lightroom,
  // each as the best path to hand over: a copy on disk if there is one, else the card.
  const notInLightroom = (q) => {
    const drive = driveFor(q.cardId);
    const pick = pickFiles(q);
    const inLr = db.prepare("SELECT 1 AS x FROM locations WHERE file_id = ? AND kind = 'lightroom' AND verified = 1");
    const copies = db.prepare("SELECT path, vol FROM locations WHERE file_id = ? AND kind != 'lightroom' AND verified = 1");
    const out = [];
    for (const f of db.prepare('SELECT * FROM files WHERE card_id = ? ORDER BY capture_date, rel_path').all(q.cardId)) {
      if ((pick && !pick(f)) || inLr.get(f.id)) continue;
      const copy = (copies.all(f.id).find((l) => pathExists(l.path, l.vol)) || {}).path;
      const onCard = drive ? path.join(`${drive.letter}\\`, f.rel_path) : null;
      const p = copy || (onCard && fs.existsSync(onCard) ? onCard : null);
      if (p) out.push(p);
    }
    return out;
  };
  ipcMain.handle('lightroom:pending', (_e, q) => notInLightroom(q).length);

  // Start an operating-system file drag, so the files can be dropped onto Lightroom's window.
  ipcMain.on('drag', (e, q) => {
    const files = notInLightroom(q);
    if (!files.length) return;
    const icon = nativeImage.createFromBitmap(Buffer.alloc(48 * 48 * 4, 0xb0), { width: 48, height: 48 });
    e.sender.startDrag({ file: files[0], files, icon });
  });

  // Bring up Lightroom, using the program Windows has registered for it.
  ipcMain.handle('lightroom:open', () => new Promise((resolve) => {
    execFile('reg', ['query', 'HKCR\\adobelightroom\\shell\\open\\command', '/ve'], { windowsHide: true }, (err, out) => {
      const m = !err && /"([^"]+lightroom\.exe)"/i.exec(out || '');
      if (!m || !fs.existsSync(m[1])) return resolve('Lightroom was not found on this computer.');
      spawn(m[1], [], { detached: true, stdio: 'ignore' }).unref();
      resolve('');
    });
  }));

  // Open a photo or video in its default app (Photos, a raw viewer, a video player).
  ipcMain.handle('open', async (_e, p) => {
    if (!p || !isMedia(p) || !fs.existsSync(p)) return 'That file is not available right now.';
    return shell.openPath(p);
  });

  ipcMain.handle('card:rename', (_e, { cardId, name }) => {
    db.prepare('UPDATE cards SET nickname = ? WHERE id = ?').run(String(name || '').trim().slice(0, 60), cardId);
    return cardList();
  });

  const settingsOut = () => {
    const s = getSettings(db);
    return {
      ...s,
      // The remembered folders, at whatever letter their drive has today.
      dest: currentPath(readPin(s.destPin)) || s.dest || '',
      backup: currentPath(readPin(s.backupPin)) || s.backup || '',
      lightroomDetected: lightroomRoots(),
      lightroomCatalogs: findCatalogs(''),
    };
  };
  ipcMain.handle('settings:get', settingsOut);
  ipcMain.handle('settings:set', (_e, obj) => {
    setSettings(db, obj);
    return settingsOut();
  });

  ipcMain.handle('pickFolder', async (_e, startAt) => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: startAt && fs.existsSync(startAt) ? startAt : undefined,
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('reveal', (_e, p) => {
    if (fs.existsSync(p)) shell.openPath(p);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    title: 'CardMap',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Development aid: CARDMAP_SHOT=<file.png> saves a screenshot a few seconds after load, then quits.
  if (process.env.CARDMAP_SHOT) {
    const errors = [];
    win.webContents.on('console-message', (e, level, message) => {
      // Newer Electron passes one event object; older versions pass (event, level, message).
      const lvl = e && e.level !== undefined ? e.level : level;
      const msg = e && e.message !== undefined ? e.message : message;
      if (lvl === 'error' || lvl === 'warning' || lvl >= 2) errors.push(String(msg));
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.CARDMAP_VIEW) {
          await win.webContents.executeJavaScript(`window.__show && window.__show(${JSON.stringify(process.env.CARDMAP_VIEW)})`);
          await new Promise((r) => setTimeout(r, Number(process.env.CARDMAP_SETTLE || 1500)));
        }
        win.show();
        win.focus();
        await new Promise((r) => setTimeout(r, 400));
        const img = await win.webContents.capturePage();
        const text = await win.webContents.executeJavaScript('document.body.innerText');
        fs.writeFileSync(process.env.CARDMAP_SHOT, img.toPNG());
        fs.writeFileSync(`${process.env.CARDMAP_SHOT}.log`, `ERRORS:\n${errors.join('\n')}\nTEXT:\n${text}`);
        app.quit();
      }, Number(process.env.CARDMAP_WAIT || 6000));
    });
  }
}

app.whenReady().then(() => {
  const dbFile = process.env.CARDMAP_DB || path.join(app.getPath('userData'), 'cardmap.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  db = openDb(dbFile);
  registerIpc();
  createWindow();
  refreshDrives();
  setInterval(refreshDrives, 5000);

  // Keep the cached copy of Lightroom's catalog current: shortly after opening, pick up
  // whatever Lightroom has changed since last time (quick once the first read is done).
  if (!process.env.CARDMAP_SHOT) {
    setTimeout(() => {
      const catalogs = findCatalogs('');
      if (!catalogs.length || job || cacheStatus(db, catalogs).upToDate) return;
      try {
        startJob('lrcache', (j, emit) => refreshIndex(db, catalogs, j, emit), true);
      } catch {
        /* another task started first; the next Lightroom check will refresh it */
      }
    }, 4000);
    // Carry on indexing the library if it was still going when the app was last closed.
    setTimeout(() => {
      if (getSettings(db).libIndexAuto === '1') startIndexing();
    }, 9000);
  }
});

app.on('window-all-closed', () => app.quit());
