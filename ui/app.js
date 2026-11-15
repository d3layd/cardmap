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
  form: { shoot: '', dest: '', backup: '', extra: [], thenLightroom: false },
  settings: {},
  job: null,
  lastResult: null,
  mapQuery: '',
  mapRows: null,
  files: null, // { title, sub, back, query, rows }
  cardBg: {}, // card serial -> progress of its background checksum reading
  newDrives: [], // connected drives not yet in the index or dismissed
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

const KIND = { primary: 'Main copy', backup: 'Backup', extra: 'Extra copy', lightroom: 'Lightroom', found: 'Found', card: 'On card', index: 'In folder' };
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
  state.fileSel = new Set();
  state.fileSelLast = null;
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
      h('span', { class: 'grow' }, 'Library index', h('div', { class: 'sub', id: 'navbg' }, state.bg ? `Indexing${state.bg.bytesTotal ? ` ${Math.floor((state.bg.bytesDone / state.bg.bytesTotal) * 100)}%` : ''}` : state.newDrives.length ? `New drive connected` : ''))),
    h('button', { class: `nav-item${state.view === 'allfiles' ? ' active' : ''}`, onclick: () => show('allfiles') }, h('span', { class: 'grow' }, 'All files')),
    h('button', { class: `nav-item${state.view === 'dupes' ? ' active' : ''}`, onclick: () => show('dupes') }, h('span', { class: 'grow' }, 'Duplicates')),
    h('button', { class: `nav-item${state.view === 'projects' ? ' active' : ''}`, onclick: () => show('projects') }, h('span', { class: 'grow' }, 'Projects')),
    h('button', { class: `nav-item${state.view === 'rules' ? ' active' : ''}`, onclick: () => show('rules') }, h('span', { class: 'grow' }, 'Rules')),
    h('button', { class: `nav-item${state.view === 'reconcile' ? ' active' : ''}`, onclick: () => show('reconcile') }, h('span', { class: 'grow' }, 'Drives')),
    h('button', { class: `nav-item${state.view === 'compare' ? ' active' : ''}`, onclick: () => show('compare') }, h('span', { class: 'grow' }, 'Compare')),
    h('button', { class: `nav-item${state.view === 'nearmatch' ? ' active' : ''}`, onclick: () => show('nearmatch') }, h('span', { class: 'grow' }, 'Near matches')),
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
  if (view === 'dupes') loadDupes(true);
  if (view === 'allfiles') loadAllFiles();
  if (view === 'reconcile') loadReconcile();
  if (view === 'rules') loadRules();
  if (view === 'projects') loadProjects();
  if (view === 'compare') loadCompare();
  if (view === 'nearmatch') loadNearMatch();
  if (view === 'lightroom') loadEdits();
  render();
}
// Development hook used by the screenshot aid in main.js.
window.__show = (v) => {
  if (v.startsWith('import:')) { state.drawer = 'import'; return openMounted(v.slice(7)); }
  if (v.startsWith('allfiles:')) { state.allFiles = { show: v.slice(9), q: '' }; return show('allfiles'); }
  if (v.startsWith('dupes:')) { state.dupeTab = v.slice(6); return show('dupes'); }
  if (v.startsWith('lookup:')) { state.lookup = { q: v.slice(7), res: null }; show('lookup'); return runLookup(); }
  if (v === 'scanrules') { state.rulesOpen = true; return show('index'); }
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
    if (x.groups) text += ` By group: ${x.groups.map((g) => `${[g.profile, g.shoot].filter(Boolean).join(': ')} ${g.lightroomOnly ? `${g.lightroomOnly} for Lightroom only` : `${g.copied} copied`}`).join('; ')}.`;
    const lo = x.leftOut || {};
    if (lo.skip || lo.unready) text += ` Left out: ${[lo.skip ? `${lo.skip} marked skip` : '', lo.unready ? `${lo.unready} not marked ready` : ''].filter(Boolean).join(', ')}.`;
  } else if (r.kind === 'lightroom') {
    const known = x.alreadyFound || 0;
    text = `Lightroom check${x.cancelled ? ' cancelled' : ''}: ${x.found + known} of ${x.checked + known} files are in the Lightroom library, ${x.notFound} are not.`;
    if (known) text += ` ${known} of them were already matched on an earlier check${x.found ? `, ${x.found} are new` : ''}.`;
    if (x.notUploaded) text += ` ${x.notUploaded} are in the catalog but their upload is not confirmed.`;
    if (x.unverifiable) text += ` ${x.unverifiable} might be there but need the card inserted to confirm.`;
    text += x.method === 'catalog'
      ? ` Compared by checksum against ${x.catalogAssets} photos and videos in Lightroom's catalog.`
      : " Lightroom's catalog was not found, so only its local cache of recent files was checked.";
  } else if (r.kind === 'copyplan') {
    text = `${x.cancelled ? 'Copying stopped' : 'Second copies finished'}: ${x.copied} copied and verified, ${x.already} already there, ${x.failed} failed.`;
    if (x.skippedDifferent) text += ` ${x.skippedDifferent} left alone because a different file with that name is already there.`;
    if (x.needsRescan) text += ' Scan the destination drive so the new copies are indexed.';
  } else if (r.kind === 'dupes') {
    text = `Report built: ${bytes(x.safeBytes)} safe to delete, ${bytes(x.oneDiskBytes)} of extra copies on one disk.`;
  } else if (r.kind === 'recheck') {
    text = `Re-checked ${x.checked.toLocaleString()} copies: ${x.same.toLocaleString()} still match.`;
    if (x.changed) text += ` ${x.changed} no longer match and have been taken off the lists: ${x.changedPaths.slice(0, 5).join('; ')}${x.changedPaths.length > 5 ? ' and more' : ''}.`;
    if (x.unreadable) text += ` ${x.unreadable} could not be read.`;
    text += ' The report has been rebuilt.';
  } else if (r.kind === 'inventory') {
    text = `File list updated${x.cancelled ? ' (stopped early)' : ''}: ${x.files.toLocaleString()} files, ${bytes(x.bytes)}. ${x.added.toLocaleString()} new, ${x.changed.toLocaleString()} changed, ${x.removed.toLocaleString()} no longer there.`;
    if (x.skippedFolders && x.skippedFolders.length) text += ` Not connected, so skipped: ${x.skippedFolders.join(', ')}.`;
  } else if (r.kind === 'lrcache') {
    text = x.changed
      ? `Lightroom's catalog was read: ${x.read.toLocaleString()} changed entries picked up. The cache now holds ${x.assets.toLocaleString()} photos and videos in ${x.albums.toLocaleString()} albums.`
      : 'Already up to date: Lightroom has not changed its catalog since the last read.';
  } else if (r.kind === 'lredits') {
    text = `Lightroom archive ${x.cancelled ? 'stopped' : 'saved'} in ${x.dest}: details of ${x.photos.toLocaleString()} photos in lightroom-catalog.json, and ${x.written.toLocaleString()} edit files.`;
    if (x.alreadyArchived) text += ` ${x.alreadyArchived.toLocaleString()} edits were already in the archive.`;
    if (x.cloudOnly) text += ` ${x.cloudOnly.toLocaleString()} edited photos have their edits only in Lightroom's cloud, so they could not be saved from here.`;
    if (x.sidecars || x.sidecarsSame || x.sidecarsKept) text += ` ${x.sidecars} .xmp files put next to raw files${x.sidecarsSame ? `, ${x.sidecarsSame} were already there` : ''}${x.sidecarsKept ? `, ${x.sidecarsKept} left alone because a different .xmp was already there` : ''}.`;
    if (x.sidecarsOffline) text += ` ${x.sidecarsOffline} raw copies are on drives that are not connected.`;
    if (x.failed) text += ` ${x.failed} could not be written.`;
  } else if (r.kind === 'lrpair') {
    text = `Lightroom export paired: ${x.matched.toLocaleString()} of ${x.xmp.toLocaleString()} .xmp files matched to Lightroom photos and saved in the archive.`;
    if (x.sidecars || x.sidecarsSame || x.sidecarsKept) text += ` ${x.sidecars} put next to your raw files${x.sidecarsSame ? `, ${x.sidecarsSame} were already there` : ''}${x.sidecarsKept ? `, ${x.sidecarsKept} left alone because a different .xmp was already there` : ''}.`;
    if (x.sidecarsOffline) text += ` ${x.sidecarsOffline} raw copies are on drives that are not connected.`;
    if (x.unmatched) text += ` ${x.unmatched} did not match a Lightroom photo by name and size (for example ${x.unmatchedNames.slice(0, 3).join(', ')}).`;
  } else if (r.kind === 'folderscan') {
    text = `Match${x.cancelled ? ' cancelled' : ' finished'}: checked against ${(x.indexed ?? x.scanned).toLocaleString()} indexed files. ${x.filesWithCopies} card file${x.filesWithCopies === 1 ? ' has' : 's have'} a matching local copy (${x.matched} newly recorded, ${x.alreadyKnown} already known).`;
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
  const ready = chosen.reduce((n, g) => n + g.ready, 0);
  const skip = chosen.reduce((n, g) => n + g.skip, 0);
  // With files marked ready, import only those unless the box is unticked.
  const onlyReady = ready > 0 && state.form.onlyReady !== false;
  const marked = ready > 0 || skip > 0;
  const eligible = onlyReady ? ready : count - skip;
  const pick = keys.length ? (unit === 'date' ? { dates: keys } : { folders: keys }) : { dates: s.groups.map((g) => g.key) };
  // Dates the chosen rows cover, for the folder preview. Known exactly when grouped by date.
  const dates = unit === 'date' ? chosen.map((g) => g.key) : keys.length ? null : s.groups.map((g) => g.key);
  const preview = h('div', { class: 'preview' });
  const refresh = () => {
    const shoot = state.form.shoot.replace(/[<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim();
    const folder = (d) => (shoot ? `${d} ${shoot}` : d);
    const roots = [['Main copy', state.form.dest], ['Backup', state.form.backup],
      ...state.form.extra.map((p, i) => [`Extra copy ${i + 1}`, p])].filter(([, p]) => p);
    if (!roots.length) {
      preview.replaceChildren(h('div', { class: 'none' }, 'Choose a "Copy to" folder to see where the files will go.'));
      return;
    }
    const names = dates ? dates.slice().sort().map(folder) : [folder('<capture date>')];
    const notes = roots.map(() => h('span', { class: 'none' }));
    api.invoke('folders:state', roots.map(([, p]) => p)).then((states) => states.forEach((st, i) => {
      notes[i].textContent = st === 'new' ? ' (new folder, will be created)' : st === 'offline' ? ' (drive not connected)' : '';
      notes[i].className = st === 'offline' ? 'part' : 'none';
    }));
    preview.replaceChildren(...roots.map(([label, root], i) => h('div', { class: 'tree' },
      h('div', { class: 'none' }, label),
      h('div', { class: 'root' }, root, notes[i]),
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

    groupsSection(s),
    h('h3', {}, h('span', { class: 'step' }, '1'), 'What gets copied'),
    h('div', { class: 'what' },
      h('strong', {}, keys.length ? `${keys.length} selected ${unit}${keys.length === 1 ? '' : 's'}` : 'The whole card'),
      h('div', { class: 'none' }, `${count} files, ${bytes(size)}. ${todo === 0 ? 'All of them are already copied.' : todo === count ? 'None copied yet.' : `${count - todo} already copied, ${todo} still to copy.`}`),
      keys.length ? null : h('div', { class: 'none' }, 'To copy only part of the card, tick rows in the table, or open a date or folder and mark files ready or skip.'),
      skip ? h('div', { class: 'none' }, `${skip} file${skip === 1 ? '' : 's'} marked skip will be left out.`) : null,
      ready ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: onlyReady,
        onchange: (e) => { state.form.onlyReady = e.target.checked; renderMain(); } }),
        ` Only copy the ${ready} file${ready === 1 ? '' : 's'} marked ready`) : null),

    h('h3', {}, h('span', { class: 'step' }, '2'), 'Where it goes'),
    h('div', { class: 'field' }, h('label', {}, 'Shoot name (optional, added to each folder name)'),
      h('input', { type: 'text', value: state.form.shoot, placeholder: 'e.g. Smith Wedding', 'aria-label': 'Shoot name', oninput: onForm('shoot') })),
    folderInput('Copy to', 'dest', 'Folder for the main copy'),
    folderInput('Backup to (optional second copy)', 'backup', 'Ideally on a different drive'),
    state.form.extra.map((p, i) => {
      const input = h('input', { type: 'text', value: p, placeholder: 'Another folder that gets a copy', 'aria-label': `Extra copy ${i + 1}`,
        oninput: (e) => { state.form.extra[i] = e.target.value.trim(); refresh(); } });
      return h('div', { class: 'field' }, h('label', {}, `Also copy to (extra copy ${i + 1})`),
        h('div', { class: 'row tight' }, input,
          h('button', { class: 'btn', onclick: async () => {
            const picked = await api.invoke('pickFolder', state.form.extra[i] || state.form.dest);
            if (picked) { state.form.extra[i] = picked; input.value = picked; refresh(); }
          } }, 'Browse'),
          h('button', { class: 'btn', 'aria-label': `Remove extra copy ${i + 1}`, onclick: () => { state.form.extra.splice(i, 1); renderMain(); } }, 'Remove')));
    }),
    h('div', { class: 'field' },
      h('button', { class: 'btn', onclick: () => { state.form.extra.push(''); renderMain(); } }, 'Add another destination'),
      h('div', { class: 'none' }, 'Type a path that does not exist yet to make a new folder, or use New folder in Browse.')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.form.thenLightroom,
      onchange: (e) => { state.form.thenLightroom = e.target.checked; } }),
      ' Then open Add to Lightroom for these files'),
    h('div', { class: 'field' }, h('label', {}, 'Folders that will be used'), preview),

    h('h3', {}, h('span', { class: 'step' }, '3'), 'What happens when you start'),
    h('ul', { class: 'steps' },
      h('li', {}, 'Each file is copied into a folder for the day it was taken, in every destination above.'),
      h('li', {}, 'Every copy is read back and compared with the card. Only matching copies are recorded.'),
      h('li', {}, 'Files that are already copied are skipped, so it is safe to run again.'),
      h('li', {}, 'Nothing on the card is changed or deleted.')),
    h('button', { class: 'btn primary wide', disabled: busy() || !eligible,
      onclick: () => run('import:start', { cardId: s.card.id, ...pick, onlyReady, shoot: state.form.shoot.trim(), dest: state.form.dest, backup: state.form.backup, extra: state.form.extra.filter(Boolean) }) },
      !eligible ? (onlyReady ? 'No files marked ready' : 'Every file here is marked skip')
        : marked ? `Import ${eligible} file${eligible === 1 ? '' : 's'}`
        : todo === 0 ? `Check ${count} files again` : `Copy and verify ${todo} file${todo === 1 ? '' : 's'}`));
}

