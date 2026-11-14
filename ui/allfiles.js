// The "All files" page: one row per unique file (by checksum) across your drives, cards
// and Lightroom, with how many copies there are and whether Lightroom has it.
// Uses globals from app.js (h, api, state, grid, csvOf, bytes, renderMain, show, runLookup).

const FILE_TABS = [
  ['all', 'All'],
  ['both', 'On a drive and in Lightroom'],
  ['lronly', 'Only in Lightroom'],
  ['localonly', 'Not in Lightroom'],
  ['dupes', 'More than one copy'],
  ['single', 'Only one copy on a drive'],
  ['cardonly', 'Only on a card'],
];

const FILE_TAB_HINT = {
  all: 'Every file CardMap knows by checksum, once each.',
  both: 'Stored on at least one of your drives and also in Lightroom.',
  lronly: 'In Lightroom with no copy on any indexed drive. If these were removed from Lightroom, they would be gone unless they are on a drive CardMap has not indexed.',
  localonly: 'On your drives but not in Lightroom.',
  dupes: 'Stored more than once on your drives. See Duplicates for which copies are safe to delete.',
  single: 'Exactly one copy on your drives. Lightroom may hold another.',
  cardonly: 'Read from a card and not found on any drive or in Lightroom. Copy these before formatting.',
};

async function loadAllFiles() {
  const A = state.allFiles || (state.allFiles = { show: 'lronly', q: '' });
  const seq = (A.seq = (A.seq || 0) + 1);
  const res = await api.invoke('filemap', { show: A.show, q: A.q });
  if (seq !== A.seq) return;
  A.res = res;
  if (state.view === 'allfiles') renderMain();
}

function lrCell(r) {
  if (!r.lr) return h('span', { class: 'none' }, 'No');
  const bits = [r.edited ? 'edited' : null, r.uploaded ? null : 'not uploaded yet'].filter(Boolean);
  return bits.length ? `Yes (${bits.join(', ')})` : 'Yes';
}

const ALL_FILE_COLUMNS = [
  { label: 'File', value: (r) => r.name || '', cell: (r) => h('button', { class: 'link', title: 'See every place this file is',
    onclick: () => { state.lookup = { q: r.sha256, res: null }; show('lookup'); runLookup(); } }, r.name || r.sha256.slice(0, 12)) },
  { label: 'Date', cls: 'date', value: (r) => r.date || '', cell: (r) => r.date || '' },
  { label: 'Size', num: true, value: (r) => r.size || 0, cell: (r) => bytes(r.size || 0) },
  { label: 'Copies on drives', num: true, value: (r) => r.local, cell: (r) => (r.local ? r.local.toLocaleString() : h('span', { class: 'none' }, '0')) },
  { label: 'Drives', value: (r) => r.drives, cell: (r) => r.drives },
  { label: 'On cards', num: true, value: (r) => r.cards, cell: (r) => r.cards || '' },
  { label: 'In Lightroom', value: (r) => (r.lr ? (r.edited ? 'Yes, edited' : 'Yes') : 'No'), cell: lrCell },
  { label: 'Checksum', sort: false, value: (r) => r.sha256, cell: (r) => h('code', { title: `SHA-256: ${r.sha256}` }, r.sha256.slice(0, 12)) },
];

function allFilesView() {
  const A = state.allFiles || (state.allFiles = { show: 'lronly', q: '' });
  if (!A.res) {
    loadAllFiles();
    return [h('h1', {}, 'All files'), h('p', { class: 'lede' }, 'Loading')];
  }
  const t = A.res.totals;
  const setTab = (k) => { A.show = k; A.res = { ...A.res, rows: [] }; loadAllFiles(); };
  let timer = null;
  const search = h('input', { type: 'search', value: A.q, placeholder: 'Search by name, date (2024-07) or checksum', 'aria-label': 'Search files',
    oninput: (e) => { A.q = e.target.value; clearTimeout(timer); timer = setTimeout(loadAllFiles, 300); } });
  const exportAll = h('button', { class: 'btn', title: 'Save every file in this list, not just the ones shown', onclick: async () => {
    const all = await api.invoke('filemap', { show: A.show, q: A.q, all: true });
    const label = FILE_TABS.find(([k]) => k === A.show)[1];
    await api.invoke('export:csv', { name: `CardMap files - ${label}`, csv: csvOf(ALL_FILE_COLUMNS, all.all) });
  } }, `Export all ${A.res.matching.toLocaleString()}`);

  return [
    h('h1', {}, 'All files'),
    h('p', { class: 'lede' }, 'Every photo and video CardMap knows, once each, matched by checksum across your indexed drives, your cards and Lightroom.'),
    h('div', { class: 'seg tabs', role: 'tablist' }, FILE_TABS.map(([k, label]) =>
      h('button', { class: `btn${A.show === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(A.show === k), onclick: () => setTab(k) },
        `${label} (${t[k].files.toLocaleString()})`))),
    h('p', { class: 'hint' }, `${FILE_TAB_HINT[A.show]} ${t[A.show].files.toLocaleString()} files, ${bytes(t[A.show].bytes)}.`),
    h('div', { class: 'row toolbar' }, search, h('span', { class: 'spacer' }), exportAll),
    A.res.truncated ? h('p', { class: 'hint' }, `Showing the largest ${A.res.rows.length.toLocaleString()} of ${A.res.matching.toLocaleString()}. Search to narrow it down; "Export all" saves the whole list.`) : null,
    grid('allfiles', ALL_FILE_COLUMNS, A.res.rows, { name: 'CardMap files', sort: { col: 2, dir: -1 }, empty: 'Nothing here.' }),
  ];
}
