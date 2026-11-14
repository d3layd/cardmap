// The Drives page: for each drive, what is on it that exists nowhere else, by folder.
// Read-only: CardMap never deletes anything; this is a list.
// Uses globals from app.js and grid.js (h, api, state, grid, gridState, bytes, renderMain).

async function loadReconcile(vol) {
  const prev = state.reconcile || {};
  const want = vol === undefined ? prev.vol || null : vol;
  state.reconcile = { ...prev, vol: want, loading: true, error: null };
  if (state.view === 'reconcile') renderMain();
  try {
    const data = await api.invoke('reconcile:get', { vol: want });
    // A newer click may have asked for another drive while this one was loading.
    if (state.reconcile.vol !== want) return;
    state.reconcile = { vol: want, data, loading: false, error: null };
  } catch (e) {
    state.reconcile = { ...state.reconcile, loading: false, error: e.message };
  }
  if (state.view === 'reconcile') renderMain();
}

const RECONCILE_STATUS = {
  backed: ['Backed up', 'ok'],
  partly: ['Partly backed up', 'part'],
  only: ['Only here', 'bad'],
};

function reconcileView() {
  const R = state.reconcile;
  const intro = [
    h('h1', {}, 'Drives'),
    h('p', { class: 'lede' }, 'What is on each drive that exists nowhere else: not on another physical disk in your library index, matched by checksum. Copies on the same disk do not count as a backup.'),
  ];
  if (!R || (!R.data && !R.error)) {
    if (!R) loadReconcile();
    return [...intro, h('p', { class: 'hint' }, 'Loading')];
  }
  if (R.error && !R.data) return [...intro, h('div', { class: 'notice bad' }, R.error)];
  const D = R.data;
  const pick = (vol) => {
    if (vol === R.vol) return;
    for (const id of ['reconcile-folders', 'reconcile-files']) delete gridState[id];
    loadReconcile(vol);
  };

  const drives = h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, ['Drive', 'Files', 'Size', 'Only here', 'Only here size', 'No checksum yet'].map((t) => h('th', {}, t)))),
    h('tbody', {}, D.drives.map((d) => h('tr', { class: d.vol === R.vol ? 'on' : null },
      h('td', {}, h('button', { class: 'link', 'aria-pressed': String(d.vol === R.vol), title: 'Show this drive', onclick: () => pick(d.vol) },
        h('strong', {}, d.letter || 'Not connected'), d.label ? ` ${d.label}` : '')),
      h('td', { class: 'num' }, d.files.toLocaleString()),
      h('td', { class: 'num' }, bytes(d.bytes)),
      h('td', { class: 'num' }, d.onlyHereFiles ? h('span', { class: 'part' }, d.onlyHereFiles.toLocaleString()) : h('span', { class: 'ok' }, '0')),
      h('td', { class: 'num' }, d.onlyHereFiles ? bytes(d.onlyHereBytes) : ''),
      h('td', { class: 'num' }, d.unhashedFiles ? d.unhashedFiles.toLocaleString() : '')))));

  const out = [...intro, R.error ? h('div', { class: 'notice bad' }, R.error) : null,
    D.drives.length ? drives : h('p', { class: 'hint' }, 'The library index is empty.')];
  if (!R.vol || !D.folders) {
    if (D.drives.length) out.push(h('p', { class: 'hint' }, R.loading ? 'Loading' : 'Click a drive to see its folders.'));
    return out;
  }

  const sel = D.drives.find((d) => d.vol === R.vol) || { letter: '', label: '' };
  if (sel.onlyHereFiles) {
    out.push(h('div', { class: 'row actions' },
      h('button', { class: 'btn primary', 'aria-expanded': String(Boolean(state.copyPlanOpen)), onclick: () => { state.copyPlanOpen = !state.copyPlanOpen; renderMain(); } },
        'Make second copies of the files only here')));
  }
  const name = `${sel.letter || 'Drive'}${sel.label ? ` ${sel.label}` : ''}`;
  const showFolder = (folder) => {
    gridState['reconcile-files'] = { ...(gridState['reconcile-files'] || {}), q: `${folder}\\` };
    renderMain();
  };
  const statusCell = (f) => {
    const [text, cls] = RECONCILE_STATUS[f.status] || [f.status, 'none'];
    return h('span', { class: cls }, text);
  };

  out.push(
    h('h2', {}, `${name}: folders`),
    h('p', { class: 'hint' }, R.loading ? 'Loading' : 'Click a folder to filter the file list below to it.'),
    grid('reconcile-folders', [
      { label: 'Folder', value: (f) => f.folder, cell: (f) => (f.onlyHere ? h('button', { class: 'link', title: 'Show its only-here files', onclick: () => showFolder(f.folder) }, f.folder) : f.folder) },
      { label: 'Status', value: (f) => (RECONCILE_STATUS[f.status] || [f.status])[0], cell: statusCell },
      { label: 'Files', num: true, value: (f) => f.files, cell: (f) => f.files.toLocaleString() },
      { label: 'Size', num: true, value: (f) => f.bytes, cell: (f) => bytes(f.bytes) },
      { label: 'Only here', num: true, value: (f) => f.onlyHere, cell: (f) => (f.onlyHere ? f.onlyHere.toLocaleString() : '') },
      { label: 'Only here size', num: true, value: (f) => f.onlyHereBytes, cell: (f) => (f.onlyHereBytes ? bytes(f.onlyHereBytes) : '') },
      { label: 'No checksum yet', num: true, value: (f) => f.unhashed || 0, cell: (f) => (f.unhashed ? f.unhashed.toLocaleString() : '') },
    ], D.folders, { name: `Folders on ${name}`, sort: { col: 5, dir: -1 }, empty: 'No folders indexed on this drive.' }),
    h('h2', {}, `${name}: files that are only here`),
    D.truncated ? h('p', { class: 'hint' }, `Showing the largest ${D.files.length.toLocaleString()} of ${(D.onlyHereTotal || D.files.length).toLocaleString()} files.`) : null,
    grid('reconcile-files', [
      { label: 'File', value: (x) => x.path, cell: (x) => h('button', { class: 'link dir', title: 'Open the folder', onclick: () => api.invoke('reveal', x.path.slice(0, x.path.lastIndexOf('\\'))) }, x.path) },
      { label: 'Size', num: true, value: (x) => x.size, cell: (x) => bytes(x.size) },
      { label: 'Checksum', sort: false, value: (x) => x.sha256, cell: (x) => h('code', { title: `SHA-256: ${x.sha256}` }, x.sha256.slice(0, 12)) },
    ], D.files, { name: `Only on ${name}`, sort: { col: 1, dir: -1 }, empty: 'Every checked file on this drive has a copy somewhere else.' }));
  return out;
}
