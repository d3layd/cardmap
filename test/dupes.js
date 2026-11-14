// The safe-to-delete rule. No drives needed: run with `npm run test:rules`.
const assert = require('node:assert');
const { decide } = require('../core/dupes');

const c = (path, vol, phys, extra = {}) => ({ path, vol, phys, ok: true, protected: false, ...extra });
const opts = (o = {}) => ({ priority: { J: 0, E: 1, Z: 2 }, countLightroom: true, inLightroom: false, ...o });
const paths = (list) => list.map((x) => x.path).sort();

// One copy on each of two disks: both are needed, nothing to delete.
let d = decide([c('J:\\a.nef', 'J', 'disk1'), c('E:\\a.nef', 'E', 'disk2')], opts());
assert.strictEqual(d.status, 'needed');
assert.deepStrictEqual(d.remove, []);

// A third copy on a third disk can go; the two best drives keep theirs.
d = decide([c('Z:\\a.nef', 'Z', 'disk3'), c('J:\\a.nef', 'J', 'disk1'), c('E:\\a.nef', 'E', 'disk2')], opts());
assert.strictEqual(d.status, 'safe');
assert.deepStrictEqual(paths(d.remove), ['Z:\\a.nef']);

// Z: is a virtual disk stored on D:: a copy on each is ONE disk, so neither can go.
d = decide([c('Z:\\a.nef', 'Z', 'diskD'), c('D:\\a.nef', 'D', 'diskD')], opts());
assert.strictEqual(d.status, 'onedisk');
assert.deepStrictEqual(d.remove, []);
assert.strictEqual(d.extras.length, 1);

// Two copies on one disk, also in Lightroom (counted): one local copy + Lightroom = two places.
d = decide([c('J:\\x\\a.nef', 'J', 'disk1'), c('J:\\y\\a.nef', 'J', 'disk1')], opts({ inLightroom: true }));
assert.strictEqual(d.status, 'safe');
assert.strictEqual(d.remove.length, 1);
// ...but not when Lightroom is not counted.
d = decide([c('J:\\x\\a.nef', 'J', 'disk1'), c('J:\\y\\a.nef', 'J', 'disk1')], opts({ inLightroom: true, countLightroom: false }));
assert.strictEqual(d.status, 'onedisk');
assert.deepStrictEqual(d.remove, []);

// On one disk, a copy in a dump folder goes before an organised one.
d = decide([c('J:\\New folder (2)\\a.nef', 'J', 'disk1'), c('J:\\Projects\\Shoot\\a.nef', 'J', 'disk1'), c('E:\\a.nef', 'E', 'disk2')], opts());
assert.deepStrictEqual(paths(d.remove), ['J:\\New folder (2)\\a.nef']);

// A copy next to a project file is never removed, even when it would otherwise go.
d = decide([c('J:\\a.nef', 'J', 'disk1'), c('E:\\a.nef', 'E', 'disk2'), c('Z:\\Edit\\a.nef', 'Z', 'disk3', { protected: true })], opts());
assert.deepStrictEqual(d.remove, []);
// ...and it is preferred as its disk's keeper, so a plain copy on the same disk can go.
d = decide([c('J:\\Dump\\a.nef', 'J', 'disk1'), c('J:\\Edit\\a.nef', 'J', 'disk1', { protected: true }), c('E:\\a.nef', 'E', 'disk2')], opts());
assert.deepStrictEqual(paths(d.remove), ['J:\\Dump\\a.nef']);

// A copy that changed, or whose drive is away, is never removed and never counted as kept.
d = decide([c('J:\\a.nef', 'J', 'disk1'), c('E:\\a.nef', 'E', 'disk2', { ok: false }), c('Z:\\a.nef', 'Z', 'disk3')], opts());
assert.deepStrictEqual(paths(d.keep), ['J:\\a.nef', 'Z:\\a.nef']);
assert.deepStrictEqual(d.remove, []);
d = decide([c('J:\\a.nef', 'J', 'disk1'), c('E:\\a.nef', 'E', 'disk2', { ok: false })], opts());
assert.strictEqual(d.status, 'unchecked');
assert.deepStrictEqual(d.remove, []);

console.log('safe-to-delete rule: all cases OK');