const markText = (g) => [g.ready ? `${g.ready} ready` : '', g.skip ? `${g.skip} skip` : ''].filter(Boolean).join(', ');
const MARK_LOG = { ready: 'Marked ready', skip: 'Marked skip', clear: 'Mark cleared', import: 'Import' };

/** The card's log: every mark change and import, newest first. */
function logPanel(s) {
  const box = h('div', {}, h('div', { class: 'none' }, 'Loading'));
  api.invoke('card:log', s.card.id).then((rows) => {
    box.replaceChildren(grid('cardlog', [
      { label: 'When', cls: 'date', value: (r) => r.at, cell: (r) => dateTime(Date.parse(r.at)) },
      { label: 'What', value: (r) => r.action, cell: (r) => MARK_LOG[r.action] || r.action },
      { label: 'File', value: (r) => r.name || '', cell: (r) => r.name || '' },
      { label: 'Details', value: (r) => r.detail || '', cell: (r) => r.detail || '' },
    ], rows, { name: `${cardName(s.card)} log`, empty: 'Nothing logged yet. Marking files and importing are recorded here.' }));
  });
  return h('aside', { class: 'drawer wide', 'aria-label': 'Log' },
    h('div', { class: 'row' }, h('h2', {}, 'Log'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => { state.drawer = null; renderMain(); } }, 'Close')),
    h('p', { class: 'none' }, 'Files marked ready or skip, and each import from this card.'),
    box);
}

