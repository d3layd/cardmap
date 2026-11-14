// The Compare page: two drives or folders side by side. What is only in A, only in B,
// and in both, matched by checksum. Read-only: it uses the library index.
// Uses globals from app.js and grid.js (h, api, state, grid, bytes, renderMain, busy).

async function loadCompare() {
  const C = state.compare || (state.compare = { sides: [], a: '', b: '', result: null, tab: 'a', running: false });
  try {
    C.sides = (await api.invoke('compare:sides')) || [];
  } catch (e) {
    C.sides = [];
    C.result = C.result || { error: e.message };
  }
  if (state.view === 'compare') renderMain();
}

async function compareRun() {
  const C = state.compare;
  if (!C || C.running) return;
  C.a = (C.a || '').trim();
  C.b = (C.b || '').trim();
  if (!C.a || !C.b) {
    C.result = { error: 'Type a drive or folder in both boxes.' };
    renderMain();
    return;
  }
  C.running = true;
  renderMain();
  try {
    C.result = await api.invoke('compare:run', { a: C.a, b: C.b });
  } catch (e) {
    C.result = { error: e.message };
  }
  C.running = false;
  if (state.view === 'compare') renderMain();
}

function comparePathCell(p) {
  return h('div', { class: 'place' },
    h('button', { class: 'link dir', title: 'Open the folder', onclick: () => api.invoke('reveal', p.slice(0, p.lastIndexOf('\\'))) }, p));
}

function compareGrid(id, side, label, name) {
  return [
    side.truncated ? h('p', { class: 'hint' }, `Showing the ${side.rows.length.toLocaleString()} largest of ${side.files.toLocaleString()} files.`) : null,
    grid(id, [
      { label, value: (r) => r.path, cell: (r) => comparePathCell(r.path) },
      { label: 'Size', num: true, value: (r) => r.size, cell: (r) => bytes(r.size) },
      { label: 'Checksum', csv: true, sort: false, value: (r) => r.sha256, cell: (r) => h('code', { title: `SHA-256: ${r.sha256}` }, r.sha256.slice(0, 12)) },
    ], side.rows, { name, sort: { col: 1, dir: -1 }, empty: 'None: every file with a checksum is also on the other side.' }),
  ];
}

function compareView() {
  const C = state.compare || (state.compare = { sides: [], a: '', b: '', result: null, tab: 'a', running: false });
  const R = C.result;
  const options = [];
  for (const d of C.sides || []) {
    options.push(h('option', { value: d.path, label: `${d.label || 'Drive'} (${d.files.toLocaleString()} files)` }));
    for (const f of d.folders || []) options.push(h('option', { value: f.path, label: `${f.files.toLocaleString()} files` }));
  }
  const box = (key, label) => h('label', { class: 'field' }, h('span', {}, label),
    h('input', {
      type: 'text', list: 'compare-sides', value: C[key] || '', placeholder: 'E:\\ or E:\\Folder', spellcheck: 'false', size: 40,
      oninput: (e) => { C[key] = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') compareRun(); },
    }));

  const out = [
    h('h1', {}, 'Compare'),
    h('p', { class: 'lede' }, 'Pick two drives or folders to see which files are only in one of them and which are in both. Files are matched by checksum, so names and folders do not need to match. Nothing is changed.'),
    h('datalist', { id: 'compare-sides' }, options),
    h('div', { class: 'card-box' },
      h('div', { class: 'row' }, box('a', 'A'), box('b', 'B')),
      h('div', { class: 'row actions' },
        h('button', { class: 'btn primary', disabled: C.running, onclick: compareRun }, C.running ? 'Comparing' : 'Compare'),
        h('button', { class: 'btn', disabled: C.running, title: 'Swap A and B', onclick: () => { [C.a, C.b] = [C.b, C.a]; renderMain(); } }, 'Swap'))),
  ];
  if (!R) return out;
  if (R.error) return [...out, h('div', { class: 'card-box' }, h('strong', { class: 'part' }, R.error))];

  const unhashed = (s, name) => (s.unhashed
    ? h('li', {}, h('strong', { class: 'part' }, `${s.unhashed.toLocaleString()} files in ${name} have no checksum yet. `), 'They are left out of the comparison.')
    : null);
  out.push(h('div', { class: 'card-box' },
    h('div', {}, h('strong', {}, `A: ${R.a.path}`), ` ${R.a.files.toLocaleString()} files, ${bytes(R.a.bytes)}`),
    h('div', {}, h('strong', {}, `B: ${R.b.path}`), ` ${R.b.files.toLocaleString()} files, ${bytes(R.b.bytes)}`),
    h('ul', { class: 'tally' },
      h('li', {}, h('strong', { class: 'ok' }, `In both: ${R.both.files.toLocaleString()} files, ${bytes(R.both.bytes)}. `),
        `${R.a.inBoth.toLocaleString()} files in A and ${R.b.inBoth.toLocaleString()} in B hold them.`),
      h('li', {}, h('strong', {}, `Only in A: ${R.onlyA.files.toLocaleString()} files, ${bytes(R.onlyA.bytes)}.`)),
      h('li', {}, h('strong', {}, `Only in B: ${R.onlyB.files.toLocaleString()} files, ${bytes(R.onlyB.bytes)}.`)),
      unhashed(R.a, 'A'), unhashed(R.b, 'B')),
    h('div', { class: 'hint' }, 'From the library index. Files not indexed yet are not included.')));

  const tab = C.tab === 'b' ? 'b' : 'a';
  out.push(h('div', { class: 'seg tabs', role: 'tablist' }, [
    ['a', `Only in A (${R.onlyA.files.toLocaleString()})`],
    ['b', `Only in B (${R.onlyB.files.toLocaleString()})`],
  ].map(([k, label]) => h('button', { class: `btn${tab === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(tab === k), onclick: () => { C.tab = k; renderMain(); } }, label))));
  out.push(tab === 'a'
    ? compareGrid('compare-a', R.onlyA, 'Only in A', `Only in ${R.a.path}`)
    : compareGrid('compare-b', R.onlyB, 'Only in B', `Only in ${R.b.path}`));
  return out;
}
