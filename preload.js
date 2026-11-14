const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'cards', 'card:scan', 'card:summary', 'import:start', 'lightroom:start', 'folderscan:start',
  'job:cancel', 'map', 'files', 'card:rename', 'thumb', 'open', 'lightroom:pending', 'lightroom:open',
  'library:folders', 'library:setFolders', 'index:status', 'index:inventory', 'index:start', 'index:stop',
  'index:scan', 'index:setDrives', 'index:exclude', 'index:include',
  'index:rules', 'index:addPrefix', 'index:removePrefix', 'index:togglePrefix', 'lookup', 'export:csv', 'dupes:get', 'dupes:settings', 'dupes:build', 'dupes:recheck', 'lrcache:status', 'lrcache:albums', 'lrcache:refresh', 'settings:get', 'settings:set', 'cardbg:status', 'cardbg:stop', 'index:newDrives', 'index:dismissDrive', 'index:addDrive', 'filemap', 'history', 'index:watching', 'lredits:status', 'lredits:setDest', 'lredits:export', 'lredits:pair', 'pickFolder', 'reveal',
]);
const EVENTS = new Set(['cards', 'job', 'volumes', 'bg', 'cardbg', 'drives', 'libchanged']);

contextBridge.exposeInMainWorld('cardmap', {
  invoke: (channel, ...args) => {
    if (!INVOKE.has(channel)) throw new Error(`Unknown channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, fn) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event ${channel}`);
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
  // Begin dragging the chosen files out of the window (for dropping onto Lightroom).
  drag: (query) => ipcRenderer.send('drag', query),
});