/** The "Find local copies" panel: match this card's files against the library index. */
function localPanel(s) {
  const cover = h('div', { class: 'folderlist' }, h('div', { class: 'none' }, 'Loading the index'));
  const start = h('button', { class: 'btn primary wide', disabled: true,
    onclick: () => run('folderscan:start', { cardId: s.card.id }) }, 'Match against the index');
  api.invoke('index:status').then((ix) => {
    const drives = (ix.drives || []).filter((d) => d.selected);
    const folders = ix.folders || [];
    const rows = [
      ...drives.map((d) => h('div', { class: 'folderrow' }, h('span', { class: 'dir' }, `${d.letter} ${d.label || ''}`.trim() + ' (whole drive, imported media only)'))),
      ...folders.map((f) => h('div', { class: 'folderrow' }, h('span', { class: `dir${f.exists ? '' : ' missing'}` }, f.exists ? f.path : `${f.path} (not connected)`))),
    ];
    cover.replaceChildren(
      h('div', { class: 'hint' }, ix.files
        ? `${ix.files.toLocaleString()} files indexed, ${ix.hashed.toLocaleString()} with a checksum.`
        : 'The index is empty. Add drives or folders under Library index first.'),
      ...(rows.length ? rows : [h('div', { class: 'none' }, 'No drives or folders chosen yet.')]));
    start.disabled = busy() || !ix.files;
  });

  return h('aside', { class: 'drawer', 'aria-label': 'Find local copies' },
    h('div', { class: 'row' }, h('h2', {}, 'Find local copies'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => { state.drawer = null; renderMain(); } }, 'Close')),

    h('h3', {}, h('span', { class: 'step' }, '1'), 'What it does'),
    h('ul', { class: 'steps' },
      h('li', {}, `Looks through the library index for files that are the same as the ${s.totals.count} on this card.`),
      h('li', {}, 'A file counts as a copy only when its contents match exactly, by checksum. The file name does not matter, so renamed copies are found.'),
      h('li', {}, 'Indexed files with a checksum are matched instantly. Others of the same size are read once and their checksum is saved for next time.'),
      h('li', {}, 'Nothing is copied, moved or changed. Matches are recorded and show up in the Copied column.')),

    h('h3', {}, h('span', { class: 'step' }, '2'), 'What the index covers'),
    cover,
    h('button', { class: 'btn wide', onclick: () => { state.drawer = null; show('index'); } }, 'Change this in Library index'),
    h('div', { class: 'hint' }, 'Your folders are listed again first, so files added since the last index run are included.'),

    h('h3', {}, h('span', { class: 'step' }, '3'), 'Match'),
    h('div', { class: 'hint' }, s.mounted ? 'Keep the card in: matching files are read from it to compare.' : 'The card is not connected, so only files CardMap has already read can be matched.'),
    start);
}

/** The "Add to Lightroom" panel: drag the files onto Lightroom, then confirm against its catalog. */
function lightroomPanel(s, rows, keys, unit) {
  const chosen = keys.length ? rows.filter((g) => state.sel.has(g.key)) : rows;
  const count = chosen.reduce((n, g) => n + g.count, 0);
  const have = chosen.reduce((n, g) => n + g.lightroom, 0);
  // Which files: the latest import, the files marked Ready, the ticked rows, or the whole card.
  const src = state.lrSources && state.lrSources.cardId === s.card.id ? state.lrSources : null;
  if (!src) api.invoke('lightroom:sources', s.card.id).then((x) => { state.lrSources = { cardId: s.card.id, ...x }; renderMain(); });
  const options = [
    ...(src ? src.groups : []).map((g, i) => [`group:${i}`, `Group ${[g.profile, g.shoot].filter(Boolean).join(': ')} (${g.files})`]),
    src && src.lastImport ? ['lastImport', `Files from the last import (${src.lastImport})`] : null,
    src && src.ready ? ['ready', `Files marked Ready (${src.ready})`] : null,
    keys.length ? ['rows', `The ${keys.length} ticked ${unit}${keys.length === 1 ? '' : 's'} (${count} files)`] : null,
    ['card', `The whole card (${s.totals.count} files)`],
  ].filter(Boolean);
  const source = options.some(([k]) => k === state.form.lrSource) ? state.form.lrSource : options[0][0];
  const grp = source.startsWith('group:') ? src.groups[Number(source.slice(6))] : null;
  const query = { cardId: s.card.id,
    ...(grp ? { source: 'group', profile: grp.profile, shoot: grp.shoot }
      : source === 'lastImport' || source === 'ready' ? { source }
      : source === 'rows' ? (unit === 'date' ? { dates: keys } : { folders: keys }) : {}) };
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
      options.map(([k, label]) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'lrsource', checked: k === source, onchange: () => { state.form.lrSource = k; renderMain(); } }), ` ${label}`)),
      source === 'rows' || source === 'card' ? h('div', { class: 'none' }, `${source === 'card' ? s.totals.lightroom : have} of these are already recorded as in Lightroom.`) : null,
      h('div', { class: 'none' }, 'Files already in Lightroom and files marked skip are left out.'),
      grp ? h('div', {}, 'Put them in the album ', h('strong', {}, grp.album), ' in Lightroom.') : null),

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
      : s.safeExceptSkipped
        ? h('span', { class: 'badge warn', title: `Every file you did not mark skip has ${s.rules.copies} or more verified copies. Formatting loses the skipped ones.` },
            `Safe to format, apart from ${t.skip - t.skipSafe} file${t.skip - t.skipSafe === 1 ? '' : 's'} marked skip`)
        : h('span', { class: 'badge warn', title: rulesTitle(s.rules) }, `Not safe to format: ${t.count - t.safe} files have verified copies on fewer than ${s.rules.copies} separate disk${s.rules.copies === 1 ? '' : 's'}`);

  const setGroup = (g) => { state.groupBy = g; defaultSelection(); renderMain(); };

  const drive = s.mounted ? state.cards.mounted.find((d) => d.letter === s.letter) : null;
  const sel = keys.length ? ` (${keys.length} selected)` : '';

  return [h('div', { class: 'split' }, h('div', { class: 'split-main' }, [
    h('div', { class: 'row' }, h('h1', {}, title), badge, h('span', { class: 'spacer' }), nameField(s)),
    h('p', { class: 'lede' }, `${t.count} photo and video files in ${s.folders.length} folder${s.folders.length === 1 ? '' : 's'}, ${bytes(t.bytes)}. Card ID ${s.card.serial}.`),
    drive ? usage(drive.size, drive.free, false) : s.card.size ? h('div', { class: 'usage' }, h('span', {}, `${bytes(s.card.size)} card`)) : null,
    resultNotice(),
    s.mounted && state.cardBg[s.card.serial] ? h('div', { class: 'hint row' },
      h('span', { id: 'cardbgline' }, cardBgLine(state.cardBg[s.card.serial])),
      h('button', { class: 'link', title: 'Stop reading, for example to take the card out', onclick: () => api.invoke('cardbg:stop', s.card.serial) }, 'Stop')) : null,
    s.mounted ? null : h('div', { class: 'notice' }, 'This card is not connected. The table shows what was recorded when it was last read.'),
    reviewPrompt(s, title),
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
      s.totals.lightroom < s.totals.count ? h('button', { class: 'btn', title: 'Every file on this card that Lightroom has no record of', onclick: () =>
        openFiles({ cardId: s.card.id, lr: 'missing' }, `${title}: not in Lightroom`, 'Files Lightroom has no record of, as of the last Lightroom check.') },
        `Not in Lightroom (${(s.totals.count - s.totals.lightroom).toLocaleString()})`) : null,
      h('button', { class: 'btn', 'aria-expanded': String(state.drawer === 'log'),
        onclick: () => { state.drawer = state.drawer === 'log' ? null : 'log'; renderMain(); } }, 'Log'),
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
      { label: 'In Lightroom', num: true, value: (g) => g.lightroom, text: (g) => `${g.lightroom} of ${g.count}`, cell: (g) => [tally(g.lightroom, g.count),
        g.lightroom < g.count ? h('div', {}, h('button', { class: 'link', title: 'See the files Lightroom does not have', onclick: () =>
          openFiles({ cardId: s.card.id, ...(byDate ? { date: g.key } : { folder: g.key }), lr: 'missing' }, `${g.key}: not in Lightroom`, `${title}. Files Lightroom has no record of, as of the last Lightroom check.`) },
          `see ${g.count - g.lightroom}`)) : null] },
      { label: `On ${s.rules.copies}+ disk${s.rules.copies === 1 ? '' : 's'}`, num: true, value: (g) => g.safe, text: (g) => `${g.safe} of ${g.count}`, cell: (g) => tally(g.safe, g.count) },
      { label: 'Marked', value: (g) => g.ready * 1e6 + g.skip, text: (g) => markText(g), cell: (g) => (g.ready || g.skip ? markText(g) : h('span', { class: 'none' }, '')) },
    ], rows, { name: `${cardName(s.card)} by ${unit}` }),
  ]), s.mounted && state.drawer === 'import' ? importPanel(s, rows, keys, unit)
    : state.drawer === 'log' ? logPanel(s)
    : state.drawer === 'lightroom' ? lightroomPanel(s, rows, keys, unit)
    : state.drawer === 'local' ? localPanel(s) : null)];
}

