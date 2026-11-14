const api = window.cardmap;

const state = {
  view: 'welcome', // welcome | card | files | map | settings
  cards: { mounted: [], past: [], names: [] },
  cardKey: null, // "m:E:" for a mounted drive, "c:12" for a past card
  summary: null,
  loading: false,
  error: null,
  groupBy: 'date', // date | folder
  sel: new Set(),
  form: { shoot: '', dest: '', backup: '' },
  settings: {},
  job: null,
  lastResult: null,
  mapQuery: '',
  mapRows: null,
  files: null, // { title, sub, back, query, rows }
};

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'indeterminate') el[k] = Boolean(v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function bytes(n) {
  if (!n) return '0 MB';
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function tally(n, total) {
  const cls = n === 0 ? 'none' : n === total ? 'ok' : 'part';
  return h('span', { class: cls }, n === total && total > 0 ? `All ${total}` : `${n} of ${total}`);
}

function dateTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const KIND = { primary: 'Main copy', backup: 'Backup', lightroom: 'Lightroom', found: 'Found', card: 'On card', index: 'In folder' };
const busy = () => Boolean(state.job);
const cardName = (c) => c.nickname || c.label || 'Untitled';
const dirOf = (p) => p.slice(0, p.lastIndexOf('\\'));

// ---------- data ----------
async function loadCards() {
  state.cards = await api.invoke('cards');
  renderSidebar();
}

// Nothing is ticked to begin with: browsing comes first, and an import with
// nothing ticked covers the whole card.
function defaultSelection() {
  state.sel = new Set();
}

/** Bar plus text showing how full a card is. */
function usage(size, free, compact) {
  if (!size) return null;
  const used = Math.max(0, size - free);
  const pct = Math.round((used / size) * 100);
  return h('div', { class: `usage${compact ? ' compact' : ''}` },
    h('progress', { class: pct >= 90 ? 'full' : '', max: size, value: used, 'aria-label': `${pct}% full` }),
    h('span', {}, compact ? `${bytes(used)} of ${bytes(size)}` : `${bytes(used)} used of ${bytes(size)} (${pct}% full), ${bytes(free)} free`));
}

async function openMounted(letter) {
  state.view = 'card';
  state.cardKey = `m:${letter}`;
  state.summary = null;
  state.error = null;
  state.loading = true;
  state.lastResult = null;
  render();
  try {
    state.summary = await api.invoke('card:scan', letter);
    defaultSelection();
    await loadCards();
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  render();
}

async function openPast(cardId) {
  state.view = 'card';
  state.cardKey = `c:${cardId}`;
  state.error = null;
  state.lastResult = null;
  state.summary = await api.invoke('card:summary', cardId);
  state.sel = new Set();
  render();
}

async function refreshSummary() {
  if (!state.summary) return;
  state.summary = await api.invoke('card:summary', state.summary.card.id);
}

async function loadMap() {
  state.mapRows = await api.invoke('map', state.mapQuery);
  if (state.view === 'map') renderMain();
}

/** Open the list of individual files for a date, a card folder, or a folder on disk. */
async function openFiles(query, title, sub) {
  state.files = { query, title, sub, back: state.view === 'files' ? state.files.back : state.view, rows: null };
  state.view = 'files';
  state.lastResult = null;
  render();
  state.files.rows = await api.invoke('files', query);
  if (state.view === 'files') renderMain();
}

async function run(channel, arg) {
  state.lastResult = null;
  try {
    await api.invoke(channel, arg);
  } catch (e) {
    state.lastResult = { error: e.message };
    renderMain();
  }
}

// ---------- sidebar ----------
function renderSidebar() {
  const { mounted, past } = state.cards;
  const side = document.getElementById('sidebar');
  const onCard = state.view === 'card' || (state.view === 'files' && state.files.back === 'card');
  side.replaceChildren(...[
    h('div', { class: 'brand' }, 'CardMap'),
    h('div', { class: 'nav-title' }, 'Connected cards'),
    mounted.length
      ? mounted.map((d) =>
          h('button', { class: `nav-item${state.cardKey === `m:${d.letter}` && onCard ? ' active' : ''}`, onclick: () => openMounted(d.letter) },
            h('span', { class: 'dot on' }),
            h('span', { class: 'grow' }, `${cardName(d)} (${d.letter})`, usage(d.size, d.free, true))
          )
        )
      : h('div', { class: 'empty-note' }, 'Insert a card to import from it.'),
    h('div', { class: 'nav-title' }, 'Library'),
    h('button', { class: `nav-item${state.view === 'lookup' ? ' active' : ''}`, onclick: () => show('lookup') }, h('span', { class: 'grow' }, 'Find a file')),
    h('button', { class: `nav-item${state.view === 'map' || (state.view === 'files' && state.files.back === 'map') ? ' active' : ''}`, onclick: () => show('map') }, h('span', { class: 'grow' }, 'Where things are')),
    h('button', { class: `nav-item${state.view === 'index' ? ' active' : ''}`, onclick: () => show('index') },
      h('span', { class: 'grow' }, 'Library index', h('div', { class: 'sub', id: 'navbg' }, state.bg ? `Indexing${state.bg.bytesTotal ? ` ${Math.floor((state.bg.bytesDone / state.bg.bytesTotal) * 100)}%` : ''}` : ''))),
    h('button', { class: `nav-item${state.view === 'lightroom' ? ' active' : ''}`, onclick: () => show('lightroom') }, h('span', { class: 'grow' }, 'Lightroom library')),
    h('button', { class: `nav-item${state.view === 'settings' ? ' active' : ''}`, onclick: () => show('settings') }, h('span', { class: 'grow' }, 'Settings')),
    past.length ? h('div', { class: 'nav-title' }, 'Earlier cards') : null,
    past.map((c) =>
      h('button', { class: `nav-item${state.cardKey === `c:${c.id}` && onCard ? ' active' : ''}`, onclick: () => openPast(c.id) },
        h('span', { class: 'dot' }),
        h('span', { class: 'grow' }, cardName(c), h('div', { class: 'sub' }, `${c.serial} · last seen ${c.last_seen.slice(0, 10)}`))
      )
    ),
  ].flat(Infinity).filter(Boolean));
}

function show(view) {
  state.view = view;
  state.lastResult = null;
  if (view === 'map') loadMap();
  if (view === 'lightroom') loadLightroom();
  if (view === 'index') loadIndex();
  render();
}
// Development hook used by the screenshot aid in main.js.
window.__show = (v) => {
  if (v.startsWith('import:')) { state.drawer = 'import'; return openMounted(v.slice(7)); }
  if (v.startsWith('lookup:')) { state.lookup = { q: v.slice(7), res: null }; show('lookup'); return runLookup(); }
  if (v === 'rules') { state.rulesOpen = true; return show('index'); }
  if (v.startsWith('local:')) { state.drawer = 'local'; return openMounted(v.slice(6)); }
  if (v.startsWith('lr:')) { state.drawer = 'lightroom'; return openMounted(v.slice(3)); }
  if (v.startsWith('m:')) return openMounted(v.slice(2));
  if (v.startsWith('files:')) return openFiles(JSON.parse(v.slice(6)), 'Files', '');
  return show(v);
};

// ---------- views ----------
function resultNotice() {
  const r = state.lastResult;
  if (!r) return null;
  if (r.error) return h('div', { class: 'notice bad' }, r.error);
  if (r.info) return h('div', { class: 'notice' }, r.info);
  const x = r.result || {};
  let text = 'Done.';
  if (r.kind === 'import') {
    text = `${x.cancelled ? 'Import cancelled' : 'Import finished'}: ${x.copied} copied and verified, ${x.skipped} already in place, ${x.failed} failed.`;
  } else if (r.kind === 'lightroom') {
    text = `Lightroom check${x.cancelled ? ' cancelled' : ''}: ${x.found} of ${x.checked} files are in the Lightroom library, ${x.notFound} are not.`;
    if (x.notUploaded) text += ` ${x.notUploaded} are in the catalog but their upload is not confirmed.`;
    if (x.unverifiable) text += ` ${x.unverifiable} might be there but need the card inserted to confirm.`;
    text += x.method === 'catalog'
      ? ` Compared by checksum against ${x.catalogAssets} photos and videos in Lightroom's catalog.`
      : " Lightroom's catalog was not found, so only its local cache of recent files was checked.";
  } else if (r.kind === 'inventory') {
    text = `File list updated${x.cancelled ? ' (stopped early)' : ''}: ${x.files.toLocaleString()} files, ${bytes(x.bytes)}. ${x.added.toLocaleString()} new, ${x.changed.toLocaleString()} changed, ${x.removed.toLocaleString()} no longer there.`;
    if (x.skippedFolders && x.skippedFolders.length) text += ` Not connected, so skipped: ${x.skippedFolders.join(', ')}.`;
  } else if (r.kind === 'lrcache') {
    text = x.changed
      ? `Lightroom's catalog was read: ${x.read.toLocaleString()} changed entries picked up. The cache now holds ${x.assets.toLocaleString()} photos and videos in ${x.albums.toLocaleString()} albums.`
      : 'Already up to date: Lightroom has not changed its catalog since the last read.';
  } else if (r.kind === 'folderscan') {
    text = `Search${x.cancelled ? ' cancelled' : ' finished'}: ${x.scanned.toLocaleString()} files looked at. ${x.filesWithCopies} card file${x.filesWithCopies === 1 ? ' has' : 's have'} a matching local copy (${x.matched} newly recorded, ${x.alreadyKnown} already known).`;
    if (x.renamed) text += ` ${x.renamed} of the new matches had a different file name.`;
    if (x.lookups != null) text += ` ${x.lookups} were matched straight from the index; ${x.read} local files had to be read.`;
    if (x.unverifiable) text += ` ${x.unverifiable} possible matches need their card inserted to confirm.`;
    if (x.skippedFolders && x.skippedFolders.length) text += ` Not connected, so skipped: ${x.skippedFolders.join(', ')}.`;
  }
  return h('div', { class: `notice${x.failed ? ' bad' : ''}` }, text,
    x.errors && x.errors.length ? h('ul', {}, x.errors.slice(0, 8).map((e) => h('li', {}, `${e.name}: ${e.message}`))) : null);
}

function folderField(label, key, placeholder) {
  const input = h('input', { type: 'text', value: state.form[key], placeholder, oninput: (e) => (state.form[key] = e.target.value.trim()) });
  return [
    h('label', {}, label),
    input,
    h('button', { class: 'btn', onclick: async () => {
      const p = await api.invoke('pickFolder', state.form[key]);
      if (p) { state.form[key] = p; input.value = p; }
    } }, 'Browse'),
  ];
}

function nameField(s) {
  const save = async (e) => {
    const name = e.target.value.trim();
    if (name === (s.card.nickname || '')) return;
    state.cards = await api.invoke('card:rename', { cardId: s.card.id, name });
    s.card.nickname = name;
    render();
  };
  return h('span', { class: 'namefield' },
    h('input', { type: 'text', id: 'cardname', list: 'cardnames', value: s.card.nickname || '', placeholder: 'Name this card', 'aria-label': 'Card name',
      title: 'Use the name written on the card. Pick the same name again after a format to keep its history together.',
      onchange: save, onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
    h('datalist', { id: 'cardnames' }, (state.cards.names || []).map((n) => h('option', { value: n }))));
}

function stackedFolder(label, key, placeholder) {
  const input = h('input', { type: 'text', value: state.form[key], placeholder, 'aria-label': label, oninput: (e) => (state.form[key] = e.target.value.trim()) });
  return h('div', { class: 'field' },
    h('label', {}, label),
    h('div', { class: 'row tight' }, input,
      h('button', { class: 'btn', onclick: async () => {
        const p = await api.invoke('pickFolder', state.form[key]);
        if (p) { state.form[key] = p; input.value = p; }
      } }, 'Browse')));
}

/** The import panel: opens beside the table only when asked for. */
function importPanel(s, rows, keys, unit) {
  const chosen = keys.length ? rows.filter((g) => state.sel.has(g.key)) : rows;
  const count = chosen.reduce((n, g) => n + g.count, 0);
  const size = chosen.reduce((n, g) => n + g.bytes, 0);
  const todo = chosen.reduce((n, g) => n + (g.count - g.copied), 0);
  const pick = keys.length ? (unit === 'date' ? { dates: keys } : { folders: keys }) : { dates: s.groups.map((g) => g.key) };
  // Dates the chosen rows cover, for the folder preview. Known exactly when grouped by date.
  const dates = unit === 'date' ? chosen.map((g) => g.key) : keys.length ? null : s.groups.map((g) => g.key);
  const preview = h('div', { class: 'preview' });
  const refresh = () => {
    const shoot = state.form.shoot.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim();
    const folder = (d) => (shoot ? `${d} ${shoot}` : d);
    const roots = [['Main copy', state.form.dest], ['Backup', state.form.backup]].filter(([, p]) => p);
    if (!roots.length) {
      preview.replaceChildren(h('div', { class: 'none' }, 'Choose a "Copy to" folder to see where the files will go.'));
      return;
    }
    const names = dates ? dates.slice().sort().map(folder) : [folder('<capture date>')];
    preview.replaceChildren(...roots.map(([label, root]) => h('div', { class: 'tree' },
      h('div', { class: 'none' }, label),
      h('div', { class: 'root' }, root),
      names.slice(0, 4).map((n) => h('div', { class: 'leaf' }, `\\${n}\\`)),
      names.length > 4 ? h('div', { class: 'leaf none' }, `and ${names.length - 4} more date folders`) : null)));
  };
  const onForm = (key) => (e) => { state.form[key] = key === 'shoot' ? e.target.value : e.target.value.trim(); refresh(); };
  const folderInput = (label, key, placeholder) => {
    const input = h('input', { type: 'text', value: state.form[key], placeholder, 'aria-label': label, oninput: onForm(key) });
    return h('div', { class: 'field' }, h('label', {}, label),
      h('div', { class: 'row tight' }, input,
        h('button', { class: 'btn', onclick: async () => {
          const p = await api.invoke('pickFolder', state.form[key]);
          if (p) { state.form[key] = p; input.value = p; refresh(); }
        } }, 'Browse')));
  };
  refresh();

  return h('aside', { class: 'drawer', 'aria-label': 'Import' },
    h('div', { class: 'row' }, h('h2', {}, 'Import from this card'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => { state.drawer = null; renderMain(); } }, 'Close')),

    h('h3', {}, h('span', { class: 'step' }, '1'), 'What gets copied'),
    h('div', { class: 'what' },
      h('strong', {}, keys.length ? `${keys.length} selected ${unit}${keys.length === 1 ? '' : 's'}` : 'The whole card'),
      h('div', { class: 'none' }, `${count} files, ${bytes(size)}. ${todo === 0 ? 'All of them are already copied.' : todo === count ? 'None copied yet.' : `${count - todo} already copied, ${todo} still to copy.`}`),
      keys.length ? null : h('div', { class: 'none' }, 'To copy only part of the card, tick rows in the table.')),

    h('h3', {}, h('span', { class: 'step' }, '2'), 'Where it goes'),
    h('div', { class: 'field' }, h('label', {}, 'Shoot name (optional, added to each folder name)'),
      h('input', { type: 'text', value: state.form.shoot, placeholder: 'e.g. Smith Wedding', 'aria-label': 'Shoot name', oninput: onForm('shoot') })),
    folderInput('Copy to', 'dest', 'Folder for the main copy'),
    folderInput('Backup to (optional second copy)', 'backup', 'Ideally on a different drive'),
    h('div', { class: 'field' }, h('label', {}, 'Folders that will be used'), preview),

    h('h3', {}, h('span', { class: 'step' }, '3'), 'What happens when you start'),
    h('ul', { class: 'steps' },
      h('li', {}, 'Each file is copied into a folder for the day it was taken.'),
      h('li', {}, 'Every copy is read back and compared with the card. Only matching copies are recorded.'),
      h('li', {}, 'Files that are already copied are skipped, so it is safe to run again.'),
      h('li', {}, 'Nothing on the card is changed or deleted.')),
    h('button', { class: 'btn primary wide', disabled: busy() || !count,
      onclick: () => run('import:start', { cardId: s.card.id, ...pick, shoot: state.form.shoot.trim(), dest: state.form.dest, backup: state.form.backup }) },
      todo === 0 ? `Check ${count} files again` : `Copy and verify ${todo} file${todo === 1 ? '' : 's'}`));
}

/** The "Find local copies" panel: match this card's files to files already on your drives. */
function localPanel(s) {
  const list = h('div', { class: 'folderlist' });
  const start = h('button', { class: 'btn primary wide', disabled: true,
    onclick: () => run('folderscan:start', { folders: (state.libFolders || []).filter((f) => f.exists).map((f) => f.path), cardId: s.card.id }) },
    'Search these folders');
  const draw = () => {
    const folders = state.libFolders || [];
    list.replaceChildren(...(folders.length
      ? folders.map((f) => h('div', { class: 'folderrow' },
          h('span', { class: `dir${f.exists ? '' : ' missing'}` }, f.exists ? f.path : `${f.path} (not connected)`),
          h('button', { class: 'link', 'aria-label': `Remove ${f.path}`, onclick: async () => {
            state.libFolders = await api.invoke('library:setFolders', folders.filter((x) => x.path !== f.path).map((x) => x.path));
            draw();
          } }, 'Remove')))
      : [h('div', { class: 'none' }, 'No folders yet. Add the folders or drives where you keep photos and video.')]));
    start.disabled = busy() || !folders.some((f) => f.exists);
  };
  if (state.libFolders) draw();
  api.invoke('library:folders').then((f) => { state.libFolders = f; draw(); });

  return h('aside', { class: 'drawer', 'aria-label': 'Find local copies' },
    h('div', { class: 'row' }, h('h2', {}, 'Find local copies'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => { state.drawer = null; renderMain(); } }, 'Close')),

    h('h3', {}, h('span', { class: 'step' }, '1'), 'What it does'),
    h('ul', { class: 'steps' },
      h('li', {}, `Looks through your folders for files that are the same as the ${s.totals.count} on this card.`),
      h('li', {}, 'A file counts as a copy only when its contents match exactly, by checksum. The file name does not matter, so renamed copies are found.'),
      h('li', {}, 'Files already in the library index are matched instantly. Others are read once and their checksum is saved for next time.'),
      h('li', {}, 'Nothing is copied, moved or changed. Matches are recorded and show up in the Copied column.')),

    h('h3', {}, h('span', { class: 'step' }, '2'), 'Where to look'),
    list,
    h('button', { class: 'btn wide', onclick: async () => {
      const p = await api.invoke('pickFolder', '');
      if (!p) return;
      state.libFolders = await api.invoke('library:setFolders', [...(state.libFolders || []).map((x) => x.path), p]);
      draw();
    } }, 'Add a folder'),
    h('div', { class: 'hint' }, 'These folders are remembered for next time. For a whole drive, tick it under Library index instead, so only imported media is looked at.'),

    h('h3', {}, h('span', { class: 'step' }, '3'), 'Search'),
    h('div', { class: 'hint' }, s.mounted ? 'Keep the card in: matching files are read from it to compare.' : 'The card is not connected, so only files CardMap has already read can be matched.'),
    start);
}

/** The "Add to Lightroom" panel: drag the files onto Lightroom, then confirm against its catalog. */
function lightroomPanel(s, rows, keys, unit) {
  const chosen = keys.length ? rows.filter((g) => state.sel.has(g.key)) : rows;
  const count = chosen.reduce((n, g) => n + g.count, 0);
  const have = chosen.reduce((n, g) => n + g.lightroom, 0);
  const query = { cardId: s.card.id, ...(keys.length ? (unit === 'date' ? { dates: keys } : { folders: keys }) : {}) };
  const tile = h('div', { class: 'dragtile', draggable: 'true', tabindex: '0',
    ondragstart: (e) => { e.preventDefault(); api.drag(query); } },
    h('strong', {}, 'Drag this onto Lightroom'), h('div', { class: 'none', id: 'lrpending' }, 'Counting files'));
  api.invoke('lightroom:pending', query).then((n) => {
    const el = tile.querySelector('#lrpending');
    if (!el) return;
    el.textContent = n ? `${n} file${n === 1 ? '' : 's'} not in Lightroom yet` : 'Nothing to add: these are all in Lightroom, or no copy is reachable.';
    if (!n) { tile.classList.add('off'); tile.draggable = false; }
  });
  return h('aside', { class: 'drawer', 'aria-label': 'Add to Lightroom' },
    h('div', { class: 'row' }, h('h2', {}, 'Add to Lightroom'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => { state.drawer = null; renderMain(); } }, 'Close')),

    h('h3', {}, h('span', { class: 'step' }, '1'), 'What gets added'),
    h('div', { class: 'what' },
      h('strong', {}, keys.length ? `${keys.length} selected ${unit}${keys.length === 1 ? '' : 's'}` : 'The whole card'),
      h('div', { class: 'none' }, `${count} files. ${have} already recorded as in Lightroom.`),
      h('div', { class: 'none' }, 'Run "Check Lightroom" first if you have not, so files already there are left out.')),

    h('h3', {}, h('span', { class: 'step' }, '2'), 'Hand them to Lightroom'),
    h('button', { class: 'btn wide', onclick: async () => {
      const err = await api.invoke('lightroom:open');
      if (err) { state.lastResult = { error: err }; renderMain(); }
    } }, 'Open Lightroom'),
    tile,
    h('ul', { class: 'steps' },
      h('li', {}, 'Drag the tile onto the Lightroom window and let go. Lightroom shows the photos for you to review.'),
      h('li', {}, 'Pick an album there if you want one, then press Add Photos in Lightroom.'),
      h('li', {}, 'Files come from your copied folder when there is one, otherwise straight from the card.')),

    h('h3', {}, h('span', { class: 'step' }, '3'), 'Confirm it worked'),
    h('ul', { class: 'steps' }, h('li', {}, 'When Lightroom has finished adding, press the button below. CardMap reads Lightroom\'s catalog and marks each file that is really there.')),
    h('button', { class: 'btn primary wide', disabled: busy(),
      onclick: () => run('lightroom:start', query) }, 'Confirm in Lightroom\'s catalog'));
}

// ---------- previews ----------
// Thumbnails load only when scrolled into view, a few at a time (card reads are slow).
const thumbQueue = [];
let thumbsRunning = 0;
function pumpThumbs() {
  while (thumbsRunning < 3 && thumbQueue.length) {
    const box = thumbQueue.shift();
    if (!box.isConnected) continue;
    thumbsRunning += 1;
    api.invoke('thumb', box.dataset.path).then((url) => {
      if (url) box.replaceChildren(h('img', { src: url, alt: '' }));
      else box.classList.add('nothumb');
    }).finally(() => { thumbsRunning -= 1; pumpThumbs(); });
  }
}
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    thumbQueue.push(e.target);
  }
  pumpThumbs();
}, { rootMargin: '300px' });

