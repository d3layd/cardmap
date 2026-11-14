// The Near matches page: Lightroom assets with no checksum match on your drives that
// probably do have a local copy under the same name (a converted or re-encoded file).
// Uses globals from app.js (h, api, state, grid, bytes, renderMain, busy).

async function loadNearMatch() {
  state.nearMatch = await api.invoke('nearmatch:get');
  if (state.view === 'nearmatch') renderMain();
}

function nearMatchView() {
  const N = state.nearMatch;
  const intro = [
    h('h1', {}, 'Near matches'),
    h('p', { class: 'lede' }, 'A checksum match is exact: the Lightroom file and the local file are the same, byte for byte. A converted or re-encoded copy (a DNG conversion, HEIC saved as JPG, a proxy) never matches that way, so it looks like it is only in Lightroom. This page lists those Lightroom files that probably do have a local copy, going by file name and capture day. Nothing here is recorded as a match: it is a list to check yourself.'),
  ];
  if (!N) return [...intro, h('p', { class: 'hint' }, 'Loading')];
  if (N.error) return [...intro, h('div', { class: 'notice' }, String(N.error))];

  const n = (t) => (t ? t.files : 0).toLocaleString();
  const b = (t) => bytes(t ? t.bytes : 0);
  const summary = h('div', { class: 'card-box' },
    h('div', {}, h('strong', {}, `${n(N.lrOnly)} Lightroom files have no checksum match on your drives`), `, ${b(N.lrOnly)}.`),
    h('ul', { class: 'tally' },
      h('li', {}, h('strong', { class: 'ok' }, `Likely copies: ${n(N.high)} files, ${b(N.high)}. `), 'A local file has the same name and was last changed on the capture day.'),
      h('li', {}, h('strong', { class: 'part' }, `Same name only: ${n(N.low)} files, ${b(N.low)}. `), 'Weak: cameras reuse file names when their counter wraps, so this can be a different picture.'),
      h('li', {}, h('strong', {}, `No local file with that name: ${n(N.unmatched)} files, ${b(N.unmatched)}. `), 'As far as the library index shows, these are only in Lightroom.')),
    h('div', { class: 'hint' }, 'Sizes are the Lightroom originals. Local files are compared by name without the extension, ignoring case. Files not indexed yet are not included.'),
    h('div', { class: 'row actions' }, h('button', { class: 'btn', disabled: busy(), onclick: () => { state.nearMatch = null; renderMain(); loadNearMatch(); } }, 'Refresh')));

  const localText = (r) => r.local.map((l) => l.path).join('; ');
  const localBytes = (r) => r.local.reduce((s, l) => s + (l.size || 0), 0);
  const folder = (p) => p.slice(0, p.lastIndexOf('\\'));
  const table = grid('nearmatch', [
    { label: 'Lightroom file', value: (r) => r.name || '', cell: (r) => r.name || '' },
    { label: 'Captured', cls: 'date', value: (r) => r.captureDate || '', cell: (r) => r.captureDate || h('span', { class: 'none' }, 'unknown') },
    { label: 'Lightroom size', num: true, value: (r) => r.lrSize || 0, cell: (r) => bytes(r.lrSize || 0) },
    { label: 'Confidence', value: (r) => (r.confidence === 'high' ? 'Likely' : 'Name only'),
      cell: (r) => (r.confidence === 'high' ? h('span', { class: 'ok' }, 'Likely') : h('span', { class: 'part' }, 'Name only')) },
    { label: 'Local files', value: (r) => r.local.length, text: localText,
      cell: (r) => r.local.map((l) => h('div', { class: 'place' },
        h('button', { class: 'link dir', title: 'Open the folder', onclick: () => api.invoke('reveal', folder(l.path)) }, l.path),
        h('span', { class: 'n' }, bytes(l.size || 0)))) },
    { label: 'Local size', num: true, value: localBytes, cell: (r) => bytes(localBytes(r)) },
  ], N.rows, { name: 'Near matches', empty: 'No near matches.' });

  return [...intro, summary,
    N.truncated ? h('p', { class: 'hint' }, `Showing ${N.rows.length.toLocaleString()} of ${n(N.matched)}: the likely copies first, then the largest. The totals above cover all of them.`) : null,
    table];
}