const rulesTitle = (r) => `A file is safe with verified copies on ${r.copies} separate physical disk${r.copies === 1 ? '' : 's'}${r.countLightroom ? ', Lightroom counting as one' : ', not counting Lightroom'}. Two copies on one disk count once. Change this in Settings.`;

// Files only on the card (not copied anywhere, not in Lightroom) that have not been marked
// Ready or Skip yet: ask for them to be reviewed.
function reviewPrompt(s, title) {
  const t = s.totals;
  if (!t.unsaved) return null;
  // Until the card's checksums are read, CardMap cannot tell which files are already on
  // your drives or in Lightroom, so do not ask for a review yet.
  if (s.mounted && state.cardBg[s.card.serial]) {
    return h('div', { class: 'hint' }, `Checking ${t.unsaved.toLocaleString()} file${t.unsaved === 1 ? '' : 's'} with no copy recorded yet against your drives and Lightroom. `,
      'Once the checksums are read, anything that is already saved drops off this count, and CardMap asks you to review the rest.');
  }
  const open = () => openFiles({ cardId: s.card.id, unsaved: true }, `${title}: only on the card`,
    'Not copied to any drive and not in Lightroom. Mark each Ready to import it, or Skip to leave it out.');
  const n = (k) => `${k.toLocaleString()} file${k === 1 ? '' : 's'}`;
  if (!t.unreviewed) {
    return h('div', { class: 'hint row' }, `${n(t.unsaved)} only on this card, all marked Ready or Skip. `,
      h('button', { class: 'link', onclick: open }, 'See them'));
  }
  return h('div', { class: 'notice warn row' },
    h('span', { class: 'grow' }, h('strong', {}, `${n(t.unreviewed)} on this card ${t.unreviewed === 1 ? 'is' : 'are'} not saved anywhere yet`),
      ' (not copied to your drives and not in Lightroom) and not reviewed. Mark each one Ready to import it, or Skip to leave it out.'),
    h('button', { class: 'btn primary', onclick: open }, `Review ${n(t.unreviewed)}`));
}

// ---------- import profiles and groups ----------
// A group is a profile (where files go) plus a shoot name. Files are put in a group while
// reviewing, then "Import all groups" copies each group with its own profile.
const groupText = (r) => (r.group ? [r.group, r.groupShoot].filter(Boolean).join(': ') : '');
async function loadProfiles() {
  [state.profiles, state.projectList] = await Promise.all([api.invoke('profiles:get'), api.invoke('projects:get')]);
  return state.profiles;
}
function groupBar(cardId, chosen, apply) {
  if (!state.profiles) { loadProfiles().then(() => renderMain()); return null; }
  const f = state.groupForm || (state.groupForm = { profile: '', shoot: '' });
  if (!state.profiles.some((p) => p.name === f.profile)) f.profile = (state.profiles[0] || {}).name || '';
  const prof = state.profiles.find((p) => p.name === f.profile);
  if (!state.profiles.length) {
    return h('div', { class: 'row toolbar' }, h('span', { class: 'none' }, 'To send files to different places in one import, make an import profile first.'),
      h('button', { class: 'btn', onclick: () => show('settings') }, 'Make a profile'));
  }
  return h('div', { class: 'row toolbar' },
    h('span', { class: 'none' }, chosen.length ? `Send ${chosen.length} selected to` : 'Tick files, then send them to'),
    h('select', { 'aria-label': 'Import profile', onchange: (e) => { f.profile = e.target.value; f.shoot = ''; renderMain(); } },
      state.profiles.map((p) => h('option', { value: p.name, selected: p.name === f.profile }, p.name))),
    h('input', { type: 'text', class: 'inline', list: 'project-names', value: f.shoot, placeholder: prof && prof.shoot ? prof.shoot : 'Project (pick or type a new one)', 'aria-label': 'Project',
      oninput: (e) => { f.shoot = e.target.value; } }),
    h('datalist', { id: 'project-names' }, (state.projectList || []).filter((p) => p.org === ((prof && prof.albumParent) || f.profile)).map((p) => h('option', { value: p.name }, p.date || ''))),
    h('button', { class: 'btn primary', disabled: !chosen.length, onclick: () => apply(chosen, f.profile, f.shoot.trim() || (prof && prof.shoot) || '') }, 'Add to group'),
    h('button', { class: 'btn', disabled: !chosen.some((r) => r.group), onclick: () => apply(chosen.filter((r) => r.group), null, '') }, 'Remove from group'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'link', onclick: () => show('settings') }, 'Edit profiles'));
}