async function openFile(p) {
  const err = await api.invoke('open', p);
  if (err) { state.lastResult = { error: `Could not open the file: ${err}` }; renderMain(); }
}

function thumb(r) {
  if (!r.openPath) return h('div', { class: 'thumb nothumb', title: 'No copy is available to preview. Insert the card or reconnect the drive.' });
  const box = h('button', { class: 'thumb', 'data-path': r.openPath, title: `Open ${r.name} (from ${r.openFrom === 'card' ? 'the card' : 'a copy on disk'})`,
    'aria-label': `Open ${r.name}`, onclick: () => openFile(r.openPath) });
  thumbObserver.observe(box);
  return box;
}

function locRow(l) {
  const lr = l.path.startsWith('lightroom:');
  return h('div', { class: 'place' },
    h('span', { class: 'kind' }, KIND[l.kind] || l.kind),
    lr
      ? h('span', { class: 'dir text' }, l.verified ? 'In the Lightroom library, original stored in the cloud' : 'In the Lightroom catalog, upload not confirmed yet',
          h('div', { class: 'none' }, l.albums && l.albums.length ? `Album: ${l.albums.join('; ')}` : 'Not in any album'))
      : l.exists
        ? h('button', { class: 'link dir', title: 'Open the folder', onclick: () => api.invoke('reveal', dirOf(l.path)) }, l.path)
        : l.offline
          ? h('span', { class: 'dir offline' }, `${l.path} (not connected: ${l.drive})`)
          : h('span', { class: 'dir missing' }, `${l.path} (not found now)`),
    h('span', { class: 'n' }, l.verified ? `${lr ? 'matched' : 'verified'} ${String(l.verified_at || '').slice(0, 10)}` : 'unverified'));
}

