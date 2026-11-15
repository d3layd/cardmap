// Where each project's files went. A project is an org (who the work is for) plus a project
// (shoot) name. Imports record their profile and project; a profile names its org. This
// rolls their verified copies up to one row per import, kind of copy and folder, and sums
// each planned project.
const path = require('node:path');

/**
 * projects: the planned list [{ org, name, date, note }]. orgOf(profile): the org an import
 * profile belongs to.
 * Returns {
 *   log: [{ at, importId, org, project, card, kind, folder, files, bytes }],
 *   projects: [{ org, name, date, note, planned, files, bytes, folders, lastAt, waiting }],
 * }
 */
function projectLog(db, projects = [], orgOf = (p) => p || '') {
  const rows = db
    .prepare(
      `SELECT i.id AS importId, i.started AS at, i.profile AS org, i.shoot AS project,
              COALESCE(NULLIF(c.nickname, ''), c.label) AS card, l.kind, l.path, f.size
       FROM imports i
       JOIN locations l ON l.import_id = i.id AND l.verified = 1
       JOIN files f ON f.id = l.file_id
       LEFT JOIN cards c ON c.id = i.card_id`
    )
    .all();

  // One row per import, kind of copy and folder.
  const byKey = new Map();
  for (const r of rows) {
    const folder = path.dirname(r.path);
    const key = `${r.importId}|${r.kind}|${folder.toLowerCase()}`;
    const e = byKey.get(key) || { at: r.at, importId: r.importId, org: orgOf(r.org), project: r.project || '', card: r.card || '', kind: r.kind, folder, files: 0, bytes: 0 };
    e.files += 1;
    e.bytes += r.size || 0;
    byKey.set(key, e);
  }
  const log = [...byKey.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.folder.localeCompare(b.folder)));

  // Files put in a group on a card but not imported yet, per project.
  const waiting = new Map();
  for (const w of db.prepare("SELECT grp AS profile, grp_shoot AS project, count(*) AS n FROM files WHERE grp IS NOT NULL AND coalesce(mark, '') != 'skip' GROUP BY grp, grp_shoot").all()) {
    const key = `${orgOf(w.profile)}|${w.project || ''}`.toLowerCase();
    waiting.set(key, (waiting.get(key) || 0) + w.n);
  }

  // Totals per project: the planned ones, plus any project seen in the log or in a group.
  const proj = new Map();
  const get = (org, name) => {
    const key = `${org}|${name}`.toLowerCase();
    if (!proj.has(key)) proj.set(key, { org, name, date: '', note: '', planned: false, files: 0, bytes: 0, folders: new Set(), lastAt: '', waiting: waiting.get(key) || 0 });
    return proj.get(key);
  };
  for (const p of projects) Object.assign(get(p.org, p.name), { date: p.date || '', note: p.note || '', planned: true });
  for (const e of log) {
    if (!e.org && !e.project) continue;
    const p = get(e.org, e.project);
    // Count each file once per project: the main copy (or the extra copy for profiles without one).
    if (e.kind === 'primary' || e.kind === 'extra') {
      p.files += e.files;
      p.bytes += e.bytes;
    }
    p.folders.add(e.folder);
    if (e.at > p.lastAt) p.lastAt = e.at;
  }
  for (const key of waiting.keys()) {
    const [org, name] = key.split('|');
    if (!proj.has(key)) get(org, name);
  }
  return {
    log,
    projects: [...proj.values()]
      .map((p) => ({ ...p, folders: p.folders.size }))
      .sort((a, b) => a.org.localeCompare(b.org) || (b.date || b.lastAt).localeCompare(a.date || a.lastAt) || a.name.localeCompare(b.name)),
  };
}

module.exports = { projectLog };
