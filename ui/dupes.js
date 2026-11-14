// The Duplicates page: where the same file is stored more than once, and which extra
// copies are safe to delete. CardMap never deletes anything; it makes a list.
// Uses globals from app.js (h, api, state, grid, bytes, run, renderMain, resultNotice).

async function loadDupes(autoBuild) {
  state.dupes = await api.invoke('dupes:get');
  if (autoBuild && !state.dupes.report && !busy()) run('dupes:build');
  if (state.view === 'dupes') renderMain();
}

const readDate = (s) => (s ? s.slice(0, 10) : 'first indexing');
const oldestRead = (list) => list.map((c) => c.hashedAt || '').sort()[0] || '';

function pathCell(p, note) {
  return h('div', { class: 'place' },
    h('button', { class: 'link dir', title: 'Open the folder', onclick: () => api.invoke('reveal', p.slice(0, p.lastIndexOf('\\'))) }, p),
    note ? h('span', { class: 'n' }, note) : null);
}
const keptCell = (keep) => keep.map((k) => pathCell(k.path, k.project ? 'next to a project file' : ''));
const keptText = (keep) => keep.map((k) => k.path + (k.project ? ' (next to a project file)' : '')).join('; ');

/** One row per copy that could go, with the copies that stay. */
function copyRows(files, field) {
  const rows = [];
  for (const f of files) {
    for (const c of f[field]) {
      rows.push({ path: c.path, size: f.size, keep: f.keep, lr: f.inLightroom, sha: f.sha256, read: oldestRead([c, ...f.keep]), folders: f.folders });
    }
  }
  return rows;
}

function copyGrid(id, rows, deleteLabel, opts) {
  return grid(id, [
    { label: deleteLabel, value: (r) => r.path, cell: (r) => pathCell(r.path) },
    { label: 'Size', num: true, value: (r) => r.size, cell: (r) => bytes(r.size) },
    { label: 'Copies that stay', value: (r) => r.keep.length, text: (r) => keptText(r.keep), cell: (r) => keptCell(r.keep) },
    { label: 'In Lightroom', value: (r) => (r.lr ? 'Yes' : 'No'), cell: (r) => (r.lr ? 'Yes' : h('span', { class: 'none' }, 'No')) },
    { label: 'Checksum read', cls: 'date', value: (r) => r.read, text: (r) => readDate(r.read), cell: (r) => readDate(r.read) },
    { label: 'Checksum', csv: true, sort: false, value: (r) => r.sha, cell: (r) => h('code', { title: `SHA-256: ${r.sha}` }, r.sha.slice(0, 12)) },
  ], rows, {
    sort: { col: 1, dir: -1 },
    ...opts,
    tools: h('button', { class: 'btn', disabled: busy() || !rows.length, title: 'Read every copy of the files shown again, and check they still match',
      onclick: () => {
        const shown = gridVisible(id, rows);
        run('dupes:recheck', [...new Set(shown.map((r) => r.sha))]);
      } }, 'Re-check the files shown'),
  });
}