function cardView() {
  if (state.loading) return [h('h1', {}, 'Reading card'), h('p', { class: 'lede' }, 'Listing the files on the card. Nothing is written to it.')];
  if (state.error) return [h('h1', {}, 'Card'), h('div', { class: 'notice bad' }, state.error)];
  const s = state.summary;
  if (!s) return [];
  const t = s.totals;
  const byDate = state.groupBy === 'date';
  const rows = byDate ? s.groups : s.folders;
  const allSel = rows.length > 0 && rows.every((g) => state.sel.has(g.key));
  const keys = [...state.sel];
  const pick = byDate ? { dates: keys } : { folders: keys };
  const unit = byDate ? 'date' : 'folder';
  const title = `${cardName(s.card)}${s.letter ? ` (${s.letter})` : ''}`;

  const badge = !s.mounted
    ? h('span', { class: 'badge' }, 'Not connected')
    : s.safeToFormat
      ? h('span', { class: 'badge good' }, 'Safe to format')
      : h('span', { class: 'badge warn' }, `Not safe to format: ${t.count - t.safe} files have fewer than 2 verified copies`);

  const setGroup = (g) => { state.groupBy = g; defaultSelection(); renderMain(); };

  const drive = s.mounted ? state.cards.mounted.find((d) => d.letter === s.letter) : null;
  const sel = keys.length ? ` (${keys.length} selected)` : '';

  return [h('div', { class: 'split' }, h('div', { class: 'split-main' }, [
    h('div', { class: 'row' }, h('h1', {}, title), badge, h('span', { class: 'spacer' }), nameField(s)),
    h('p', { class: 'lede' }, `${t.count} photo and video files in ${s.folders.length} folder${s.folders.length === 1 ? '' : 's'}, ${bytes(t.bytes)}. Card ID ${s.card.serial}.`),
    drive ? usage(drive.size, drive.free, false) : s.card.size ? h('div', { class: 'usage' }, h('span', {}, `${bytes(s.card.size)} card`)) : null,
    resultNotice(),
    s.mounted ? null : h('div', { class: 'notice' }, 'This card is not connected. The table shows what was recorded when it was last read.'),
    h('div', { class: 'row toolbar' },
      h('span', { class: 'none' }, 'Group by'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Group files by' },
        h('button', { class: `btn${byDate ? ' on' : ''}`, 'aria-pressed': String(byDate), onclick: () => setGroup('date') }, 'Date'),
        h('button', { class: `btn${byDate ? '' : ' on'}`, 'aria-pressed': String(!byDate), onclick: () => setGroup('folder') }, 'Card folder')),
      h('span', { class: 'none' }, `Click a ${unit} to see its files.`),
      h('span', { class: 'spacer' }),
      s.mounted ? h('button', { class: 'btn', disabled: busy(),
        onclick: () => run('lightroom:start', { cardId: s.card.id, ...(keys.length ? pick : {}) }) }, `Check Lightroom${sel}`) : null,
      h('button', { class: 'btn', 'aria-expanded': String(state.drawer === 'local'),
        onclick: () => { state.drawer = state.drawer === 'local' ? null : 'local'; renderMain(); } }, 'Find local copies'),
      h('button', { class: 'btn', 'aria-expanded': String(state.drawer === 'lightroom'),
        onclick: () => { state.drawer = state.drawer === 'lightroom' ? null : 'lightroom'; renderMain(); } }, `Add to Lightroom${sel}`),
      s.mounted ? h('button', { class: `btn primary`, 'aria-expanded': String(state.drawer === 'import'),
        onclick: () => { state.drawer = state.drawer === 'import' ? null : 'import'; renderMain(); } }, `Import${sel}`) : null),
    grid(`card-${unit}`, [
      { label: s.mounted ? h('input', { type: 'checkbox', checked: allSel, 'aria-label': `Select all ${unit}s shown`,
          // "Select all" means all the rows the filter is showing.
          onchange: (e) => { const shown = gridVisible(`card-${unit}`, rows); for (const g of shown) { if (e.target.checked) state.sel.add(g.key); else state.sel.delete(g.key); } renderMain(); } }) : '',
        sort: false, csv: false, cls: 'check',
        cell: (g) => (s.mounted ? h('input', { type: 'checkbox', checked: state.sel.has(g.key), 'aria-label': `Select ${g.key}`,
          onchange: (e) => { if (e.target.checked) state.sel.add(g.key); else state.sel.delete(g.key); renderMain(); } }) : null) },
      { label: byDate ? 'Date' : 'Card folder', cls: 'date', value: (g) => g.key, cell: (g) => h('button', { class: 'link', onclick: () =>
          openFiles(byDate ? { cardId: s.card.id, date: g.key } : { cardId: s.card.id, folder: g.key }, g.key, `${title}, ${byDate ? 'taken on this date' : 'in this card folder'}`) }, g.key) },
      { label: byDate ? 'Shoot' : 'Dates', cell: (g) => (byDate ? g.shoots.join(', ') : g.firstDate === g.lastDate ? g.firstDate : `${g.firstDate} to ${g.lastDate}`) },
      { label: 'Files', num: true, value: (g) => g.count, cell: (g) => g.count },
      { label: 'Size', num: true, value: (g) => g.bytes, cell: (g) => bytes(g.bytes) },
      { label: 'Copied', num: true, value: (g) => g.copied, text: (g) => `${g.copied} of ${g.count}`, cell: (g) => tally(g.copied, g.count) },
      { label: 'In Lightroom', num: true, value: (g) => g.lightroom, text: (g) => `${g.lightroom} of ${g.count}`, cell: (g) => tally(g.lightroom, g.count) },
      { label: '2+ verified copies', num: true, value: (g) => g.safe, text: (g) => `${g.safe} of ${g.count}`, cell: (g) => tally(g.safe, g.count) },
    ], rows, { name: `${cardName(s.card)} by ${unit}` }),
  ]), s.mounted && state.drawer === 'import' ? importPanel(s, rows, keys, unit)
    : state.drawer === 'lightroom' ? lightroomPanel(s, rows, keys, unit)
    : state.drawer === 'local' ? localPanel(s) : null)];
}

