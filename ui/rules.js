// The Rules page: does the library follow your own filing rules?
// The rules live in a rules file you edit yourself; CardMap only reads and reports.
// Uses globals from app.js and grid.js (h, api, state, grid, bytes, renderMain, busy).

async function loadRules() {
  const prev = state.rules || {};
  state.rules = { ...prev, loading: true, error: null, open: prev.open || {} };
  if (state.view === 'rules') renderMain();
  try {
    const data = await api.invoke('rules:run');
    if (data && data.error) state.rules = { ...state.rules, loading: false, error: data.error };
    else state.rules = { ...state.rules, data, loading: false, error: null };
  } catch (e) {
    state.rules = { ...state.rules, loading: false, error: e.message };
  }
  if (state.view === 'rules') renderMain();
}

const RULE_STATUS = {
  ok: ['ok', 'ok'],
  warn: ['needs attention', 'part'],
  off: ['not set up', 'none'],
};
const RULE_GROUPS = [['photo', 'Photos'], ['video', 'Video'], ['cards', 'Cards'], ['general', 'General']];

function ruleRowsGrid(rule) {
  const rows = rule.rows || [];
  return grid(`rules-${rule.id}`, [
    { label: 'Where', value: (r) => r.path || r.name || '' },
    { label: 'Size', num: true, value: (r) => (r.size == null ? '' : r.size), cell: (r) => (r.size == null ? '' : bytes(r.size)) },
    { label: 'Detail', value: (r) => r.detail || '' },
  ], rows, { sort: rows.some((r) => r.size) ? { col: 1, dir: -1 } : { col: 0, dir: 1 } });
}

function ruleItem(rule) {
  const R = state.rules;
  const [text, cls] = RULE_STATUS[rule.status] || [rule.status, 'none'];
  const open = Boolean(R.open[rule.id]);
  const hasRows = rule.rows && rule.rows.length > 0;
  const toggle = () => { R.open[rule.id] = !open; renderMain(); };
  return h('div', { class: 'rule' },
    h('div', { class: 'row' },
      h('span', { class: cls }, h('strong', {}, text)),
      ' ',
      h('strong', {}, rule.title),
      rule.count ? h('span', { class: 'none' }, ` ${rule.count.toLocaleString()}${rule.bytes ? `, ${bytes(rule.bytes)}` : ''}`) : null),
    h('p', { class: 'hint' }, rule.summary),
    hasRows ? h('button', { class: 'link', 'aria-expanded': String(open), onclick: toggle }, open ? 'Hide details' : 'Show details') : null,
    open && hasRows ? ruleRowsGrid(rule) : null,
    open && rule.truncated ? h('p', { class: 'hint' }, `Only the first ${rule.rows.length.toLocaleString()} rows are shown.`) : null);
}

function rulesView() {
  const R = state.rules;
  const intro = [
    h('h1', {}, 'Rules'),
    h('p', { class: 'lede' }, 'Checks whether your library follows your own filing rules. The rules are set in your rules file; CardMap only reads and reports, it never moves or deletes anything.'),
    h('div', { class: 'row actions' },
      h('button', { class: 'btn primary', disabled: busy() || Boolean(R && R.loading), onclick: () => loadRules() }, R && R.loading ? 'Checking' : 'Check again'),
      h('button', { class: 'btn', onclick: () => api.invoke('rules:open') }, 'Edit rules file')),
  ];
  if (!R || (!R.data && !R.error)) {
    if (!R) loadRules();
    return [...intro, h('p', { class: 'hint' }, 'Checking')];
  }
  if (R.error && !R.data) return [...intro, h('div', { class: 'notice bad' }, R.error)];
  const D = R.data;
  const out = [...intro, R.error ? h('div', { class: 'notice bad' }, R.error) : null,
    h('p', { class: 'hint' }, `Checked ${D.checked ? D.checked.slice(0, 16).replace('T', ' ') : ''}`)];
  for (const [g, title] of RULE_GROUPS) {
    const rules = D.rules.filter((r) => r.group === g);
    if (!rules.length) continue;
    out.push(h('h2', {}, title), ...rules.map(ruleItem));
  }
  return out;
}