// The groups part of the Import panel: each group with where it goes, and one button.
function groupsSection(s) {
  const G = state.groups && state.groups.cardId === s.card.id ? state.groups.list : null;
  if (!G) { api.invoke('groups:get', s.card.id).then((list) => { state.groups = { cardId: s.card.id, list }; renderMain(); }); return null; }
  if (!G.length) return null;
  if (!state.profiles) { loadProfiles().then(() => renderMain()); return null; }
  const prof = new Map(state.profiles.map((p) => [p.name, p]));
  return h('div', { class: 'what' },
    h('strong', {}, `${G.length} import group${G.length === 1 ? '' : 's'} on this card`),
    G.map((g) => {
      const p = prof.get(g.profile);
      return h('div', { class: 'none' }, h('strong', {}, [g.profile, g.shoot].filter(Boolean).join(': ')), ` · ${g.files} files, ${bytes(g.bytes)} → `,
        p && p.dest ? [p.dest, p.backup ? ` + ${p.backup}` : '', p.extra.length ? ` + ${p.extra.length} more` : '']
          : p && p.lightroom ? 'Lightroom only (nothing copied to a drive)' : h('span', { class: 'part' }, 'no "Copy to" folder in this profile'));
    }),
    h('button', { class: 'btn primary wide', disabled: busy() || !s.mounted, onclick: () => run('import:groups', { cardId: s.card.id }) },
      `Import all ${G.length} group${G.length === 1 ? '' : 's'}`),
    h('div', { class: 'none' }, 'Each group is copied and verified with its own profile. Files not in a group are not part of this; use the settings below for those.'));
}

// Settings: the list of import profiles, edited in place and saved together.
function profilesEditor() {
  if (!state.profiles) { loadProfiles().then(() => { if (state.view === 'settings') renderMain(); }); return 'Loading'; }
  const list = state.profileDraft || (state.profileDraft = state.profiles.map((p) => ({ ...p, extra: [...p.extra] })));
  const field = (p, key, label, placeholder, browse) => {
    const input = h('input', { type: 'text', value: p[key] || '', placeholder, 'aria-label': label, oninput: (e) => { p[key] = e.target.value; } });
    return h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'row tight' }, input,
      browse ? h('button', { class: 'btn', onclick: async () => { const x = await api.invoke('pickFolder', p[key] || ''); if (x) { p[key] = x; input.value = x; } } }, 'Browse') : null));
  };
  return [
    list.map((p, i) => h('div', { class: 'card-box' },
      field(p, 'name', 'Profile name', 'e.g. Client work'),
      field(p, 'dest', 'Copy to', 'Main folder', true),
      field(p, 'backup', 'Backup to (optional)', 'Ideally on a different drive', true),
      h('div', { class: 'field' }, h('label', {}, 'Also copy to (optional, one folder per line)'),
        h('textarea', { rows: 2, 'aria-label': 'Extra folders', oninput: (e) => { p.extra = e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); } }, p.extra.join('\n'))),
      field(p, 'folderPattern', 'Folder name', '{date} {shoot}  (also {year} {month} {day}; use \\ for subfolders)'),
      field(p, 'shoot', 'Default shoot name (optional)', 'Filled in when you add files to this profile'),
      field(p, 'albumParent', 'Org (optional)', 'Who this work is for; also its Lightroom album folder'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: Boolean(p.lightroom), onchange: (e) => { p.lightroom = e.target.checked; } }), ' Open Add to Lightroom after importing'),
      h('div', { class: 'row actions' }, h('button', { class: 'btn', onclick: () => { list.splice(i, 1); renderMain(); } }, 'Remove this profile')))),
    h('div', { class: 'row actions' },
      h('button', { class: 'btn', onclick: () => { list.push({ name: '', dest: '', backup: '', extra: [], folderPattern: '', shoot: '', lightroom: false, albumParent: '' }); renderMain(); } }, 'Add a profile'),
      h('button', { class: 'btn primary', onclick: async () => {
        state.profiles = await api.invoke('profiles:save', list);
        state.profileDraft = null;
        state.lastResult = { info: `Saved ${state.profiles.length} import profile${state.profiles.length === 1 ? '' : 's'}.` };
        renderMain();
      } }, 'Save profiles')),
  ];
}

// Whether Lightroom has a card file: Yes, Not confirmed (in the catalog, upload not confirmed) or No.
const lrState = (r) => {
  const l = r.locations.filter((x) => x.kind === 'lightroom');
  return !l.length ? 'No' : l.some((x) => x.verified) ? 'Yes' : 'Not confirmed';
};

