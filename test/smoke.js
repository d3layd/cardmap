// End-to-end check of the core against a real mounted card.
// Usage: node test/smoke.js <work dir> [drive letter, e.g. E:] [max files]
// Copies a few files into <work dir>; never writes to the card.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { openDb } = require('../core/db');
const { listCardDrives } = require('../core/drives');
const { scanCard, cardSummary } = require('../core/cards');
const { runImport } = require('../core/importer');
const { findOriginalsRoots, runLightroomCheck } = require('../core/lightroom');
const { runFolderScan } = require('../core/folderscan');
const { overview, listFiles } = require('../core/library');
const { hashFile } = require('../core/util');
const { setVolumes, syncDb } = require('../core/volumes');
const { inventory, hashPending, matchCards, indexStatus } = require('../core/libindex');

(async () => {
  const work = process.argv[2];
  if (!work) throw new Error('Pass a work directory.');
  const maxFiles = Number(process.argv[4] || 3);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const db = openDb(path.join(work, 'test.db'));
  const job = { cancelled: false };

  const drives = await listCardDrives();
  console.log('cards:', drives.map((d) => `${d.letter} ${d.label} ${d.serial}`).join(' | '));
  const drive = drives.find((d) => d.letter === (process.argv[3] || drives[0]?.letter));
  assert(drive, 'no card mounted');

  let t = Date.now();
  const { cardId, presentIds } = await scanCard(db, drive, job);
  let s = cardSummary(db, cardId, presentIds);
  console.log(`scan ${drive.letter}: ${s.totals.count} files, ${(s.totals.bytes / 1e9).toFixed(1)} GB, ${s.groups.length} dates, ${Date.now() - t} ms`);
  console.log('dates:', s.groups.map((g) => `${g.key}(${g.count})`).join(' '));
  console.log('folders:', s.folders.map((g) => `${g.key}(${g.count})`).join(' '));
  assert.strictEqual(s.folders.reduce((n, g) => n + g.count, 0), s.totals.count);
  assert(s.totals.count > 0 && s.totals.copied === 0 && !s.safeToFormat);

  // Scanning twice must not duplicate rows.
  const again = await scanCard(db, drive, job);
  assert.deepStrictEqual(again.presentIds.slice().sort(), presentIds.slice().sort());

  const date = s.groups[0].key;
  const dest = path.join(work, 'main');
  const backup = path.join(work, 'backup');
  t = Date.now();
  const r1 = await runImport(db, { cardId, letter: drive.letter, dates: [date], shoot: 'Smoke: Test?', dest, backup, maxFiles }, job, () => {});
  console.log('import 1:', JSON.stringify(r1), `${Date.now() - t} ms`);
  assert.strictEqual(r1.failed, 0);
  assert(r1.copied > 0);

  // Independently re-hash every recorded copy against the card file.
  const rows = db.prepare('SELECT f.rel_path, f.sha256, l.path, l.kind FROM locations l JOIN files f ON f.id = l.file_id').all();
  assert.strictEqual(rows.length, r1.copied * 2);
  for (const row of rows) {
    const cardSha = await hashFile(path.join(`${drive.letter}\\`, row.rel_path));
    assert.strictEqual(cardSha, row.sha256, 'card hash');
    assert.strictEqual(await hashFile(row.path), row.sha256, `copy hash ${row.path}`);
  }
  console.log(`verified ${rows.length} copies; folder: ${path.basename(path.dirname(rows[0].path))}`);
  assert(!fs.readdirSync(path.dirname(rows[0].path)).some((n) => n.endsWith('.cardmap-part')));

  // Second run copies nothing.
  const r2 = await runImport(db, { cardId, letter: drive.letter, dates: [date], shoot: 'Smoke: Test?', dest, backup, maxFiles }, job, () => {});
  console.log('import 2:', JSON.stringify(r2));
  assert.strictEqual(r2.copied, 0);
  assert.strictEqual(r2.skipped, r1.copied);

  // Delete one main copy: the import must notice and restore it.
  fs.unlinkSync(rows.find((x) => x.kind === 'primary').path);
  const r3 = await runImport(db, { cardId, letter: drive.letter, dates: [date], shoot: 'Smoke: Test?', dest, backup, maxFiles }, job, () => {});
  console.log('import 3 (after deleting one copy):', JSON.stringify(r3));
  assert.strictEqual(r3.copied, 1);

  // A corrupted copy with the right name and size must not be accepted.
  const victim = rows.find((x) => x.kind === 'backup').path;
  const fd = fs.openSync(victim, 'r+');
  fs.writeSync(fd, Buffer.from('corrupt!'), 0, 8, 1024);
  fs.closeSync(fd);
  db.prepare('DELETE FROM locations WHERE path = ?').run(victim);
  const r4 = await runImport(db, { cardId, letter: drive.letter, dates: [date], shoot: 'Smoke: Test?', dest, backup, maxFiles }, job, () => {});
  console.log('import 4 (corrupted backup):', JSON.stringify(r4), fs.readdirSync(path.dirname(victim)).join(', '));
  assert.strictEqual(r4.copied, 1);

  // Move the main folder: folder scan should find the files again.
  const moved = path.join(work, 'moved');
  fs.renameSync(dest, moved);
  const fsr = await runFolderScan(db, { folder: moved, mounted: { [drive.serial]: drive.letter } }, job, () => {});
  console.log('folder scan after move:', JSON.stringify(fsr));
  assert.strictEqual(fsr.matched, r1.copied);

  s = cardSummary(db, cardId, presentIds);
  console.log('summary after import:', JSON.stringify(s.totals), 'safeToFormat:', s.safeToFormat);
  assert.strictEqual(s.totals.safe, r1.copied);

  const roots = findOriginalsRoots('');
  console.log('lightroom originals:', roots.join(' | ') || '(none)');
  if (roots.length) {
    t = Date.now();
    const lr = await runLightroomCheck(db, { cardId, letter: drive.letter, roots, maxFiles: Number(process.argv[5] || 40) }, job, () => {});
    console.log('lightroom check:', JSON.stringify(lr), `${Date.now() - t} ms`);
  }

  // Library index: list a folder, save checksums, then match by lookup with nothing read.
  {
    const lib = path.join(work, 'backup');
    const inv1 = await inventory(db, [lib, path.join(work, 'nope')], job, () => {});
    console.log('index inventory:', JSON.stringify(inv1));
    assert(inv1.files >= 3 && inv1.skippedFolders.length === 1);
    const st1 = indexStatus(db, [{ path: lib, exists: true }]);
    const h1 = await hashPending(db, { shouldPause: () => false }, job, () => {});
    const st2 = indexStatus(db, [{ path: lib, exists: true }]);
    console.log('index hashing:', JSON.stringify(h1), `| indexed ${st1.hashed} -> ${st2.hashed} of ${st2.files}, folder ${st2.folders[0].files} files`);
    assert.strictEqual(st2.hashed, st2.files);
    assert.strictEqual(st2.folders[0].hashedBytes, st2.folders[0].bytes);
    // Everything is indexed now, so a second pass has nothing to read...
    assert.strictEqual((await hashPending(db, {}, job, () => {})).total, 0);
    // ...and matching is pure lookup.
    const m1 = await matchCards(db, { cardId, mounted: {} }, job, () => {});
    console.log('index match (card not needed):', JSON.stringify(m1));
    assert.strictEqual(m1.read, 0);
    assert(m1.lookups >= 3 && m1.filesWithCopies >= 3);
    // A changed file loses its checksum and is read again; a deleted one leaves the index.
    const victim2 = fs.readdirSync(path.join(lib, fs.readdirSync(lib)[0])).map((n) => path.join(lib, fs.readdirSync(lib)[0], n)).find((p) => p.endsWith('.JPG'));
    fs.appendFileSync(victim2, 'x');
    const inv2 = await inventory(db, [lib], job, () => {});
    assert.strictEqual(inv2.changed, 1);
    fs.unlinkSync(victim2);
    const inv3 = await inventory(db, [lib], job, () => {});
    assert.strictEqual(inv3.removed, 1);
    console.log(`index upkeep: changed file re-queued (${inv2.changed}), deleted file dropped (${inv3.removed})`);
  }

  // Drive letters: a location is tied to its drive's serial, not its letter.
  {
    const work2 = path.join(work, 'letters');
    const real = path.parse(path.resolve(work)).root.slice(0, 2).toUpperCase(); // e.g. "C:"
    const SERIAL = 'TESTVOL1';
    setVolumes([{ letter: real, serial: SERIAL, label: 'Test drive' }]);
    assert.strictEqual(syncDb(db, [{ letter: real, serial: SERIAL, label: 'Test drive' }]), 0);
    const r6 = await runImport(db, { cardId, letter: drive.letter, dates: [date], shoot: '', dest: work2, maxFiles: 1 }, job, () => {});
    assert.strictEqual(r6.copied, 1);
    const loc = db.prepare('SELECT * FROM locations WHERE path LIKE ?').get(`${work2}%`);
    assert.strictEqual(loc.vol, SERIAL);
    assert(loc.rel.startsWith('\\'));
    const tied = db.prepare('SELECT count(*) n FROM locations WHERE vol = ?').get(SERIAL).n;
    console.log(`drive letters: new copy tied to ${SERIAL}, ${tied} locations on that drive (older ones backfilled)`);

    // The drive is unplugged: its copies are "not connected", not "missing", and the import knows it needs redoing.
    setVolumes([]);
    let f1 = listFiles(db, { cardId, date }).find((f) => f.id === loc.file_id);
    let l1 = f1.locations.find((l) => l.path === loc.path);
    assert(l1.offline && !l1.exists && /Test drive/.test(l1.drive));

    // The drive comes back as Q: (which does not exist here): every path is re-lettered.
    const moved = [{ letter: 'Q:', serial: SERIAL, label: 'Test drive' }];
    setVolumes(moved);
    const n = syncDb(db, moved);
    assert.strictEqual(n, tied);
    assert(db.prepare('SELECT path FROM locations WHERE id = ?').get(loc.id).path.startsWith('Q:\\'));
    // Another drive now has the old letter: the old path must not be mistaken for the copy.
    setVolumes([{ letter: real, serial: 'OTHERVOL', label: 'Someone else' }]);
    f1 = listFiles(db, { cardId, date }).find((f) => f.id === loc.file_id);
    assert(f1.locations.every((l) => l.vol !== SERIAL || (l.offline && !l.exists)));

    // And back to the real letter: paths return and the files are found again.
    const back = [{ letter: real, serial: SERIAL, label: 'Test drive' }];
    setVolumes(back);
    assert.strictEqual(syncDb(db, back), tied);
    f1 = listFiles(db, { cardId, date }).find((f) => f.id === loc.file_id);
    l1 = f1.locations.find((l) => l.path === loc.path);
    assert(l1 && l1.exists && !l1.offline);
    console.log(`drive letters: ${n} paths re-lettered to Q: and back; unplugged and swapped-letter cases handled`);
    setVolumes([]);
  }

  const map = overview(db, '');
  const withPlaces = map.filter((m) => m.places.length);
  console.log(`map: ${map.length} rows, ${withPlaces.length} with places`);
  for (const m of withPlaces.slice(0, 4)) {
    console.log(' ', m.date, m.shoots.join(','), m.places.map((p) => `${p.kind}:${p.dir} x${p.count}${p.exists ? '' : ' MISSING'}`).join(' ; '));
  }
  // Drill-down: by date, by card folder, and by a folder on disk.
  const byDate = listFiles(db, { cardId, date });
  const byFolder = listFiles(db, { cardId, folder: s.folders[0].key });
  const byDir = listFiles(db, { dir: path.join(moved, fs.readdirSync(moved)[0]) });
  console.log(`files: ${byDate.length} on ${date}, ${byFolder.length} in ${s.folders[0].key}, ${byDir.length} in moved folder`);
  console.log('  e.g.', byDir[0].name, byDir[0].folder, byDir[0].sha256.slice(0, 12), byDir[0].locations.map((l) => `${l.kind}${l.exists ? '' : ' MISSING'}`).join(','));
  assert.strictEqual(byDate.length, s.groups[0].count);
  assert.strictEqual(byFolder.length, s.folders[0].count);
  assert.strictEqual(byDir.length, r1.copied);
  // Importing by card folder instead of by date.
  const r5 = await runImport(db, { cardId, letter: drive.letter, folders: [byDate[0].folder], shoot: '', dest: path.join(work, 'byfolder'), maxFiles: 1 }, job, () => {});
  console.log('import by folder:', JSON.stringify(r5));
  assert.strictEqual(r5.copied + r5.skipped, 1);
  assert(overview(db, 'Smoke').length >= 1);
  assert.strictEqual(overview(db, 'zzz-no-such-thing').length, 0);
  console.log('ALL OK');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
