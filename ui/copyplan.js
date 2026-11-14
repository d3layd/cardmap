// The copy plan panel: files on one drive that are nowhere else, and a button to give
// them a verified second copy in a folder on another drive.
// Uses globals from app.js (h, api, state, bytes, run, busy, renderMain).
// Channels: copyplan:build { vol } -> { files, bytes, online, sameDiskCopies, rows }
//           copyplan:start { vol, dest }, pickFolder (start folder) -> path or null.

const COPYPLAN_SHOWN = 200;

function copyPlanPanel(vol, onDone) {
  if (!state.copyPlan || state.copyPlan.vol !== vol) state.copyPlan = { vol, dest: '' };
  const form = state.copyPlan;
  const totals = h('div', { class: 'what' }, h('div', { class: 'none' }, 'Working out which files have no second copy.'));
  const list = h('div', {});
  const start = h('button', { class: 'btn primary wide', disabled: true }, 'Copy and verify');
  let plan = null;

  const sync = () => {
    const n = plan ? plan.files : 0;
    start.disabled = busy() || !n || !form.dest || (plan && plan.online === false);
    start.textContent = !plan ? 'Copy and verify' : !n ? 'Nothing to copy'
      : !form.dest ? 'Choose a destination folder' : `Copy and verify ${n.toLocaleString()} file${n === 1 ? '' : 's'}`;
  };

  const input = h('input', { type: 'text', value: form.dest, placeholder: 'A folder on a different drive', 'aria-label': 'Copy to',
    oninput: (e) => { form.dest = e.target.value.trim(); sync(); } });
  const browse = h('button', { class: 'btn', onclick: async () => {
    const p = await api.invoke('pickFolder', form.dest);
    if (p) { form.dest = p; input.value = p; sync(); }
  } }, 'Browse');

  start.addEventListener('click', async () => {
    start.disabled = true;
    await run('copyplan:start', { vol, dest: form.dest });
    if (onDone) onDone();
  });

  api.invoke('copyplan:build', { vol }).then((p) => {
    plan = p;
    const n = p.files;
    totals.replaceChildren(...[
      h('strong', {}, n ? `${n.toLocaleString()} file${n === 1 ? ' has' : 's have'} no second copy` : 'Every indexed file on this drive has a second copy'),
      n ? h('div', { class: 'none' }, `${bytes(p.bytes)} to copy. Matched by checksum against every other drive in the library index.`) : null,
      p.sameDiskCopies ? h('div', { class: 'none' }, `${p.sameDiskCopies.toLocaleString()} further cop${p.sameDiskCopies === 1 ? 'y' : 'ies'} of these files on this same drive ${p.sameDiskCopies === 1 ? 'is' : 'are'} left out: one copy of each file is enough.`) : null,
      h('div', { class: 'none' }, 'Files that have not been indexed yet (no checksum) are not included.'),
      p.online === false ? h('div', { class: 'part' }, 'This drive is not connected. Connect it to copy from it.') : null].filter(Boolean));
    const shown = p.rows.slice(0, COPYPLAN_SHOWN);
    list.replaceChildren(...[n ? h('details', { class: 'rules' },
      h('summary', {}, n > shown.length ? `Files to copy (largest ${shown.length.toLocaleString()} of ${n.toLocaleString()})` : `Files to copy (${n.toLocaleString()})`),
      h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Size'))),
        h('tbody', {}, shown.map((r) => h('tr', {}, h('td', {}, r.path), h('td', { class: 'num' }, bytes(r.size))))))) : null].filter(Boolean));
    sync();
  }).catch((e) => {
    totals.replaceChildren(h('div', { class: 'part' }, `Could not build the plan: ${e.message}`));
  });

  return h('aside', { class: 'drawer', 'aria-label': 'Copy plan' },
    h('div', { class: 'row' }, h('h2', {}, 'Make second copies'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => { if (onDone) onDone(); else renderMain(); } }, 'Close')),

    h('h3', {}, h('span', { class: 'step' }, '1'), 'What gets copied'),
    totals,
    list,

    h('h3', {}, h('span', { class: 'step' }, '2'), 'Where it goes'),
    h('div', { class: 'field' }, h('label', {}, 'Copy to'), h('div', { class: 'row tight' }, input, browse)),
    h('div', { class: 'none' }, 'Each file keeps its folder path inside this folder. The folder must be on a different physical disk.'),

    h('h3', {}, h('span', { class: 'step' }, '3'), 'What happens when you start'),
    h('ul', { class: 'steps' },
      h('li', {}, 'Each file is copied into the folder above, keeping the folders it is in now.'),
      h('li', {}, 'Every copy is read back from the destination and compared with the checksum of the original.'),
      h('li', {}, 'A file already there with the same content is counted, not copied again, so it is safe to run again.'),
      h('li', {}, 'A different file already there under the same name is left alone and reported. Nothing is overwritten.'),
      h('li', {}, 'Nothing on the source drive is changed, moved or deleted.')),
    start);
}
