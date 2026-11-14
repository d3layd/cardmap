// A table that can be sorted (click a column heading), filtered (type in the box) and
// exported as CSV (the rows currently shown, in the order shown).
//
// grid(id, columns, rows, opts) returns an element. `id` keeps the sort and filter when
// the page is redrawn. Each column is:
//   { label,                 heading text (or an element, for a column that does not sort)
//     cell(row),             what to show: text or an element
//     value(row),            what to sort by and export; defaults to the cell's text
//     text(row),             what to export and filter on, when it differs from value
//     num: true,             right-aligned number column
//     cls: 'date',           extra class for the cells
//     sort: false,           not sortable (e.g. a checkbox column)
//     csv: false }           left out of the export
// opts: { empty: 'message', tools: [elements beside the filter], name: 'file-name-for-export',
//         sort: { col: index, dir: 1 | -1 } (the starting order), onView(rows) }

const gridState = {};

function gridCompare(a, b) {
  if (a == null || a === '') return b == null || b === '' ? 0 : 1; // blanks last
  if (b == null || b === '') return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

function gridText(col, row) {
  if (col.text) return col.text(row);
  const v = col.value ? col.value(row) : col.cell(row);
  if (v == null) return '';
  if (typeof v === 'object' && v.nodeType) return v.textContent;
  return String(v);
}

function csvOf(columns, rows) {
  const cols = columns.filter((c) => c.csv !== false && typeof c.label === 'string');
  const q = (s) => {
    const t = String(s ?? '');
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.map((c) => q(c.label)).join(','), ...rows.map((r) => cols.map((c) => q(gridText(c, r))).join(','))].join('\r\n');
}

function grid(id, columns, rows, opts = {}) {
  const st = gridState[id] || (gridState[id] = { q: '', col: opts.sort ? opts.sort.col : null, dir: opts.sort ? opts.sort.dir : 1 });
  const body = h('tbody');
  const count = h('span', { class: 'none gridcount' });
  const heads = [];

  const visible = () => {
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    let out = rows;
    if (words.length) {
      out = rows.filter((r) => {
        const hay = columns.map((c) => gridText(c, r)).join(' \u0001 ').toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    if (st.col != null && columns[st.col]) {
      const c = columns[st.col];
      const key = (r) => (c.value ? c.value(r) : gridText(c, r));
      out = out.map((r) => [key(r), r]).sort((a, b) => gridCompare(a[0], b[0]) * st.dir).map((p) => p[1]);
    }
    return out;
  };

  const draw = () => {
    const shown = visible();
    st.visible = shown;
    body.replaceChildren(...(shown.length
      ? shown.map((r) => h('tr', {}, columns.map((c) => h('td', { class: [c.num ? 'num' : '', c.cls || ''].join(' ').trim() || null }, c.cell(r)))))
      : [h('tr', {}, h('td', { colspan: String(columns.length), class: 'none' }, rows.length ? 'Nothing matches the filter.' : opts.empty || 'Nothing here yet.'))]));
    count.textContent = st.q ? `${shown.length.toLocaleString()} of ${rows.length.toLocaleString()}` : `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}`;
    heads.forEach((th, i) => {
      if (!th) return;
      th.setAttribute('aria-sort', st.col === i ? (st.dir > 0 ? 'ascending' : 'descending') : 'none');
      th.dataset.arrow = st.col === i ? (st.dir > 0 ? '▲' : '▼') : '';
    });
    if (opts.onView) opts.onView(shown);
  };

  const head = h('tr', {}, columns.map((c, i) => {
    const sortable = c.sort !== false && typeof c.label === 'string';
    if (!sortable) {
      heads.push(null);
      return h('th', { class: c.num ? 'num' : null }, c.label);
    }
    const th = h('th', { class: `sortable${c.num ? ' num' : ''}`, tabindex: '0', title: 'Sort by this column',
      onclick: () => {
        if (st.col === i) st.dir = -st.dir;
        else { st.col = i; st.dir = c.num ? -1 : 1; } // numbers start largest first
        draw();
      },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.click(); } } }, c.label);
    heads.push(th);
    return th;
  }));

  const filter = h('input', { type: 'search', value: st.q, placeholder: 'Filter', 'aria-label': 'Filter this table',
    oninput: (e) => { st.q = e.target.value; clearTimeout(st.t); st.t = setTimeout(draw, rows.length > 3000 ? 250 : 60); } });
  const exportBtn = h('button', { class: 'btn', title: 'Save the rows shown as a CSV file (opens in Excel or Numbers)',
    onclick: async () => {
      const shown = st.visible || rows;
      const saved = await api.invoke('export:csv', { name: opts.name || id, csv: csvOf(columns, shown) });
      if (saved) { exportBtn.textContent = 'Saved'; setTimeout(() => { exportBtn.textContent = 'Export CSV'; }, 1800); }
    } }, 'Export CSV');

  draw();
  return h('div', { class: 'grid' },
    h('div', { class: 'row gridbar' }, filter, count, h('span', { class: 'spacer' }), opts.tools || null, exportBtn),
    h('table', { class: opts.cls || null }, h('thead', {}, head), body));
}

/** The rows a grid is showing right now (after its filter), e.g. for "select all". */
const gridVisible = (id, fallback) => (gridState[id] && gridState[id].visible) || fallback;
