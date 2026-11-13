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

const KIND = { primary: 'Main copy', backup: 'Backup', lightroom: 'Lightroom', found: 'Found' };
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
    h('button', { class: `nav-item${state.view === 'map' || (state.view === 'files' && state.files.back === 'map') ? ' active' : ''}`, onclick: () => show('map') }, h('span', { class: 'grow' }, 'Where things are')),
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
  render();
}
// Development hook used by the screenshot aid in main.js.
window.__show = (v) => {
  if (v.startsWith('import:')) { state.drawer = 'import'; return openMounted(v.slice(7)); }
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
  } else if (r.kind === 'lrcache') {
    text = x.changed
      ? `Lightroom's catalog was read: ${x.read.toLocaleString()} changed entries picked up. The cache now holds ${x.assets.toLocaleString()} photos and videos in ${x.albums.toLocaleString()} albums.`
      : 'Already up to date: Lightroom has not changed its catalog since the last read.';
  } else if (r.kind === 'folderscan') {
    text = `Search${x.cancelled ? ' cancelled' : ' finished'}: ${x.scanned.toLocaleString()} files looked at. ${x.filesWithCopies} card file${x.filesWithCopies === 1 ? ' has' : 's have'} a matching local copy (${x.matched} newly recorded, ${x.alreadyKnown} already known).`;
    if (x.renamed) text += ` ${x.renamed} of the new matches had a different file name.`;
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
      h('li', {}, 'Nothing is copied, moved or changed. Matches are recorded and show up in the Copied column.')),

    h('h3', {}, h('span', { class: 'step' }, '2'), 'Where to look'),
    list,
    h('button', { class: 'btn wide', onclick: async () => {
      const p = await api.invoke('pickFolder', '');
      if (!p) return;
      state.libFolders = await api.invoke('library:setFolders', [...(state.libFolders || []).map((x) => x.path), p]);
      draw();
    } }, 'Add a folder or drive'),
    h('div', { class: 'hint' }, 'These folders are remembered for next time. A whole drive works too, it just takes longer.'),

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
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { class: 'check' }, s.mounted ? h('input', { type: 'checkbox', checked: allSel, 'aria-label': `Select all ${unit}s`,
          onchange: (e) => { state.sel = new Set(e.target.checked ? rows.map((g) => g.key) : []); renderMain(); } }) : null),
        h('th', {}, byDate ? 'Date' : 'Card folder'), h('th', {}, byDate ? 'Shoot' : 'Dates'), h('th', { class: 'num' }, 'Files'), h('th', { class: 'num' }, 'Size'),
        h('th', {}, 'Copied'), h('th', {}, 'In Lightroom'), h('th', {}, '2+ verified copies'))),
      h('tbody', {}, rows.map((g) => h('tr', {},
        h('td', { class: 'check' }, s.mounted ? h('input', { type: 'checkbox', checked: state.sel.has(g.key), 'aria-label': `Select ${g.key}`,
          onchange: (e) => { e.target.checked ? state.sel.add(g.key) : state.sel.delete(g.key); renderMain(); } }) : null),
        h('td', { class: 'date' }, h('button', { class: 'link', onclick: () =>
          openFiles(byDate ? { cardId: s.card.id, date: g.key } : { cardId: s.card.id, folder: g.key }, g.key, `${title}, ${byDate ? 'taken on this date' : 'in this card folder'}`) }, g.key)),
        h('td', {}, byDate ? g.shoots.join(', ') : g.firstDate === g.lastDate ? g.firstDate : `${g.firstDate} to ${g.lastDate}`),
        h('td', { class: 'num' }, g.count), h('td', { class: 'num' }, bytes(g.bytes)),
        h('td', {}, tally(g.copied, g.count)), h('td', {}, tally(g.lightroom, g.count)), h('td', {}, tally(g.safe, g.count))
      )))
    ),
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
    rows && h('table', { class: 'files' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Preview'), h('th', {}, 'File'), h('th', {}, 'Card folder'), h('th', { class: 'num' }, 'Size'), h('th', {}, 'Taken'),
        h('th', {}, 'Checksum'), h('th', {}, 'Copies'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'thumbcell' }, thumb(r)),
        h('td', {}, r.name, r.shoot ? h('div', { class: 'none' }, r.shoot) : null,
          r.openPath ? h('div', {}, h('button', { class: 'link', onclick: () => openFile(r.openPath) }, 'Open')) : null),
        h('td', {}, r.folder),
        h('td', { class: 'num' }, bytes(r.size)),
        h('td', { class: 'date' }, dateTime(r.mtime)),
        h('td', {}, r.sha256 ? h('code', { title: `SHA-256: ${r.sha256}` }, r.sha256.slice(0, 12)) : h('span', { class: 'none' }, 'Not read yet')),
        h('td', {}, r.locations.length
          ? r.locations.map(locRow)
          : h('span', { class: 'none' }, 'Only on the card'))
      )))
    ),
  ];
}