function filesView() {
  const f = state.files;
  const rows = f.rows;
  const total = rows ? rows.reduce((n, r) => n + r.size, 0) : 0;
  return [
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async () => { state.view = f.back; if (f.back === 'map') await loadMap(); render(); } }, 'Back'),
      h('h1', {}, f.title)),
    h('p', { class: 'lede' }, rows ? `${rows.length} file${rows.length === 1 ? '' : 's'}, ${bytes(total)}. ${f.sub || ''}` : 'Loading'),
    rows && grid('files', [
      { label: 'Preview', sort: false, csv: false, cls: 'thumbcell', cell: (r) => thumb(r) },
      { label: 'File', value: (r) => r.name, text: (r) => [r.name, r.shoot].filter(Boolean).join(' · '), cell: (r) => [r.name, r.shoot ? h('div', { class: 'none' }, r.shoot) : null,
        r.openPath ? h('div', {}, h('button', { class: 'link', onclick: () => openFile(r.openPath) }, 'Open')) : null] },
      { label: 'Card folder', cell: (r) => r.folder },
      { label: 'Size', num: true, value: (r) => r.size, text: (r) => r.size, cell: (r) => bytes(r.size) },
      { label: 'Taken', cls: 'date', value: (r) => r.mtime, text: (r) => dateTime(r.mtime), cell: (r) => dateTime(r.mtime) },
      { label: 'Checksum', value: (r) => r.sha256 || '', cell: (r) => (r.sha256 ? h('code', { title: `SHA-256: ${r.sha256}` }, r.sha256.slice(0, 12)) : h('span', { class: 'none' }, 'Not read yet')) },
      { label: 'Copies', num: false, value: (r) => r.locations.length, text: (r) => r.locations.map((l) => `${KIND[l.kind] || l.kind}: ${l.path}`).join('; '),
        cell: (r) => (r.locations.length ? r.locations.map(locRow) : h('span', { class: 'none' }, 'Only on the card')) },
    ], rows, { name: f.title, cls: 'files' }),
  ];
}

