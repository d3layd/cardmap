// Keeps a local cache of the metadata in Lightroom's (cloud) catalog. Strictly read-only
// on Lightroom's side.
//
// The catalog ("Managed Catalog.mcat") is a SQLite file holding one document per photo,
// video, album and album membership. Documents are MessagePack. Each photo/video has an
// "importSource" map with the original file's name, size and SHA-256, which is what lets
// a card file be matched to the catalog exactly.
//
// Only metadata is cached: names, sizes, checksums, dates, camera details, ratings and
// albums. No image data and no edit settings. After the first read, a refresh only reads
// what Lightroom has changed since (the catalog numbers every change in sequence).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { decode } = require('./msgpack');
const { tx, getSettings, setSettings } = require('./db');

const CACHE_VERSION = '2';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS lr_assets (
  asset_id TEXT PRIMARY KEY,
  kind TEXT,            -- image | video
  sha256 TEXT,
  size INTEGER,
  name TEXT,
  capture_time TEXT,
  capture_date TEXT,
  imported TEXT,
  device TEXT,          -- what it was added from
  width INTEGER,
  height INTEGER,
  camera TEXT,
  lens TEXT,
  camera_serial TEXT,
  iso INTEGER,
  rating INTEGER,
  uploaded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lr_assets_size ON lr_assets (size);
CREATE INDEX IF NOT EXISTS lr_assets_sha ON lr_assets (sha256);
CREATE INDEX IF NOT EXISTS lr_assets_name ON lr_assets (name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS lr_albums (
  album_id TEXT PRIMARY KEY,
  name TEXT,
  subtype TEXT,         -- collection (album) | collection_set (folder of albums)
  parent_id TEXT
);
CREATE TABLE IF NOT EXISTS lr_album_assets (
  doc_id TEXT PRIMARY KEY,
  album_id TEXT,
  asset_id TEXT
);
CREATE INDEX IF NOT EXISTS lr_album_assets_asset ON lr_album_assets (asset_id);
CREATE INDEX IF NOT EXISTS lr_album_assets_album ON lr_album_assets (album_id);
`;

function ensureSchema(db) {
  if (getSettings(db).lrCacheVersion !== CACHE_VERSION) {
    db.exec('DROP TABLE IF EXISTS lr_assets; DROP TABLE IF EXISTS lr_albums; DROP TABLE IF EXISTS lr_album_assets;');
    setSettings(db, { lrCacheVersion: CACHE_VERSION, lrIndexKey: '', lrSeq: '{}', lrRefreshedAt: '' });
  }
  db.exec(SCHEMA);
}

function findCatalogs(override) {
  if (override) return fs.existsSync(override) ? [override] : [];
  const base = path.join(process.env.LOCALAPPDATA || '', 'Adobe', 'Lightroom CC', 'Data');
  const out = [];
  try {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      const p = path.join(base, e.name, 'Managed Catalog.mcat');
      if (e.isDirectory() && fs.existsSync(p)) out.push(p);
    }
  } catch {
    /* Lightroom not installed */
  }
  return out;
}

// MessagePack writes a short string key as one length byte (0xa0 | length) then the text.
const keyBytes = (k) => Buffer.concat([Buffer.from([0xa0 | k.length]), Buffer.from(k, 'latin1')]);
const K_IMPORT = keyBytes('importSource');
const K_CAPTURE = keyBytes('captureDate');
// Present in the server's metadata once the original file itself is stored in the cloud.
const K_MASTER = keyBytes('/rels/master');

function valueAfter(buf, key) {
  const i = buf.indexOf(key);
  if (i < 0) return undefined;
  try {
    return decode(buf.subarray(i + key.length));
  } catch {
    return undefined;
  }
}

const toBuf = (v) => (v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength));
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : null);

/** Pull the cached fields out of one photo/video document. Returns null if it has no original. */
function assetRow(id, subtype, content, annotation) {
  let doc;
  try {
    doc = decode(content);
  } catch {
    // Unusual document: fall back to reading just the two parts that matter.
    doc = { importSource: valueAfter(content, K_IMPORT), captureDate: valueAfter(content, K_CAPTURE) };
  }
  const imp = doc && doc.importSource;
  if (!imp || typeof imp !== 'object' || !imp.sha256) return null;
  const xmp = (doc.xmp && typeof doc.xmp === 'object' && doc.xmp) || {};
  const ratings = doc.ratings && typeof doc.ratings === 'object' ? Object.values(doc.ratings) : [];
  const rating = ratings.map((r) => r && r.rating).find((r) => Number.isFinite(r));
  const cap = str(doc.captureDate);
  return [
    id, subtype, String(imp.sha256).toLowerCase(), int(imp.fileSize), str(imp.fileName),
    cap, cap ? cap.slice(0, 10) : null, str(imp.importTimestamp), str(imp.importedOnDevice) && imp.importedOnDevice.split(' {')[0],
    int(imp.originalWidth), int(imp.originalHeight),
    str(xmp.tiff && xmp.tiff.Model), str(xmp.aux && xmp.aux.Lens), str(xmp.aux && xmp.aux.SerialNumber),
    int(xmp.exif && xmp.exif.ISOSpeedRatings), rating == null ? null : int(rating),
    annotation && annotation.indexOf(K_MASTER) >= 0 ? 1 : 0,
  ];
}

const stampOf = (c) => {
  // While Lightroom is running, new entries sit in the -wal file beside the catalog,
  // so that file's size and time are part of "has it changed".
  const stamp = (p) => {
    try {
      const st = fs.statSync(p);
      return `${st.size}|${Math.round(st.mtimeMs)}`;
    } catch {
      return 'none';
    }
  };
  return `${c}|${stamp(c)}|${stamp(`${c}-wal`)}`;
};

function counts(db) {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    assets: one('SELECT count(*) AS n FROM lr_assets'),
    videos: one("SELECT count(*) AS n FROM lr_assets WHERE kind = 'video'"),
    albums: one("SELECT count(*) AS n FROM lr_albums WHERE subtype = 'collection'"),
  };
}

/**
 * Bring the cache up to date. Does nothing if the catalog file has not changed. Otherwise
 * reads only the changes since last time (or everything, the first time or with rebuild).
 * Returns { assets, videos, albums, changed, read }.
 */
async function refreshIndex(db, catalogs, job, emit, opts = {}) {
  ensureSchema(db);
  if (opts.rebuild) {
    db.exec('DELETE FROM lr_assets; DELETE FROM lr_albums; DELETE FROM lr_album_assets;');
    setSettings(db, { lrIndexKey: '', lrSeq: '{}' });
  }
  const key = catalogs.map(stampOf).join(';');
  if (getSettings(db).lrIndexKey === key) return { ...counts(db), changed: false, read: 0 };

  const seqs = JSON.parse(getSettings(db).lrSeq || '{}');
  const upAsset = db.prepare(
    `INSERT OR REPLACE INTO lr_assets (asset_id, kind, sha256, size, name, capture_time, capture_date, imported, device,
       width, height, camera, lens, camera_serial, iso, rating, uploaded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const delAsset = db.prepare('DELETE FROM lr_assets WHERE asset_id = ?');
  const upAlbum = db.prepare('INSERT OR REPLACE INTO lr_albums (album_id, name, subtype, parent_id) VALUES (?, ?, ?, ?)');
  const delAlbum = db.prepare('DELETE FROM lr_albums WHERE album_id = ?');
  const upLink = db.prepare('INSERT OR REPLACE INTO lr_album_assets (doc_id, album_id, asset_id) VALUES (?, ?, ?)');
  const delLink = db.prepare('DELETE FROM lr_album_assets WHERE doc_id = ?');

  let read = 0;
  for (const file of catalogs) {
    const cat = new DatabaseSync(file, { readOnly: true });
    try {
      let last = Number(seqs[file] || 0);
      const top = cat.prepare('SELECT max(sequence) AS m FROM revs').get().m || 0;
      const first = last === 0;
      // Every change in the catalog gets the next sequence number, so "what changed since
      // last time" is the documents whose current revision is numbered above it.
      const q = cat.prepare(
        `SELECT r.sequence AS seq, d.fullDocId AS id, d.type AS type, d.subtype AS subtype, d.deleted AS deleted,
                CAST(d.annotation AS BLOB) AS a, CAST(r.content AS BLOB) AS c
         FROM revs r JOIN docs d ON d.localDocId = r.localDocId AND d.winningRevSequence = r.sequence
         WHERE r.sequence > ? AND d.type IN ('asset', 'album', 'album_asset')
         ORDER BY r.sequence LIMIT 1500`
      );
      for (;;) {
        if (job && job.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        const batch = q.all(last);
        if (!batch.length) break;
        tx(db, () => {
          for (const r of batch) {
            const c = toBuf(r.c);
            if (r.type === 'asset') {
              const row = !r.deleted && c && (r.subtype === 'image' || r.subtype === 'video') ? assetRow(r.id, r.subtype, c, toBuf(r.a)) : null;
              if (row) upAsset.run(...row);
              else delAsset.run(r.id);
            } else {
              let doc = null;
              try {
                doc = !r.deleted && c ? decode(c) : null;
              } catch {
                doc = null;
              }
              if (r.type === 'album') {
                if (doc) upAlbum.run(r.id, str(doc.name) || '(unnamed)', r.subtype || null, (doc.parent && doc.parent.id) || null);
                else delAlbum.run(r.id);
              } else if (doc && doc.album && doc.asset) upLink.run(r.id, doc.album.id, doc.asset.id);
              else delLink.run(r.id);
            }
          }
          last = batch[batch.length - 1].seq;
          seqs[file] = last;
          setSettingsInTx(db, 'lrSeq', JSON.stringify(seqs));
        });
        read += batch.length;
        if (emit) {
          emit({
            label: first ? `Reading Lightroom's catalog for the first time: ${Math.round((last / top) * 100)}%` : `Reading changes from Lightroom's catalog: ${read}`,
          });
        }
        await new Promise((res) => setImmediate(res)); // keep the window responsive
      }
    } finally {
      cat.close();
    }
  }
  setSettings(db, { lrIndexKey: key, lrRefreshedAt: new Date().toISOString() });
  return { ...counts(db), changed: true, read };
}

// setSettings opens its own transaction; this variant is for use inside one.
function setSettingsInTx(db, k, v) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
}

/** What the cache currently holds. */
function cacheStatus(db, catalogs) {
  ensureSchema(db);
  const s = getSettings(db);
  return {
    ...counts(db),
    refreshedAt: s.lrRefreshedAt || null,
    upToDate: Boolean(catalogs.length) && s.lrIndexKey === catalogs.map(stampOf).join(';'),
    catalogs,
  };
}

function albumPaths(db) {
  const albums = new Map(db.prepare('SELECT * FROM lr_albums').all().map((a) => [a.album_id, a]));
  const pathOf = (id, depth = 0) => {
    const a = albums.get(id);
    if (!a) return null;
    const parent = a.parent_id && depth < 12 ? pathOf(a.parent_id, depth + 1) : null;
    return parent ? `${parent} / ${a.name.trim()}` : a.name.trim();
  };
  return { albums, pathOf };
}

/** Every album with how many photos it holds and the dates they span. */
function albumsOverview(db) {
  ensureSchema(db);
  const { albums, pathOf } = albumPaths(db);
  const stats = new Map(
    db
      .prepare(
        `SELECT l.album_id AS id, count(a.asset_id) AS n, min(a.capture_date) AS first, max(a.capture_date) AS last, sum(a.size) AS bytes
         FROM lr_album_assets l JOIN lr_assets a ON a.asset_id = l.asset_id GROUP BY l.album_id`
      )
      .all()
      .map((r) => [r.id, r])
  );
  return [...albums.values()]
    .filter((a) => a.subtype === 'collection')
    .map((a) => {
      const s = stats.get(a.album_id) || { n: 0, first: null, last: null, bytes: 0 };
      return { id: a.album_id, path: pathOf(a.album_id), count: s.n, first: s.first, last: s.last, bytes: s.bytes || 0 };
    })
    .sort((x, y) => (y.last || '').localeCompare(x.last || '') || x.path.localeCompare(y.path));
}

/** Names of the albums a photo is in. */
function albumsForAsset(db, assetId) {
  const { pathOf } = albumPaths(db);
  return db
    .prepare('SELECT album_id FROM lr_album_assets WHERE asset_id = ?')
    .all(assetId)
    .map((r) => pathOf(r.album_id))
    .filter(Boolean);
}

module.exports = { findCatalogs, refreshIndex, cacheStatus, albumsOverview, albumsForAsset, ensureSchema };