function dupesView() {
  const D = state.dupes;
  if (!D) return [h('h1', {}, 'Duplicates'), h('p', { class: 'lede' }, 'Loading')];
  const r = D.report;
  const st = D.settings;
  const tab = state.dupeTab || 'safe';
  const setTab = (t) => { state.dupeTab = t; renderMain(); };
  const rebuild = () => run('dupes:build');

  const intro = [
    h('h1', {}, 'Duplicates'),
    h('p', { class: 'lede' }, 'Files in your library index that are stored in more than one place, matched by checksum. CardMap never deletes anything: it makes a list you can export and act on yourself.'),
    resultNotice(),
  ];
  if (!r) {
    return [...intro, h('div', { class: 'card-box' },
      h('div', {}, busy() ? 'Building the report.' : 'No report yet.'),
      h('div', { class: 'row actions' }, h('button', { class: 'btn primary', disabled: busy(), onclick: rebuild }, 'Build the report')))];
  }
  const T = r.totals;
  const safeRows = copyRows(r.files, 'remove');
  const diskRows = copyRows(r.files, 'extras');
  const needed = r.files.filter((f) => f.status === 'needed');
  const unchecked = r.files.filter((f) => f.status === 'unchecked' || f.problems.length);
  const virtuals = r.disks.filter((d) => d.virtualOf);

  // ----- drive order -----
  const move = async (i, by) => {
    const order = st.order.map((o) => o.serial);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    state.dupes.settings = await api.invoke('dupes:settings', { order });
    rebuild();
  };

  const summary = h('div', { class: 'card-box' },
    h('div', {}, h('strong', {}, `${T.groups.toLocaleString()} files have more than one copy`), `, using ${bytes(T.extraBytes)} of extra space.`),
    h('ul', { class: 'tally' },
      h('li', {}, h('strong', { class: 'ok' }, `Safe to delete: ${T.safeFiles.toLocaleString()} copies, ${bytes(T.safeBytes)}. `), 'Each file stays in at least two places.'),
      h('li', {}, h('strong', {}, `Extra copies on one disk: ${T.oneDiskFiles.toLocaleString()} copies, ${bytes(T.oneDiskBytes)}. `),
        'These files are only on one disk. Deleting the extras keeps one copy there: no worse than today if that disk fails, but there is still no backup.'),
      h('li', {}, h('strong', {}, `Backups to keep: ${T.neededGroups.toLocaleString()} files, ${bytes(T.neededBytes)}. `),
        'One copy on each of two disks (or one disk and Lightroom). Deleting either would leave a single copy.'),
      T.uncheckedGroups ? h('li', {}, h('strong', { class: 'part' }, `Not checked: ${T.uncheckedGroups.toLocaleString()} files. `), 'A copy is on a drive that is not connected, or changed since it was indexed.') : null),
    h('div', { class: 'hint' }, `Built ${dateTime(Date.parse(r.builtAt))} from the library index. Files not indexed yet are not included.`),
    h('div', { class: 'row actions' }, h('button', { class: 'btn', disabled: busy(), onclick: rebuild }, 'Rebuild the report')));

  const rules = h('details', { class: 'rules', open: state.dupeRulesOpen, ontoggle: (e) => { state.dupeRulesOpen = e.target.open; } },
    h('summary', {}, 'How copies are chosen', h('span', { class: 'none' }, ` keep order ${st.order.map((o) => o.letter).join(' > ')}${st.countLightroom ? ', Lightroom counts' : ''}`)),
    h('h3', {}, 'A copy is safe to delete only if'),
    h('ul', { class: 'steps' },
      h('li', {}, 'the file, matched by checksum, stays in at least two places on different physical disks;'),
      h('li', {}, 'every copy is on a connected drive and has not changed since its checksum was read;'),
      h('li', {}, 'it is not inside a folder (or under a folder) holding a Premiere, After Effects, DaVinci or Vegas project, since deleting it could break that project.')),
    virtuals.length ? h('p', { class: 'hint' }, virtuals.map((v) => `${v.letter} is a virtual disk stored as a file on ${v.virtualOf}, so the two count as one disk.`).join(' ')) : null,
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: st.countLightroom, disabled: busy(), onchange: async (e) => {
        state.dupes.settings = await api.invoke('dupes:settings', { countLightroom: e.target.checked });
        rebuild();
      } }),
      'Count Lightroom\'s cloud copy as one of the two places'),
    h('h3', {}, 'Which drive keeps its copy first'),
    h('p', { class: 'hint' }, 'The first drive keeps its copy, then the next, until the file is in two places. On the same disk, a copy next to a project file is kept first, and one in a folder like "New folder", "Downloads" or "Dump" goes first.'),
    h('table', { class: 'compact' }, h('tbody', {}, st.order.map((o, i) => h('tr', {},
      h('td', {}, `${i + 1}.`), h('td', {}, h('strong', {}, o.letter), ` ${o.label || ''}`, o.connected ? '' : h('span', { class: 'offline' }, ' (not connected)')),
      h('td', {},
        h('button', { class: 'link', disabled: busy() || i === 0, 'aria-label': `Move ${o.letter} up`, onclick: () => move(i, -1) }, 'Up'), ' ',
        h('button', { class: 'link', disabled: busy() || i === st.order.length - 1, 'aria-label': `Move ${o.letter} down`, onclick: () => move(i, 1) }, 'Down')))))));

  const tabs = h('div', { class: 'seg tabs', role: 'tablist' }, [
    ['safe', `Safe to delete (${safeRows.length.toLocaleString()})`],
    ['onedisk', `Extra copies on one disk (${diskRows.length.toLocaleString()})`],
    ['needed', `Backups to keep (${needed.length.toLocaleString()})`],
    ['folders', `By folder (${r.pairs.length.toLocaleString()})`],
    ...(unchecked.length ? [['unchecked', `Not checked (${unchecked.length.toLocaleString()})`]] : []),
  ].map(([k, label]) => h('button', { class: `btn${tab === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(tab === k), onclick: () => setTab(k) }, label)));

  const focusFolder = (folder) => {
    for (const id of ['dupe-safe', 'dupe-onedisk', 'dupe-needed']) gridState[id] = { ...(gridState[id] || {}), q: folder };
    setTab('safe');
  };

  let body;
  if (tab === 'safe') {
    body = [h('p', { class: 'hint' }, 'Export this list to keep a record, then delete the files yourself. Re-check first if the index is old.'),
      copyGrid('dupe-safe', safeRows, 'Safe to delete', { name: 'Safe to delete', empty: 'Nothing is safe to delete under these rules.' })];
  } else if (tab === 'onedisk') {
    body = [h('p', { class: 'hint' }, 'Each file here is only on one disk. Deleting these extras leaves one copy on it.'),
      copyGrid('dupe-onedisk', diskRows, 'Extra copy', { name: 'Extra copies on one disk', empty: 'None.' })];
  } else if (tab === 'needed') {
    body = [grid('dupe-needed', [
      { label: 'File', value: (f) => f.keep[0] && f.keep[0].path.split('\\').pop(), cell: (f) => (f.keep[0] ? f.keep[0].path.split('\\').pop() : '') },
      { label: 'Size', num: true, value: (f) => f.size, cell: (f) => bytes(f.size) },
      { label: 'Copies', value: (f) => f.keep.length, text: (f) => keptText(f.keep), cell: (f) => keptCell(f.keep) },
      { label: 'In Lightroom', value: (f) => (f.inLightroom ? 'Yes' : 'No'), cell: (f) => (f.inLightroom ? 'Yes' : h('span', { class: 'none' }, 'No')) },
    ], needed, { name: 'Backups to keep', sort: { col: 1, dir: -1 }, empty: 'None.' })];
  } else if (tab === 'folders') {
    body = [h('p', { class: 'hint' }, 'Folders holding the same files. Click a row to see its files in the other lists.'),
      grid('dupe-folders', [
        { label: 'Folders', value: (p) => p.folders.join(' | '), text: (p) => p.folders.join(' | '),
          cell: (p) => h('button', { class: 'link', title: 'Show these files', onclick: () => focusFolder(p.folders[0]) }, p.folders.map((x) => h('div', {}, x))) },
        { label: 'Files', num: true, value: (p) => p.files, cell: (p) => p.files.toLocaleString() },
        { label: 'Extra space', num: true, value: (p) => p.extraBytes, cell: (p) => bytes(p.extraBytes) },
        { label: 'Safe to delete', num: true, value: (p) => p.safeBytes, cell: (p) => (p.safeBytes ? h('span', { class: 'ok' }, bytes(p.safeBytes)) : '') },
        { label: 'One-disk extras', num: true, value: (p) => p.oneDiskBytes, cell: (p) => (p.oneDiskBytes ? bytes(p.oneDiskBytes) : '') },
        { label: 'Backups to keep', num: true, value: (p) => p.neededBytes, cell: (p) => (p.neededBytes ? bytes(p.neededBytes) : '') },
      ], r.pairs, { name: 'Duplicates by folder', sort: { col: 2, dir: -1 } })];
  } else {
    const rows = [];
    for (const f of unchecked) for (const p of f.problems) rows.push({ path: p.path, why: p.why, size: f.size });
    body = [grid('dupe-unchecked', [
      { label: 'Copy', value: (x) => x.path, cell: (x) => x.path },
      { label: 'Size', num: true, value: (x) => x.size, cell: (x) => bytes(x.size) },
      { label: 'Why it was not checked', cell: (x) => x.why },
    ], rows, { name: 'Not checked' })];
  }

  return [...intro, summary, rules, tabs, ...body];
}