function mapView() {
  const rows = state.mapRows;
  return [
    h('h1', {}, 'Where things are'),
    h('p', { class: 'lede' }, 'Every date from every card, and each folder those files were verified in. Click a date or a file count to see the files.'),
    resultNotice(),
    !rows
      ? h('p', { class: 'lede' }, 'Loading')
      : grid('map', [
          { label: 'Date', cls: 'date', value: (r) => r.date, cell: (r) => h('button', { class: 'link', onclick: () =>
            openFiles({ cardId: r.cardId, date: r.date }, r.date, `From ${r.cardLabel} (${r.cardSerial}).`) }, r.date) },
          { label: 'Shoot', cell: (r) => r.shoots.join(', ') },
          { label: 'Card', value: (r) => r.cardLabel, text: (r) => `${r.cardLabel} ${r.cardSerial}`, cell: (r) => [r.cardLabel, h('div', { class: 'none' }, r.cardSerial)] },
          { label: 'Files', num: true, value: (r) => r.count, cell: (r) => r.count },
          { label: 'Size', num: true, value: (r) => r.bytes, cell: (r) => bytes(r.bytes) },
          { label: 'Where', value: (r) => r.places.length, text: (r) => [...r.places.map((p) => `${KIND[p.kind] || p.kind}: ${p.dir} (${p.count} of ${r.count})`), r.unplaced ? `${r.unplaced} only on the card` : ''].filter(Boolean).join('; '),
            cell: (r) => [
                r.places.map((p) => h('div', { class: 'place' },
                  h('span', { class: 'kind' }, KIND[p.kind] || p.kind),
                  p.virtual
                    ? h('span', { class: 'dir text' }, p.dir)
                    : p.exists
                      ? h('button', { class: 'link dir', title: 'Open this folder', onclick: () => api.invoke('reveal', p.dir) }, p.dir)
                      : p.offline
                        ? h('span', { class: 'dir offline' }, `${p.dir} (not connected: ${p.drive})`)
                        : h('span', { class: 'dir missing' }, `${p.dir} (not found now)`),
                  p.virtual
                    ? h('span', { class: 'n' }, `${p.count} of ${r.count} files`)
                    : h('button', { class: 'link n', title: 'See the files recorded in this folder', onclick: () =>
                        openFiles({ dir: p.dir }, p.dir.slice(p.dir.lastIndexOf('\\') + 1), p.dir) }, `${p.count} of ${r.count} files`))),
                r.unplaced ? h('div', { class: 'none' }, `${r.unplaced} only on the card so far`) : null] },
        ], rows, {
          name: 'Where things are',
          empty: 'Nothing recorded yet. Open a connected card to start.',
          tools: h('button', { class: 'btn', disabled: busy(), onclick: async () => {
            const p = await api.invoke('pickFolder', state.form.dest);
            if (p) run('folderscan:start', p);
          } }, 'Find existing copies in a folder'),
        }),
  ];
}

function settingsView() {
  const st = state.settings;
  const lr = h('input', { type: 'text', value: st.lightroomOriginals || '', placeholder: 'Leave empty to detect automatically' });
  return [
    h('h1', {}, 'Settings'),
    h('p', { class: 'lede' }, 'Where CardMap looks for Lightroom\'s local originals.'),
    h('div', { class: 'card-box' },
      h('div', { class: 'form-grid' },
        h('label', {}, 'Originals folder'), lr,
        h('button', { class: 'btn', onclick: async () => { const p = await api.invoke('pickFolder', lr.value); if (p) lr.value = p; } }, 'Browse')),
      h('div', { class: 'hint' }, (st.lightroomDetected || []).length ? `In use: ${st.lightroomDetected.join('; ')}` : 'No Lightroom originals folder found.'),
      h('div', { class: 'hint' }, (st.lightroomCatalogs || []).length
        ? `Lightroom catalog (read only, used for the Lightroom check): ${st.lightroomCatalogs.join('; ')}`
        : 'No Lightroom catalog found. The Lightroom check will only see recently added files.'),
      h('div', { class: 'row actions' },
        h('button', { class: 'btn primary', onclick: async () => { state.settings = await api.invoke('settings:set', { lightroomOriginals: lr.value.trim() }); renderMain(); } }, 'Save'))
    ),
    h('h2', { class: 'section' }, 'CardMap\'s data'),
    h('div', { class: 'card-box' },
      h('div', {}, 'Everything CardMap records (cards, copies, the library index, the Lightroom cache) is in one file:'),
      h('div', { class: 'row tight dbpath' },
        h('code', { class: 'big' }, st.dbFile || 'unknown'),
        st.dbFile ? h('button', { class: 'link', onclick: () => api.invoke('reveal', st.dbFile.slice(0, st.dbFile.lastIndexOf('\\'))) }, 'Open folder') : null),
      h('div', { class: 'hint' }, st.backupAt
        ? `A complete copy is saved once a day as ${st.backupFile.slice(st.backupFile.lastIndexOf('\\') + 1)} in the same folder. Last saved ${dateTime(st.backupAt)}.`
        : 'A complete copy is saved once a day in the same folder, starting 30 seconds after CardMap opens.'),
      h('div', { class: 'hint' }, 'To copy the database yourself, close CardMap first.')),
  ];
}

// ---------- library index ----------
async function loadIndex() {
  [state.index, state.rules] = await Promise.all([api.invoke('index:status'), api.invoke('index:rules')]);
  state.libFolders = state.index.folders.map((f) => ({ path: f.path, exists: f.exists }));
  if (state.view === 'index') renderMain();
}

function bgLine(p) {
  if (!p) return '';
  const pct = p.bytesTotal ? ` ${Math.floor((p.bytesDone / p.bytesTotal) * 100)}%` : '';
  const count = p.filesTotal ? ` · file ${(p.filesDone || 0).toLocaleString()} of ${p.filesTotal.toLocaleString()}` : '';
  const size = p.bytesTotal ? ` · ${bytes(p.bytesDone)} of ${bytes(p.bytesTotal)} read this run` : '';
  return `${p.label || 'Working'}${pct}${count}${size}`;
}

