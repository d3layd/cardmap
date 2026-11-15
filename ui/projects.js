// The Projects page: projects planned ahead under an org (an import profile), and a log
// of where every project's files went, groupable by project, org, card or folder.
// Uses globals from app.js and grid.js (h, api, state, grid, bytes, renderMain, dateTime, loadProfiles).

async function loadProjects() {
  state.projectsPage = { ...(state.projectsPage || {}), loading: true };
  if (state.view === 'projects') renderMain();
  const [data, orgs] = await Promise.all([api.invoke('projects:log'), api.invoke('orgs:get'), loadProfiles()]);
  state.projectsPage = { ...state.projectsPage, data, orgs, loading: false };
  if (state.view === 'projects') renderMain();
}

// Log rows rolled up by the chosen key; "none" keeps one row per import and folder.
const PROJECT_GROUPS = {
  none: ['Each import and folder', null],
  project: ['Project', (r) => `${r.org}|${r.project}`],
  org: ['Org', (r) => r.org],
  card: ['Card', (r) => r.card],
  folder: ['Folder', (r) => r.folder.toLowerCase()],
};
const KIND_NAMES = { primary: 'Main copy', backup: 'Backup', extra: 'Extra copy' };

function rollUp(log, by) {
  const keyOf = PROJECT_GROUPS[by][1];
  if (!keyOf) return log;
  const m = new Map();
  for (const r of log) {
    const k = keyOf(r);
    const e = m.get(k) || { ...r, files: 0, bytes: 0, imports: new Set(), folders: new Set(), cards: new Set(), first: r.at };
    e.files += r.files;
    e.bytes += r.bytes;
    e.imports.add(r.importId);
    e.folders.add(r.folder);
    e.cards.add(r.card);
    if (r.at > e.at) e.at = r.at;
    if (r.at < e.first) e.first = r.at;
    m.set(k, e);
  }
  return [...m.values()].map((e) => ({ ...e, imports: e.imports.size, folderCount: e.folders.size, cardCount: e.cards.size }));
}