function mapView() {
  const rows = state.mapRows;
  return [
    h('h1', {}, 'Where things are'),
    h('p', { class: 'lede' }, 'Every date from every card, and each folder those files were verified in. Click a date or a file count to see the files.'),
    resultNotice(),
    h('div', { class: 'row toolbar' },
      h('input', { type: 'search', id: 'mapq', value: state.mapQuery, placeholder: 'Search by file name, shoot, date, card or folder',
        'aria-label': 'Search the map',
        onkeydown: (e) => { if (e.key === 'Enter') { state.mapQuery = e.target.value.trim(); loadMap(); } } }),
      h('button', { class: 'btn', onclick: () => { state.mapQuery = document.getElementById('mapq').value.trim(); loadMap(); } }, 'Search'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', disabled: busy(), onclick: async () => {
        const p = await api.invoke('pickFolder', state.form.dest);
        if (p) run('folderscan:start', p);
      } }, 'Find existing copies in a folder')
    ),
    !rows
      ? h('p', { class: 'lede' }, 'Loading')
      : !rows.length
        ? h('p', { class: 'lede' }, state.mapQuery ? 'Nothing matches that search.' : 'Nothing recorded yet. Open a connected card to start.')
        : h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Shoot'), h('th', {}, 'Card'), h('th', { class: 'num' }, 'Files'), h('th', { class: 'num' }, 'Size'), h('th', {}, 'Where'))),
            h('tbody', {}, rows.map((r) => h('tr', {},
              h('td', { class: 'date' }, h('button', { class: 'link', onclick: () =>
                openFiles({ cardId: r.cardId, date: r.date }, r.date, `From ${r.cardLabel} (${r.cardSerial}).`) }, r.date)),
              h('td', {}, r.shoots.join(', ')),
              h('td', {}, r.cardLabel, h('div', { class: 'none' }, r.cardSerial)),
              h('td', { class: 'num' }, r.count), h('td', { class: 'num' }, bytes(r.bytes)),
              h('td', {},
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
                r.unplaced ? h('div', { class: 'none' }, `${r.unplaced} only on the card so far`) : null)
            )))
          ),
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
  const q = (state.lrQuery || '').toLowerCase();
  const albums = q ? lr.albums.filter((a) => a.path.toLowerCase().includes(q)) : lr.albums;
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
    st.assets ? h('div', { class: 'row toolbar' },
      h('input', { type: 'search', value: state.lrQuery || '', placeholder: 'Filter albums by name', 'aria-label': 'Filter albums',
        oninput: (e) => { state.lrQuery = e.target.value; clearTimeout(state.lrTimer); state.lrTimer = setTimeout(() => {
          renderMain(); const el = document.querySelector('.toolbar input[type=search]'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        }, 250); } }),
      h('span', { class: 'none' }, `${albums.length} album${albums.length === 1 ? '' : 's'}`)) : null,
    st.assets ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Album'), h('th', { class: 'num' }, 'Photos'), h('th', { class: 'num' }, 'Originals'), h('th', {}, 'Taken'))),
      h('tbody', {}, albums.slice(0, 400).map((a) => h('tr', {},
        h('td', {}, a.path), h('td', { class: 'num' }, a.count), h('td', { class: 'num' }, a.count ? bytes(a.bytes) : ''),
        h('td', { class: 'date' }, !a.first ? '' : a.first === a.last ? a.first : `${a.first} to ${a.last}`))))) : null,
    albums.length > 400 ? h('p', { class: 'lede' }, `Showing the first 400 of ${albums.length}. Filter to narrow it down.`) : null,
  ];
}

function welcomeView() {
  return [
    h('h1', {}, 'CardMap'),
    h('p', { class: 'lede' }, 'Pick a connected card on the left to import it, or open "Where things are" to see the map.'),
  ];
}

function renderMain() {
  const views = { card: cardView, files: filesView, map: mapView, lightroom: lightroomView, settings: settingsView, welcome: welcomeView };
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