/** "What the scan looks for": the rules, your prefixes, and the names it actually found. */
function rulesSection(ix) {
  const r = state.rules;
  if (!r) return h('div', { class: 'hint' }, 'Loading what the scan looks for');
  const set = (next) => { state.rules = next; renderMain(); };
  const kb = (n) => (n >= 1024 * 1024 ? `${n / 1024 / 1024} MB` : `${n / 1024} KB`);
  const chips = (list) => h('div', { class: 'chips' }, list.map((x) => h('span', { class: 'chip' }, x)));
  const input = h('input', { type: 'text', placeholder: 'e.g. SMITH_', 'aria-label': 'Prefix to add', maxlength: '24' });
  const add = async () => { if (input.value.trim().length >= 2) set(await api.invoke('index:addPrefix', input.value)); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  const inUse = r.prefixes.filter((p) => p.active).length;

  return h('details', { class: 'rules', open: state.rulesOpen, ontoggle: (e) => { state.rulesOpen = e.target.open; } },
    h('summary', {}, 'What the scan looks for',
      h('span', { class: 'none' }, ` ${inUse} of your own prefixes, ${r.rules.cameraNames.length} built-in camera name patterns, ${r.rules.raw.length + r.rules.still.length + r.rules.video.length} file types`)),

    h('h3', {}, 'Your file name prefixes'),
    h('p', { class: 'hint' }, `The letters before the first number in a file name. Learned ones appear on at least ${r.rules.learnMin} files on your cards or in your Lightroom library. A JPG or video whose name starts with one of these, followed by a number, is kept.`),
    r.prefixes.length
      ? h('table', { class: 'compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Prefix'), h('th', { class: 'num' }, 'Known files'), h('th', {}, 'Example'), h('th', {}, 'From'), h('th', {}, 'Used'), h('th', {}, ''))),
          h('tbody', {}, r.prefixes.map((p) => h('tr', { class: p.active ? '' : 'dim' },
            h('td', {}, h('code', { class: 'big' }, p.prefix)),
            h('td', { class: 'num' }, p.count ? p.count.toLocaleString() : ''),
            h('td', {}, p.example),
            h('td', {}, p.source === 'added' ? 'Added by you' : 'Learned'),
            h('td', {}, p.active ? h('span', { class: 'ok' }, 'Yes') : h('span', { class: 'none' }, 'No')),
            h('td', {}, p.source === 'added'
              ? h('button', { class: 'link', 'aria-label': `Remove ${p.prefix}`, disabled: ix.running, onclick: async () => set(await api.invoke('index:removePrefix', p.prefix)) }, 'Remove')
              : h('button', { class: 'link', 'aria-label': `${p.active ? 'Ignore' : 'Use'} ${p.prefix}`, disabled: ix.running, onclick: async () => set(await api.invoke('index:togglePrefix', p.prefix)) }, p.active ? 'Ignore' : 'Use again'))))))
      : h('p', { class: 'hint' }, 'None learned yet. Read a card or the Lightroom catalog first, or add one below.'),
    h('div', { class: 'row tight addprefix' }, input, h('button', { class: 'btn', disabled: ix.running, onclick: add }, 'Add prefix')),
    h('p', { class: 'hint' }, 'Changes apply the next time you scan.'),

    h('h3', {}, 'Built-in camera, drone and phone names'),
    h('table', { class: 'compact' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Made by'), h('th', {}, 'Looks like'))),
      h('tbody', {}, r.rules.cameraNames.map((c) => h('tr', {}, h('td', {}, c.label), h('td', {}, h('code', { class: 'big' }, c.example)))))),

    h('h3', {}, 'File types'),
    h('p', { class: 'hint' }, 'Raw files are kept wherever they are, whatever they are called.'), chips(r.rules.raw),
    h('p', { class: 'hint' }, `Photos need a matching name and must be at least ${kb(r.rules.minStill)}.`), chips(r.rules.still),
    h('p', { class: 'hint' }, `Videos need a matching name and must be at least ${kb(r.rules.minVideo)}.`), chips(r.rules.video),
    h('p', { class: 'hint' }, 'Anything inside a camera card folder (DCIM, or a name like 100NIKON) is kept without a name check. Every other type, such as PNG, GIF, PSD and TIF, is left out.'),

    h('h3', {}, 'Left out'),
    h('p', { class: 'hint' }, 'Photos and videos with any of these words in the file name:'), chips(r.rules.junkWords),
    h('p', { class: 'hint' }, 'Photos and videos inside a folder with one of these names (raw files there are still kept):'), chips(r.rules.outputFolders),
    h('p', { class: 'hint' }, 'Everything inside a folder with one of these names:'), chips(r.rules.junkFolders),
    h('p', { class: 'hint' }, 'Folders that are never opened:'), chips(r.rules.neverWalked),

    r.found.length ? h('h3', {}, 'Names of the files it found') : null,
    r.found.length ? h('p', { class: 'hint' }, 'The found files grouped by the letters before the first number in their name. This shows which patterns actually matched.') : null,
    r.found.length
      ? h('table', { class: 'compact' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Name starts with'), h('th', { class: 'num' }, 'Files'), h('th', { class: 'num' }, 'Size'),
            h('th', { class: 'num' }, 'Raw'), h('th', { class: 'num' }, 'Photos'), h('th', { class: 'num' }, 'Videos'), h('th', {}, 'Example'))),
          h('tbody', {}, r.found.map((g) => h('tr', {},
            h('td', {}, h('code', { class: 'big' }, g.prefix)), h('td', { class: 'num' }, g.files.toLocaleString()), h('td', { class: 'num' }, bytes(g.bytes)),
            h('td', { class: 'num' }, g.raw || ''), h('td', { class: 'num' }, g.still || ''), h('td', { class: 'num' }, g.video || ''), h('td', {}, g.example)))))
      : null);
}