function filesView() {
  const f = state.files;
  const rows = f.rows;
  const total = rows ? rows.reduce((n, r) => n + r.size, 0) : 0;
  // Card files can be marked ready (import it) or skip (leave it out of imports).
  const cardId = f.query.cardId;
  const setMark = async (list, mark) => {
    if (!list.length) return;
    await api.invoke('marks:set', { cardId, fileIds: list.map((r) => r.id), mark });
    for (const r of list) r.mark = mark;
    await refreshSummary();
    renderMain();
  };
  const markBtn = (r, mark, label) => h('button', { class: `btn${r.mark === mark ? ' on' : ''}`, 'aria-pressed': String(r.mark === mark),
    title: r.mark === mark ? 'Click again to clear the mark' : null,
    onclick: () => setMark([r], r.mark === mark ? null : mark) }, label);
  const markCol = cardId ? [{ label: 'Mark', value: (r) => r.mark || '', text: (r) => r.mark || '', csv: true,
    cell: (r) => h('div', { class: 'seg', role: 'group', 'aria-label': `Mark ${r.name}` }, markBtn(r, 'ready', 'Ready'), markBtn(r, 'skip', 'Skip')) }] : [];
  const ready = rows ? rows.filter((r) => r.mark === 'ready').length : 0;
  const skip = rows ? rows.filter((r) => r.mark === 'skip').length : 0;

  // Bulk selection: tick files (Shift-click ticks a range), then mark them all at once.
  const sel = state.fileSel || (state.fileSel = new Set());
  const shown = () => gridVisible('files', rows);
  const tick = (r, on, shift) => {
    const order = shown();
    const i = order.indexOf(r);
    const j = shift && state.fileSelLast != null ? order.findIndex((x) => x.id === state.fileSelLast) : -1;
    const range = j >= 0 && i >= 0 ? order.slice(Math.min(i, j), Math.max(i, j) + 1) : [r];
    for (const x of range) { if (on) sel.add(x.id); else sel.delete(x.id); }
    state.fileSelLast = r.id;
    renderMain();
  };
  const selectWhere = (test) => { sel.clear(); for (const r of shown()) if (test(r)) sel.add(r.id); renderMain(); };
  const chosen = rows ? rows.filter((r) => sel.has(r.id)) : [];
  const markChosen = async (mark) => { await setMark(mark ? chosen : chosen.filter((r) => r.mark), mark); sel.clear(); renderMain(); };
  const allTicked = rows && rows.length > 0 && shown().every((r) => sel.has(r.id));
  const selCol = cardId ? [{ label: h('input', { type: 'checkbox', checked: allTicked, 'aria-label': 'Select all files shown',
      onchange: (e) => selectWhere(() => e.target.checked) }),
    sort: false, csv: false, cls: 'check',
    cell: (r) => h('input', { type: 'checkbox', checked: sel.has(r.id), 'aria-label': `Select ${r.name}`,
      onclick: (e) => tick(r, e.target.checked, e.shiftKey) }) }] : [];
  // From a review list, go straight on to importing what was marked Ready.
  const sum = state.summary;
  const canImport = cardId && ready && sum && sum.mounted && sum.card.id === cardId;
  const toImport = () => { state.view = 'card'; state.sel.clear(); state.form.onlyReady = true; state.drawer = 'import'; render(); };

  return [
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async () => { state.view = f.back; if (f.back === 'map') await loadMap(); render(); } }, 'Back'),
      h('h1', {}, f.title)),
    h('p', { class: 'lede' }, rows ? `${rows.length} file${rows.length === 1 ? '' : 's'}, ${bytes(total)}. ${f.sub || ''}` : 'Loading'),
    rows && cardId ? h('div', { class: 'row toolbar' },
      h('span', { class: 'none' }, 'Select'),
      h('button', { class: 'btn', onclick: () => selectWhere(() => true) }, 'All shown'),
      h('button', { class: 'btn', onclick: () => selectWhere((r) => !r.mark) }, 'Not marked'),
      h('button', { class: 'btn', disabled: !sel.size, onclick: () => { sel.clear(); renderMain(); } }, 'None'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'none' }, chosen.length ? `Mark ${chosen.length} selected:` : ready || skip ? `${markText({ ready, skip })}.` : 'Tick files (Shift-click for a range), then mark them.'),
      h('button', { class: 'btn', disabled: !chosen.length, onclick: () => markChosen('ready') }, 'Ready'),
      h('button', { class: 'btn', disabled: !chosen.length, onclick: () => markChosen('skip') }, 'Skip'),
      h('button', { class: 'btn', disabled: !chosen.length, onclick: () => markChosen(null) }, 'Clear'),
      canImport ? h('button', { class: 'btn primary', onclick: toImport }, `Import the ${ready} marked Ready`) : null) : null,
    rows && cardId ? groupBar(cardId, chosen, async (list, profile, shoot) => {
      await api.invoke('groups:set', { cardId, fileIds: list.map((r) => r.id), profile, shoot });
      for (const r of list) { r.group = profile; r.groupShoot = profile ? shoot : ''; if (profile) r.mark = 'ready'; }
      sel.clear();
      state.lrSources = null;
      await refreshSummary();
      renderMain();
    }) : null,
    rows && grid('files', [
      ...selCol,
      ...markCol,
      ...(cardId ? [{ label: 'Group', value: (r) => groupText(r), cell: (r) => (r.group ? groupText(r) : h('span', { class: 'none' }, '')) }] : []),
      { label: 'Preview', sort: false, csv: false, cls: 'thumbcell', cell: (r) => thumb(r) },
      { label: 'File', value: (r) => r.name, text: (r) => [r.name, r.shoot].filter(Boolean).join(' · '), cell: (r) => [r.name, r.shoot ? h('div', { class: 'none' }, r.shoot) : null,
        r.openPath ? h('div', {}, h('button', { class: 'link', onclick: () => openFile(r.openPath) }, 'Open')) : null] },
      { label: 'Card folder', cell: (r) => r.folder },
      ...(cardId ? [{ label: 'Lightroom', value: (r) => lrState(r), cell: (r) => h('span', { class: lrState(r) === 'Yes' ? 'ok' : lrState(r) === 'No' ? 'none' : 'part' }, lrState(r)) }] : []),
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

// The rule for what is safe: copies needed, and whether Lightroom counts as one.
// rules: { copies, countLightroom }. save(change) stores it and refreshes.
const placesText = (n) => (n === 1 ? 'one place' : `${['', 'one', 'two', 'three', 'four', 'five'][n] || n} places`);
function safeRulesControls(rules, save, disabled) {
  return [
    h('div', { class: 'row tight' },
      h('label', { for: 'safecopies' }, 'Copies a file needs before it counts as safe'),
      h('select', { id: 'safecopies', disabled, onchange: (e) => save({ copies: Number(e.target.value) }) },
        [1, 2, 3, 4, 5].map((n) => h('option', { value: n, selected: n === rules.copies }, String(n))))),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: rules.countLightroom, disabled, onchange: (e) => save({ countLightroom: e.target.checked }) }),
      'Count Lightroom\'s cloud copy as one of them'),
    rules.copies === 1
      ? h('div', { class: 'hint' }, h('strong', { class: 'part' }, 'With 1, a file in a single place counts as safe: there is no backup if that drive fails.'))
      : null,
    h('div', { class: 'hint' }, `Used for "Safe to format" on cards and "Safe to delete" on the Duplicates page. Each file needs ${placesText(rules.copies)} on different physical disks: two copies on one disk count once. The delete list always keeps at least one copy on your own drives.`),
  ];
}

function settingsView() {
  const st = state.settings;
  if (!state.safeRules) api.invoke('dupes:settings', {}).then((r) => { state.safeRules = r; if (state.view === 'settings') renderMain(); });
  const saveRules = async (change) => { state.safeRules = await api.invoke('dupes:settings', change); await refreshSummary(); renderMain(); };
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
    h('h2', { class: 'section' }, 'Import profiles'),
    h('p', { class: 'hint' }, 'A profile is a set of destinations and a folder-name pattern. While reviewing a card, put files in a profile with a shoot name, then import every group in one go.'),
    profilesEditor(),
    h('h2', { class: 'section' }, 'What counts as safe'),
    h('div', { class: 'card-box' }, state.safeRules ? safeRulesControls(state.safeRules, saveRules) : 'Loading'),
    h('h2', { class: 'section' }, 'CardMap\'s data'),
    h('div', { class: 'card-box' },
      h('div', {}, 'Everything CardMap records (cards, copies, the library index, the Lightroom cache) is in one file:'),
      h('div', { class: 'row tight dbpath' },
        h('code', { class: 'big' }, st.dbFile || 'unknown'),
        st.dbFile ? h('button', { class: 'link', onclick: () => api.invoke('reveal', st.dbFile.slice(0, st.dbFile.lastIndexOf('\\'))) }, 'Open folder') : null),
      h('div', { class: 'hint' }, st.backupAt
        ? `A complete copy is saved once a day as ${st.backupFile.slice(st.backupFile.lastIndexOf('\\') + 1)} in the same folder. Last saved ${dateTime(st.backupAt)}.`
        : 'A complete copy is saved once a day in the same folder, starting 30 seconds after CardMap opens.'),
      h('div', { class: 'row tight' },
        h('span', {}, 'Also keep a copy on another drive:'),
        st.backupDir2 ? h('code', {}, st.backupDir2) : h('span', { class: 'none' }, 'not set'),
        h('button', { class: 'btn', onclick: async () => { const p = await api.invoke('pickFolder', st.backupDir2 || ''); if (p) { state.settings = await api.invoke('backup:setSecond', p); renderMain(); } } }, st.backupDir2 ? 'Change' : 'Choose a folder'),
        st.backupDir2 ? h('button', { class: 'link', onclick: async () => { state.settings = await api.invoke('backup:setSecond', ''); renderMain(); } }, 'Stop') : null),
      st.backupDir2 ? h('div', { class: 'hint' }, st.backup2SameDisk
        ? h('strong', { class: 'part' }, 'That folder is on the same physical disk as the database, so it does not protect against that disk failing.')
        : st.backup2At ? `Second copy last saved ${dateTime(st.backup2At)}. It is refreshed after each daily copy, and when that drive is connected.`
          : 'No second copy there yet: its drive is not connected, or the first daily copy has not been made.') : null,
      h('div', { class: 'hint' }, 'To copy the database yourself, close CardMap first.')),
  ];
}