function projectsView() {
  const P = state.projectsPage;
  const intro = [
    h('h1', {}, 'Projects'),
    h('p', { class: 'lede' }, 'Plan projects under an org before the shoot, so they are ready to pick while reviewing a card. Below, where every project\'s files went.'),
  ];
  if (!P || !P.data) {
    if (!P || !P.loading) loadProjects();
    return [...intro, h('p', { class: 'lede' }, 'Loading')];
  }
  const { data, orgs } = P;
  const form = P.form || (P.form = { org: orgs[0] || '', name: '', date: '', note: '' });
  if (form.org && !orgs.includes(form.org) && form.org !== '+') form.org = orgs[0] || '';
  const planned = data.projects.filter((p) => p.planned);
  const save = async (list) => {
    await api.invoke('projects:save', list.map(({ org, name, date, note }) => ({ org, name, date, note })));
    await loadProjects();
  };

  const newOrg = async () => {
    const name = (P.newOrg || '').trim();
    if (!name) return;
    P.orgs = await api.invoke('orgs:add', name);
    P.data.orgs = P.orgs;
    state.projectsPage.orgs = P.orgs;
    form.org = name;
    P.newOrg = '';
    renderMain();
  };
  const add = h('div', { class: 'card-box' },
        h('div', { class: 'row tight' },
          h('select', { 'aria-label': 'Org', onchange: (e) => { form.org = e.target.value; renderMain(); } },
            orgs.map((o) => h('option', { value: o, selected: o === form.org }, o)),
            h('option', { value: '+', selected: form.org === '+' || !orgs.length }, 'New org...')),
          form.org === '+' || !orgs.length ? [
            h('input', { type: 'text', class: 'inline', placeholder: 'Org name', value: P.newOrg || '', 'aria-label': 'New org name', oninput: (e) => { P.newOrg = e.target.value; } }),
            h('button', { class: 'btn', onclick: newOrg }, 'Add org')] : null),
        h('div', { class: 'row tight' },
          h('input', { type: 'text', class: 'inline', placeholder: 'Project name', value: form.name, 'aria-label': 'Project name', oninput: (e) => { form.name = e.target.value; } }),
          h('input', { type: 'text', class: 'inline', placeholder: 'Date (YYYY-MM-DD, optional)', value: form.date, 'aria-label': 'Project date', oninput: (e) => { form.date = e.target.value; } }),
          h('button', { class: 'btn primary', disabled: !form.org || form.org === '+', onclick: async () => {
            if (!form.org || form.org === '+' || !form.name.trim()) return;
            await save([...planned, { org: form.org, name: form.name.trim(), date: form.date.trim(), note: '' }]);
            P.form = { ...form, name: '', date: '' };
          } }, 'Add project')),
        h('div', { class: 'hint' }, 'An org is who the work is for, and its Lightroom album folder. Its projects are offered for every import profile set to that org, photo or video. The project name fills the folder-name pattern and the album name ("YYYY-MM-DD Project").'));

  const projectGrid = grid('projects', [
    { label: 'Org', value: (p) => p.org, cell: (p) => p.org || h('span', { class: 'none' }, 'none') },
    { label: 'Project', value: (p) => p.name, cell: (p) => [p.name || h('span', { class: 'none' }, '(no name)'), p.planned ? null : h('div', { class: 'none' }, 'not planned')] },
    { label: 'Date', cls: 'date', value: (p) => p.date || '', cell: (p) => p.date || '' },
    { label: 'Imported', num: true, value: (p) => p.files, cell: (p) => (p.files ? p.files.toLocaleString() : h('span', { class: 'none' }, '0')) },
    { label: 'Size', num: true, value: (p) => p.bytes, cell: (p) => (p.bytes ? bytes(p.bytes) : '') },
    { label: 'Folders', num: true, value: (p) => p.folders, cell: (p) => p.folders || '' },
    { label: 'Waiting on a card', num: true, value: (p) => p.waiting, cell: (p) => (p.waiting ? h('span', { class: 'part' }, p.waiting.toLocaleString()) : '') },
    { label: 'Last import', cls: 'date', value: (p) => p.lastAt, cell: (p) => (p.lastAt ? dateTime(Date.parse(p.lastAt)) : '') },
    { label: '', sort: false, csv: false, cell: (p) => (p.planned ? h('button', { class: 'link', onclick: () => save(planned.filter((x) => x !== p)) }, 'Remove') : null) },
  ], data.projects, { name: 'Projects', empty: 'No projects yet. Add one above, or put card files in a group with a project name.' });

  const by = P.groupBy || 'project';
  const rows = rollUp(data.log, by);
  const logCols = by === 'none'
    ? [
        { label: 'When', cls: 'date', value: (r) => r.at, cell: (r) => dateTime(Date.parse(r.at)) },
        { label: 'Org', value: (r) => r.org, cell: (r) => r.org || h('span', { class: 'none' }, 'none') },
        { label: 'Project', value: (r) => r.project, cell: (r) => r.project || '' },
        { label: 'Card', value: (r) => r.card, cell: (r) => r.card },
        { label: 'Copy', value: (r) => KIND_NAMES[r.kind] || r.kind, cell: (r) => KIND_NAMES[r.kind] || r.kind },
        { label: 'Folder', value: (r) => r.folder, cell: (r) => h('button', { class: 'link dir', title: 'Open the folder', onclick: () => api.invoke('reveal', r.folder) }, r.folder) },
        { label: 'Files', num: true, value: (r) => r.files, cell: (r) => r.files.toLocaleString() },
        { label: 'Size', num: true, value: (r) => r.bytes, cell: (r) => bytes(r.bytes) },
      ]
    : [
        { label: PROJECT_GROUPS[by][0], value: (r) => (by === 'project' ? `${r.org} ${r.project}` : by === 'org' ? r.org : by === 'card' ? r.card : r.folder),
          cell: (r) => (by === 'project' ? [r.project || '(no name)', h('div', { class: 'none' }, r.org || 'no org')]
            : by === 'org' ? r.org || h('span', { class: 'none' }, 'no org')
              : by === 'card' ? r.card
                : h('button', { class: 'link dir', title: 'Open the folder', onclick: () => api.invoke('reveal', r.folder) }, r.folder)) },
        { label: 'Copies', num: true, value: (r) => r.files, cell: (r) => r.files.toLocaleString() },
        { label: 'Size', num: true, value: (r) => r.bytes, cell: (r) => bytes(r.bytes) },
        { label: 'Imports', num: true, value: (r) => r.imports, cell: (r) => r.imports },
        { label: 'Folders', num: true, value: (r) => r.folderCount, cell: (r) => r.folderCount },
        { label: 'Cards', num: true, value: (r) => r.cardCount, cell: (r) => r.cardCount },
        { label: 'First', cls: 'date', value: (r) => r.first, cell: (r) => dateTime(Date.parse(r.first)) },
        { label: 'Latest', cls: 'date', value: (r) => r.at, cell: (r) => dateTime(Date.parse(r.at)) },
      ];

  return [
    ...intro,
    resultNotice(),
    h('h2', { class: 'section' }, 'Plan a project'),
    add,
    projectGrid,
    h('h2', { class: 'section' }, 'Where project files went'),
    h('div', { class: 'row toolbar' },
      h('span', { class: 'none' }, 'Group by'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Group the log by' },
        Object.entries(PROJECT_GROUPS).map(([k, [label]]) => h('button', { class: `btn${by === k ? ' on' : ''}`, 'aria-pressed': String(by === k),
          onclick: () => { P.groupBy = k; renderMain(); } }, label)))),
    h('p', { class: 'hint' }, 'Every verified copy made by an import. "Copies" counts each copy, so a file with a main copy and a backup counts twice. Imports made before profiles were added show no org.'),
    grid(`projectlog-${by}`, logCols, rows, { name: 'Project log', empty: 'No imports recorded yet.' }),
  ];
}