function indexView() {
  const ix = state.index;
  if (!ix) return [h('h1', {}, 'Library index'), h('p', { class: 'lede' }, 'Loading')];
  const pct = ix.bytes ? Math.floor((ix.hashedBytes / ix.bytes) * 100) : 0;
  const left = ix.files - ix.hashed - ix.failed;
  const anyDrive = ix.drives.some((d) => d.selected);
  const canRun = anyDrive || ix.folders.some((f) => f.exists);
  const setFolders = async (list) => {
    await api.invoke('library:setFolders', list);
    await loadIndex();
  };
  const pctOf = (g) => h('span', { class: g.hashedBytes >= g.bytes ? 'ok' : g.hashedBytes ? 'part' : 'none' }, `${Math.floor((g.hashedBytes / (g.bytes || 1)) * 100)}%`);
  return [
    h('h1', {}, 'Library index'),
    h('p', { class: 'lede' }, 'Finds the photos and video you imported from cameras, drones and phones, and saves a checksum for each. Once a file is indexed, matching it to a card is an instant lookup. Nothing on your drives is changed.'),
    resultNotice(),
    h('div', { class: 'card-box' },
      !ix.files
        ? h('div', {}, 'Nothing found yet. Tick the drives to look through, then press "Scan for imported media".')
        : h('div', {},
            h('strong', {}, `${ix.files.toLocaleString()} photos and videos in the index`), ` (${bytes(ix.bytes)}). `,
            `${ix.hashed.toLocaleString()} indexed so far (${bytes(ix.hashedBytes)}, ${pct}%).`,
            left ? ` ${left.toLocaleString()} still to read.` : ' Everything is indexed.',
            ix.failed ? ` ${ix.failed} could not be read.` : ''),
      ix.files ? h('div', { class: 'usage wide' }, h('progress', { max: ix.bytes || 1, value: ix.hashedBytes, 'aria-label': `${pct}% indexed` })) : null,
      ix.duplicateGroups ? h('div', { class: 'hint' }, `Among indexed files, ${ix.duplicateGroups.toLocaleString()} exist in more than one place. The extra copies take ${bytes(ix.duplicateBytes)}.`) : null,
      h('div', { class: 'hint', id: 'bgline' }, ix.running ? bgLine(state.bg || ix.progress) : ''),
      h('div', { class: 'row actions' },
        ix.running
          ? h('button', { class: 'btn primary', onclick: async () => { await api.invoke('index:stop'); } }, 'Pause')
          : [
              h('button', { class: 'btn', disabled: !canRun, title: 'Quick: lists folders and looks at file names, types and sizes. Reads no file contents.',
                onclick: async () => { await api.invoke('index:scan'); await loadIndex(); } }, 'Scan for imported media'),
              h('button', { class: 'btn primary', disabled: !canRun, title: 'Scans, then reads every found file that has no checksum yet. Slow the first time; you can pause and carry on later.',
                onclick: async () => { await api.invoke('index:start'); await loadIndex(); } }, ix.hashed ? 'Continue indexing' : 'Start indexing'),
            ]),
      h('div', { class: 'hint' }, 'The scan takes a few minutes and runs in the background. Indexing reads each found file once, so the first pass can take many hours; it pauses by itself while an import or a check is running, carries on where it left off, and only re-reads a file if its size or date changes.')),

    h('div', { class: 'row toolbar' }, h('strong', {}, 'Drives to scan')),
    ix.drives.length
      ? h('div', { class: 'checks' }, ix.drives.map((d) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: d.selected, disabled: ix.running, onchange: async (e) => {
            const next = ix.drives.filter((x) => (x.serial === d.serial ? e.target.checked : x.selected)).map((x) => x.serial);
            await api.invoke('index:setDrives', next);
            await loadIndex();
          } }),
          `${d.letter} ${d.label || 'no name'}`)))
      : h('p', { class: 'lede' }, 'No drives found.'),
    rulesSection(ix),

    ix.found.length ? h('div', { class: 'row toolbar spaced' }, h('strong', {}, 'Where imported media was found'),
      h('span', { class: 'none' }, 'Exclude a folder to leave it out of the index.')) : null,
    ix.found.length
      ? grid('found', [
          { label: 'Folder', value: (g) => g.path, cell: (g) => (g.online
            ? h('button', { class: 'link dir', title: 'Open this folder', onclick: () => api.invoke('reveal', g.path) }, g.path)
            : h('span', { class: 'offline' }, g.path)) },
          { label: 'Files', num: true, value: (g) => g.files, cell: (g) => g.files.toLocaleString() },
          { label: 'Size', num: true, value: (g) => g.bytes, cell: (g) => bytes(g.bytes) },
          { label: 'Raw', num: true, value: (g) => g.raw, cell: (g) => g.raw || '' },
          { label: 'Photos', num: true, value: (g) => g.still, cell: (g) => g.still || '' },
          { label: 'Videos', num: true, value: (g) => g.video, cell: (g) => g.video || '' },
          { label: 'Indexed', num: true, value: (g) => Math.floor((g.hashedBytes / (g.bytes || 1)) * 100), text: (g) => `${Math.floor((g.hashedBytes / (g.bytes || 1)) * 100)}%`, cell: pctOf },
          { label: '', sort: false, csv: false, cell: (g) => (g.online && /\\[^\\]+/.test(g.path.slice(2)) ? h('button', { class: 'link', 'aria-label': `Exclude ${g.path}`, disabled: ix.running,
            onclick: async () => { await api.invoke('index:exclude', g.path); await loadIndex(); } }, 'Exclude') : null) },
        ], ix.found, { name: 'Imported media by folder', sort: { col: 2, dir: -1 } })
      : null,

    ix.excluded.length ? h('div', { class: 'row toolbar spaced' }, h('strong', {}, 'Excluded folders')) : null,
    ix.excluded.length ? h('div', { class: 'folderlist' }, ix.excluded.map((p) => h('div', { class: 'folderrow' },
      h('span', { class: 'dir' }, p),
      h('button', { class: 'link', 'aria-label': `Include ${p} again`, onclick: async () => { await api.invoke('index:include', p); await loadIndex(); } }, 'Include again')))) : null,

    h('div', { class: 'row toolbar spaced' }, h('strong', {}, 'Extra folders'), h('span', { class: 'none' }, 'Every photo and video in these is indexed, whatever its name.'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: async () => {
        const p = await api.invoke('pickFolder', '');
        if (p) setFolders([...ix.folders.map((f) => f.path), p]);
      } }, 'Add a folder')),
    ix.folders.length
      ? h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Folder'), h('th', { class: 'num' }, 'Files'), h('th', { class: 'num' }, 'Size'), h('th', {}, 'Indexed'), h('th', {}, ''))),
          h('tbody', {}, ix.folders.map((f) => h('tr', {},
            h('td', {}, f.exists ? f.path : h('span', { class: 'offline' }, `${f.path} (not connected)`)),
            h('td', { class: 'num' }, f.files.toLocaleString()), h('td', { class: 'num' }, f.files ? bytes(f.bytes) : ''),
            h('td', {}, f.files ? pctOf(f) : h('span', { class: 'none' }, 'Not listed yet')),
            h('td', {}, h('button', { class: 'link', 'aria-label': `Remove ${f.path}`, onclick: () => setFolders(ix.folders.filter((x) => x.path !== f.path).map((x) => x.path)) }, 'Remove'))))))
      : h('p', { class: 'lede' }, 'None. Use this for a folder whose files the scan would not recognise.'),
  ];
}

async function loadLightroom() {
  const [status, albums] = await Promise.all([api.invoke('lrcache:status'), api.invoke('lrcache:albums')]);
  state.lr = { status, albums };
  if (state.view === 'lightroom') renderMain();
}

function lightroomView() {
  const lr = state.lr;
  if (!lr) return [h('h1', {}, 'Lightroom library'), h('p', { class: 'lede' }, 'Loading')];
  const st = lr.status;
  const when = st.refreshedAt ? dateTime(Date.parse(st.refreshedAt)) : null;
  const albums = lr.albums;
  return [
    h('h1', {}, 'Lightroom library'),
    h('p', { class: 'lede' }, 'A copy of the details in Lightroom\'s catalog, kept by CardMap. Details only: no pictures and no edits. Lightroom\'s own files are never changed.'),
    resultNotice(),
    h('div', { class: 'card-box' },
      !st.catalogs.length
        ? h('div', {}, 'Lightroom\'s catalog was not found on this computer.')
        : !st.assets
          ? h('div', {}, 'Nothing cached yet. The first read takes about a minute.')
          : h('div', {}, h('strong', {}, `${st.assets.toLocaleString()} photos and videos`), ` (${st.videos.toLocaleString()} videos) in ${st.albums.toLocaleString()} albums.`),
      h('div', { class: 'hint' }, when
        ? `Last read ${when}. ${st.upToDate ? 'Lightroom has not changed its catalog since.' : 'Lightroom has changed its catalog since: refresh to pick up the changes.'}`
        : ''),
      h('div', { class: 'row actions' },
        h('button', { class: 'btn primary', disabled: busy() || !st.catalogs.length, onclick: () => run('lrcache:refresh', false) }, st.assets ? 'Refresh' : 'Read the catalog'),
        h('button', { class: 'btn', disabled: busy() || !st.catalogs.length, title: 'Throw the cached copy away and read everything again',
          onclick: () => run('lrcache:refresh', true) }, 'Rebuild from scratch'))),
    st.assets ? grid('albums', [
      { label: 'Album', cell: (a) => a.path },
      { label: 'Photos', num: true, value: (a) => a.count, cell: (a) => a.count.toLocaleString() },
      { label: 'Originals', num: true, value: (a) => a.bytes, text: (a) => a.bytes, cell: (a) => (a.count ? bytes(a.bytes) : '') },
      { label: 'First taken', cls: 'date', value: (a) => a.first || '', cell: (a) => a.first || '' },
      { label: 'Last taken', cls: 'date', value: (a) => a.last || '', cell: (a) => a.last || '' },
    ], albums, { name: 'Lightroom albums', sort: { col: 4, dir: -1 } }) : null,
  ];
}

// ---------- find a file ----------
async function runLookup() {
  const L = state.lookup;
  const q = L.q.trim();
  const seq = (L.seq = (L.seq || 0) + 1);
  if (q.length < 2) {
    L.res = null;
    drawLookup();
    return;
  }
  L.busy = true;
  drawLookup();
  const res = await api.invoke('lookup', q);
  if (seq !== L.seq) return; // a newer search has started
  L.res = res;
  L.busy = false;
  drawLookup();
}