// ---------- library index ----------
function autoToggle(key, text) {
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: state.settings[key] !== '0', onchange: async (e) => {
      state.settings = await api.invoke('settings:set', { [key]: e.target.checked ? '1' : '0' });
    } }), text);
}

async function loadIndex() {
  [state.index, state.rules, state.history, state.watching] = await Promise.all([api.invoke('index:status'), api.invoke('index:rules'), api.invoke('history'), api.invoke('index:watching')]);
  state.libFolders = state.index.folders.map((f) => ({ path: f.path, exists: f.exists }));
  if (state.view === 'index') renderMain();
}

function cardBgLine(p) {
  const size = p.bytesTotal ? ` · ${bytes(p.bytesDone || 0)} of ${bytes(p.bytesTotal)}` : '';
  const count = p.filesTotal ? ` · file ${(p.filesDone || 0).toLocaleString()} of ${p.filesTotal.toLocaleString()}` : '';
  return `${p.paused ? 'Checksums paused while another task runs' : 'Reading checksums from the card in the background'}${count}${size}. Press Stop before taking the card out.`;
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
    state.newDrives.map((d) => h('div', { class: 'notice row' },
      h('span', { class: 'grow' }, `New drive connected: ${d.letter} ${d.label || 'no name'}. Look through it for imported photos and video?`),
      h('button', { class: 'btn primary', onclick: async () => { state.newDrives = await api.invoke('index:addDrive', d.serial); renderSidebar(); await loadIndex(); } }, 'Add to the index'),
      h('button', { class: 'btn', onclick: async () => { state.newDrives = await api.invoke('index:dismissDrive', d.serial); renderSidebar(); await loadIndex(); } }, 'Not this one'))),
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
      state.watching && state.watching.watching.length
        ? h('div', { class: 'hint' }, `Watching ${state.watching.watching.join(', ')} for new, changed, moved and deleted files while CardMap is open. Changes are picked up a few seconds after they stop.`)
        : null,
      state.watching && state.watching.useSearch
        ? h('div', { class: 'hint' }, 'Each time CardMap opens, every drive is walked in full in the background, to catch deletions and anything Windows missed. The checks in between (when a drive is connected, and every 6 hours) ask Windows Search what changed, which takes seconds.')
        : null,
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

    h('div', { class: 'row toolbar' }, h('strong', {}, 'Automatic')),
    h('div', { class: 'checks stack' },
      autoToggle('autoIndex', 'Keep the index up to date: scan for new folders and files, and read missing checksums, when CardMap opens, when one of these drives is connected, and every 6 hours.'),
      autoToggle('useWindowsSearch', 'Use Windows Search for the checks between full walks: ask it what changed instead of listing every folder. Turn off if Windows Search is switched off or skips your drives.'),
      autoToggle('autoCardChecksums', 'Read checksums from a card in the background as soon as it is plugged in, so its files can be matched and looked up.')),

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
    historySection(),
  ];
}

const HIST_WHEN = (iso) => (iso ? dateTime(Date.parse(iso)) : '');
const signed = (n, sign) => (n ? `${sign}${n.toLocaleString()}` : '');

/** Each drive over time: when it was scanned or changed, and what it held. */
function historySection() {
  const H = state.history;
  if (!H) return null;
  return [
    h('div', { class: 'row toolbar spaced' }, h('strong', {}, 'Drives over time'),
      h('span', { class: 'none' }, 'Every drive the index has covered, as of its latest record.')),
    H.drives.length
      ? grid('histdrives', [
          { label: 'Drive', value: (d) => `${d.letter || ''} ${d.label || ''}`.trim(), cell: (d) => `${d.letter || '?'} ${d.label || 'no name'}` },
          { label: 'Indexed files', num: true, value: (d) => d.files, cell: (d) => (d.files || 0).toLocaleString() },
          { label: 'Their size', num: true, value: (d) => d.bytes, cell: (d) => bytes(d.bytes || 0) },
          { label: 'With checksum', num: true, value: (d) => (d.files ? d.hashed / d.files : 0), text: (d) => d.hashed, cell: (d) => (d.files ? `${Math.floor((d.hashed / d.files) * 100)}%` : '') },
          { label: 'Free then', num: true, value: (d) => d.free || 0, cell: (d) => (d.size ? `${bytes(d.free || 0)} of ${bytes(d.size)}` : '') },
          { label: 'Last checked', cls: 'date', value: (d) => d.lastScan || '', cell: (d) => HIST_WHEN(d.lastScan) },
          { label: 'Last full walk', cls: 'date', value: (d) => d.lastWalk || '', cell: (d) => HIST_WHEN(d.lastWalk) },
          { label: 'Last record', cls: 'date', value: (d) => d.lastAt || '', cell: (d) => HIST_WHEN(d.lastAt) },
          { label: 'First record', cls: 'date', value: (d) => d.firstAt || '', cell: (d) => HIST_WHEN(d.firstAt) },
        ], H.drives, { name: 'CardMap drives', sort: { col: 0, dir: 1 } })
      : h('p', { class: 'lede' }, 'Nothing recorded yet. A record is added after each scan, and when files change on an indexed drive.'),
    H.rows.length ? h('div', { class: 'row toolbar spaced' }, h('strong', {}, 'History'),
      h('span', { class: 'none' }, 'File changes seen while CardMap is open are added up into one line per drive per day.')) : null,
    H.rows.length
      ? grid('history', [
          { label: 'When', cls: 'date', value: (r) => r.at, cell: (r) => HIST_WHEN(r.at) },
          { label: 'Drive', value: (r) => `${r.letter || ''} ${r.label || ''}`.trim(), cell: (r) => `${r.letter || '?'} ${r.label || ''}` },
          { label: 'What happened', value: (r) => r.what, cell: (r) => r.what },
          { label: 'Added', num: true, value: (r) => r.added, cell: (r) => h('span', { class: r.added ? 'ok' : 'none' }, signed(r.added, '+')) },
          { label: 'Removed', num: true, value: (r) => r.removed, cell: (r) => h('span', { class: r.removed ? 'part' : 'none' }, signed(r.removed, '-')) },
          { label: 'Indexed files', num: true, value: (r) => r.files, cell: (r) => (r.files || 0).toLocaleString() },
          { label: 'Their size', num: true, value: (r) => r.bytes, cell: (r) => bytes(r.bytes || 0) },
          { label: 'Free', num: true, value: (r) => r.free || 0, cell: (r) => (r.free != null ? bytes(r.free) : '') },
        ], H.rows, { name: 'CardMap drive history', sort: { col: 0, dir: -1 } })
      : null,
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
    h('p', { class: 'lede' }, 'A copy of the details in Lightroom\'s catalog, kept by CardMap: names, checksums, dates, albums and whether each photo was edited. No pictures. Lightroom\'s own files are never changed.'),
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
    st.assets ? editsSection() : null,
    st.assets ? h('div', { class: 'row toolbar spaced' }, h('strong', {}, 'Albums')) : null,
    st.assets ? grid('albums', [
      { label: 'Album', cell: (a) => a.path },
      { label: 'Photos', num: true, value: (a) => a.count, cell: (a) => a.count.toLocaleString() },
      { label: 'Originals', num: true, value: (a) => a.bytes, text: (a) => a.bytes, cell: (a) => (a.count ? bytes(a.bytes) : '') },
      { label: 'First taken', cls: 'date', value: (a) => a.first || '', cell: (a) => a.first || '' },
      { label: 'Last taken', cls: 'date', value: (a) => a.last || '', cell: (a) => a.last || '' },
    ], albums, { name: 'Lightroom albums', sort: { col: 4, dir: -1 } }) : null,
  ];
}

async function loadEdits() {
  state.edits = await api.invoke('lredits:status');
  if (state.view === 'lightroom') renderMain();
}

/** Save Lightroom's edits as .xmp files (and a JSON record of every photo) so originals can leave Lightroom. */
function editsSection() {
  const E = state.edits;
  if (!E) return h('div', { class: 'card-box' }, 'Counting edits');
  const side = state.editsSidecars !== false;
  return h('div', { class: 'card-box' },
    h('h3', {}, 'Archive Lightroom edits'),
    h('div', {}, h('strong', {}, `${E.edited.toLocaleString()} of ${E.assets.toLocaleString()} photos are edited in Lightroom.`),
      ` The edit settings for ${E.here.toLocaleString()} are on this computer and can be saved now. The other ${E.cloudOnly.toLocaleString()} are only in Lightroom's cloud.`),
    h('ul', { class: 'steps' },
      h('li', {}, 'Saving writes a .xmp file for each edit this computer has, plus lightroom-catalog.json: every Lightroom photo with its checksum, albums, rating, edit file and where its local copies are.'),
      h('li', {}, `${E.withRaw.toLocaleString()} edited photos also have a raw file on your drives. A .xmp next to a raw file, with the same name, is how Lightroom Classic, Camera Raw and Bridge open it with its edits.`),
      h('li', {}, 'For edits only in the cloud: in Lightroom, select the photos (an album at a time works well), choose Export, set File Type to "Original + Settings" and export to a folder. Then press "Pair a Lightroom export" below and pick that folder.')),
    h('div', { class: 'field' }, h('label', {}, 'Archive folder'),
      h('div', { class: 'row' }, h('span', { class: 'dir grow' }, E.dest),
        h('button', { class: 'btn', onclick: async () => {
          const p = await api.invoke('pickFolder', E.dest);
          if (p) { await api.invoke('lredits:setDest', p); await loadEdits(); }
        } }, 'Change'),
        h('button', { class: 'link', onclick: () => api.invoke('reveal', E.dest) }, 'Open'))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: side, onchange: (e) => { state.editsSidecars = e.target.checked; } }),
      'Also put each .xmp next to the matching raw files on your drives. Adds a small file beside each raw; never replaces an .xmp that is already there.'),
    h('div', { class: 'row actions' },
      h('button', { class: 'btn primary', disabled: busy(), onclick: () => run('lredits:export', { sidecars: state.editsSidecars !== false }) }, 'Save the archive'),
      h('button', { class: 'btn', disabled: busy(), title: 'Pick a folder exported from Lightroom with "Original + Settings"', onclick: async () => {
        const folder = await api.invoke('pickFolder', '');
        if (folder) run('lredits:pair', { folder, sidecars: state.editsSidecars !== false });
      } }, 'Pair a Lightroom export')));
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
    placeholder: 'File name, a path, a checksum, a Lightroom album, or a date like 2026-05-06',
    oninput: (e) => { L.q = e.target.value; clearTimeout(L.t); L.t = setTimeout(runLookup, 300); },
    onkeydown: (e) => { if (e.key === 'Enter') { clearTimeout(L.t); runLookup(); } } });
  setTimeout(() => { input.focus(); drawLookup(); }, 0);
  return [
    h('h1', {}, 'Find a file'),
    h('p', { class: 'lede' }, 'Searches the files on your cards, every file in the library index, and your Lightroom library. Each result shows every place that file is, matched by checksum, whatever it is called there. You can paste a full path from Explorer.'),
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
  // The Drives page, with the copy-plan drawer beside it when open.
  const reconcilePage = () => {
    const vol = state.reconcile && state.reconcile.vol;
    const page = reconcileView();
    page.splice(2, 0, resultNotice()); // under the heading and intro
    if (!state.copyPlanOpen || !vol) return page;
    return [h('div', { class: 'split' }, h('div', { class: 'split-main' }, page),
      copyPlanPanel(vol, () => { state.copyPlanOpen = false; renderMain(); }))];
  };
  const views = { rules: rulesView, projects: projectsView, reconcile: reconcilePage, compare: compareView, nearmatch: nearMatchView, allfiles: allFilesView, dupes: dupesView, lookup: lookupView, card: cardView, files: filesView, map: mapView, index: indexView, lightroom: lightroomView, settings: settingsView, welcome: welcomeView };
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

// Background checksum reading for a card that was just plugged in.
api.on('cardbg', async (p) => {
  const viewing = state.view === 'card' && state.summary && state.summary.card.serial === p.serial;
  if (p.done) {
    delete state.cardBg[p.serial];
    const x = p.result;
    if (viewing && x && (x.hashed || x.matched)) {
      state.lastResult = { info: `Checksums read for ${x.hashed.toLocaleString()} file${x.hashed === 1 ? '' : 's'} on this card${x.cancelled ? ' before it was stopped' : x.removed ? ' before it was taken out' : ''}.`
        + (x.filesWithCopies ? ` ${x.filesWithCopies} have a copy in the library index${x.matched ? ` (${x.matched} newly recorded)` : ''}.` : '')
        + (x.lightroom && x.lightroom.found ? ` ${x.lightroom.found} are in Lightroom.` : '') };
    }
    if (viewing) {
      await refreshSummary();
      renderMain();
    }
    return;
  }
  const first = !state.cardBg[p.serial];
  state.cardBg[p.serial] = p;
  const line = document.getElementById('cardbgline');
  if (line && viewing) line.textContent = cardBgLine(p);
  else if (first && viewing) renderMain();
});

// Drives that are connected but not yet in the index (or dismissed).
api.on('drives', async ({ newDrives }) => {
  state.newDrives = newDrives || [];
  renderSidebar();
  if (state.view === 'index') await loadIndex();
});

// The watcher picked up file changes on an indexed drive.
api.on('reports', () => { if (state.view === 'dupes') loadDupes(false); });
api.on('libchanged', async (c) => {
  if (state.view !== 'index') return;
  const bits = [c.added && `${c.added} added`, c.changed && `${c.changed} changed`, c.removed && `${c.removed} removed`].filter(Boolean).join(', ');
  state.lastResult = { info: `Files changed on your drives and the index was updated: ${bits}.` };
  await loadIndex();
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
    if (p.kind === 'import' && !p.error) {
      state.lrSources = null; // counts changed
      state.groups = null;
      if (state.projectsPage) state.projectsPage.data = null;
      state.form.lrSource = 'lastImport';
      if ((state.form.thenLightroom || (p.result && p.result.lightroom)) && state.view === 'card') state.drawer = 'lightroom';
    }
    await refreshSummary();
    if (state.view === 'map') await loadMap();
    if (state.view === 'lightroom') await Promise.all([loadLightroom(), loadEdits()]);
    if (state.view === 'allfiles') await loadAllFiles();
    if (state.view === 'index') await loadIndex();
    if (p.kind === 'dupes' || state.view === 'dupes') await loadDupes(false);
    if (state.view === 'reconcile') await loadReconcile(state.reconcile && state.reconcile.vol);
    if (p.kind === 'recheck' && !p.error && !(p.result && p.result.cancelled)) { render(); run('dupes:build'); return; }
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
  state.newDrives = await api.invoke('index:newDrives');
  state.cardBg = await api.invoke('cardbg:status');
  state.form.dest = state.settings.dest || '';
  state.form.backup = state.settings.backup || '';
  state.form.extra = state.settings.extra || [];
  await loadCards();
  render();
})();