function placeRow(p) {
  return h('div', { class: `place${p.unconfirmed ? ' unconfirmed' : ''}`, title: p.unconfirmed ? 'Same file name and size as the other copies, but the contents have not been compared yet' : null },
    h('span', { class: 'kind' }, KIND[p.kind] || p.kind),
    p.kind === 'lightroom'
      ? h('span', { class: 'dir text' }, p.label)
      : p.exists && p.path
        ? h('button', { class: 'link dir', title: 'Open the folder', onclick: () => api.invoke('reveal', dirOf(p.path)) }, p.kind === 'card' ? p.label : p.path)
        : p.offline
          ? h('span', { class: 'dir offline' }, p.kind === 'card' ? `${p.label} (card not inserted)` : `${p.label} (not connected: ${p.drive})`)
          : h('span', { class: 'dir missing' }, `${p.label} (not found now)`),
    p.unconfirmed ? h('span', { class: 'n' }, 'name and size match, not compared') : null);
}

/** Draw just the results, so typing in the search box is never interrupted. */
function drawLookup() {
  const box = document.getElementById('lookupres');
  if (!box) return;
  const L = state.lookup;
  if (!L.res) {
    box.replaceChildren(h('p', { class: 'lede' }, L.busy ? 'Searching' : 'Type at least two characters.'));
    return;
  }
  const r = L.res;
  box.replaceChildren(...[
    r.truncated ? h('div', { class: 'notice' }, 'Lots of matches: only the first ones are shown. Type more to narrow it down.') : null,
    grid('lookup', [
      { label: 'File', value: (g) => g.names[0], text: (g) => g.names.join(' / '), cell: (g) => [g.names.join(' / '),
        g.openPath ? h('div', {}, h('button', { class: 'link', onclick: () => openFile(g.openPath) }, 'Open')) : null] },
      { label: 'Size', num: true, value: (g) => g.size, cell: (g) => (g.size ? bytes(g.size) : '') },
      { label: 'Date', cls: 'date', value: (g) => g.date || '', cell: (g) => g.date || '' },
      { label: 'Checksum', value: (g) => g.sha256 || '', cell: (g) => (g.sha256 ? h('code', { title: `SHA-256: ${g.sha256}` }, g.sha256.slice(0, 12)) : h('span', { class: 'none' }, 'Not read yet')) },
      { label: 'Copies', num: true, value: (g) => g.copies, cell: (g) => g.copies },
      { label: 'Where', value: (g) => g.places.length, text: (g) => g.places.map((p) => `${KIND[p.kind] || p.kind}: ${p.label}${p.unconfirmed ? ' (name and size match, not compared)' : ''}`).join('; '),
        cell: (g) => h('div', { class: 'places' }, g.places.map(placeRow)) },
    ], r.groups, { name: `Find ${L.q.trim()}`, empty: 'No file matches that.' }),
  ].filter(Boolean));
}

function lookupView() {
  const L = state.lookup || (state.lookup = { q: '', res: null });
  const input = h('input', { type: 'search', id: 'lookupq', value: L.q, 'aria-label': 'Find a file',
    placeholder: 'File name, part of a path, a checksum, or a date like 2026-05-06',
    oninput: (e) => { L.q = e.target.value; clearTimeout(L.t); L.t = setTimeout(runLookup, 300); },
    onkeydown: (e) => { if (e.key === 'Enter') { clearTimeout(L.t); runLookup(); } } });
  setTimeout(() => { input.focus(); drawLookup(); }, 0);
  return [
    h('h1', {}, 'Find a file'),
    h('p', { class: 'lede' }, 'Searches files on your cards, the files in your library folders, and your Lightroom library. Each result shows every place that file is, matched by checksum, whatever it is called there.'),
    h('div', { class: 'row lookupbar' }, input),
    h('div', { id: 'lookupres' }),
  ];
}

function welcomeView() {
  return [
    h('h1', {}, 'CardMap'),
    h('p', { class: 'lede' }, 'Pick a connected card on the left to import it, or open "Where things are" to see the map.'),
  ];
}

function renderMain() {
  const views = { lookup: lookupView, card: cardView, files: filesView, map: mapView, index: indexView, lightroom: lightroomView, settings: settingsView, welcome: welcomeView };
  document.getElementById('main').replaceChildren(...views[state.view]().flat(Infinity).filter(Boolean));
}

function renderJob() {
  const bar = document.getElementById('jobbar');
  const j = state.job;
  if (!j) { bar.hidden = true; return; }
  bar.hidden = false;
  const hasBytes = j.bytesTotal > 0;
  const max = hasBytes ? j.bytesTotal : j.filesTotal || 0;
  const val = hasBytes ? j.bytesDone : j.filesDone || 0;
  bar.replaceChildren(...[
    h('span', { class: 'label' }, j.label || 'Working'),
    j.filesTotal ? h('span', { class: 'count' }, `${j.filesDone || 0} of ${j.filesTotal}${hasBytes ? ` · ${bytes(j.bytesDone)} of ${bytes(j.bytesTotal)}` : ''}`) : null,
    max ? h('progress', { max, value: val }) : h('progress', {}),
    h('button', { class: 'btn', onclick: () => api.invoke('job:cancel') }, 'Cancel'),
  ].filter(Boolean));
}

function render() {
  renderSidebar();
  renderMain();
  renderJob();
}

// ---------- events ----------
api.on('cards', (cards) => {
  state.cards = cards;
  renderSidebar();
});

// Progress from the background indexer. Updates two small bits of text in place, so
// the page does not jump while you are using it.
api.on('bg', async (p) => {
  if (p.done) {
    state.bg = null;
    const x = p.result;
    if (p.error && p.error !== 'Stopped') state.lastResult = { error: `Indexing stopped: ${p.error}` };
    else if (x && x.scanOnly && state.view === 'index') {
      state.lastResult = { info: `Scan ${x.cancelled ? 'stopped early' : 'finished'}: ${x.files.toLocaleString()} imported photos and videos found (${bytes(x.bytes)}). ${x.leftOut.toLocaleString()} other photo and video files were left out as screenshots, exports, stock or junk.` };
    } else if (x && state.view === 'index') {
      state.lastResult = { info: `Indexing ${x.cancelled ? 'paused' : 'finished'}: ${x.hashed.toLocaleString()} files (${bytes(x.bytes)}) read this run.`
        + (x.linked ? ` ${x.linked} turned out to be copies of card files and were recorded.` : '')
        + (x.offline ? ` ${x.offline.toLocaleString()} are on drives that are not connected.` : '')
        + (x.failed ? ` ${x.failed} could not be read.` : '') };
    }
    renderSidebar();
    if (state.view === 'index') await loadIndex();
    await refreshSummary();
    if (state.view === 'card') renderMain();
    return;
  }
  const first = !state.bg;
  state.bg = p;
  const nav = document.getElementById('navbg');
  if (nav) nav.textContent = `${p.paused ? 'Paused' : 'Indexing'}${p.bytesTotal ? ` ${Math.floor((p.bytesDone / p.bytesTotal) * 100)}%` : ''}`;
  const line = document.getElementById('bgline');
  if (line) line.textContent = bgLine(p);
  if (first && state.view === 'index') loadIndex();
});

// A drive has come back under a different letter and its saved locations were updated.
api.on('volumes', async ({ moved }) => {
  state.lastResult = { info: `A drive is connected under a different letter than before. ${moved} saved location${moved === 1 ? ' was' : 's were'} updated to the new letter.` };
  await refreshSummary();
  if (state.view === 'map') await loadMap();
  if (state.view === 'files') state.files.rows = await api.invoke('files', state.files.query);
  render();
});

api.on('job', async (p) => {
  if (p.done) {
    state.job = null;
    if (!p.silent || p.error) state.lastResult = p;
    await refreshSummary();
    if (state.view === 'map') await loadMap();
    if (state.view === 'lightroom') await loadLightroom();
    if (state.view === 'index') await loadIndex();
    if (state.view === 'files') state.files.rows = await api.invoke('files', state.files.query);
    render();
    return;
  }
  const starting = !state.job;
  state.job = { ...(state.job || {}), ...p };
  if (starting) renderMain(); // disable the action buttons
  renderJob();
});

(async () => {
  state.settings = await api.invoke('settings:get');
  state.form.dest = state.settings.dest || '';
  state.form.backup = state.settings.backup || '';
  await loadCards();
  render();
})();
