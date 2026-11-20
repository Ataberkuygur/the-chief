// Monitor / window control for the bridge (loaded by bg.js via importScripts).
// Chrome cannot say "open this tab on monitor N", so the bridge keeps ONE dedicated window per monitor and
// opens bridge tabs in it. Spec: 'primary' | 'secondary' | a 0-based index (primary first) | 'any' (no preference).
// The default spec (what newtab uses when nothing is named) is stored by `setdisplay`; first install = 'primary'.
const WIN_KEY = 'bridgeWindows';
const DISPLAY_KEY = 'defaultDisplay';

async function displayList() {
  const all = await chrome.system.display.getInfo();
  return all.sort((a, b) => (b.isPrimary - a.isPrimary) || (a.bounds.left - b.bounds.left))
    .map((d, i) => ({ index: i, id: d.id, name: d.name, primary: d.isPrimary, bounds: d.bounds, work: d.workArea }));
}
async function pickDisplay(spec) {
  const list = await displayList();
  if (spec === 'secondary') return list.find(d => !d.primary) || list[0];
  if (spec === 'primary' || spec == null) return list[0];
  const n = Number(spec);
  if (!Number.isInteger(n) || !list[n]) throw new Error(`no display "${spec}" (have ${list.length}: ${list.map(d => d.index + (d.primary ? ' primary' : '')).join(', ')})`);
  return list[n];
}
async function getDefaultDisplay() {
  return (await chrome.storage.local.get(DISPLAY_KEY))[DISPLAY_KEY] || 'primary';
}
async function bridgeWindowOn(spec) {
  const d = await pickDisplay(spec);
  const map = (await chrome.storage.local.get(WIN_KEY))[WIN_KEY] || {};
  const known = map[d.id];
  if (known != null) {
    const w = await chrome.windows.get(known).catch(() => null);
    if (w) return { windowId: w.id, display: d.index, created: false };
  }
  const w = await chrome.windows.create({ url: 'about:blank', left: d.work.left, top: d.work.top, width: d.work.width, height: d.work.height, focused: false });
  await chrome.windows.update(w.id, { state: 'maximized' });
  map[d.id] = w.id;
  await chrome.storage.local.set({ [WIN_KEY]: map });
  return { windowId: w.id, display: d.index, created: true, blankTab: w.tabs && w.tabs[0] && w.tabs[0].id };
}
async function winCmd(c) {
  switch (c.cmd) {
    case 'displays': return displayList();
    case 'windows': {
      const ws = await chrome.windows.getAll({ populate: true });
      const list = await displayList();
      return ws.map(w => {
        const cx = (w.left || 0) + (w.width || 0) / 2, cy = (w.top || 0) + (w.height || 0) / 2;
        const d = list.find(x => cx >= x.bounds.left && cx < x.bounds.left + x.bounds.width && cy >= x.bounds.top && cy < x.bounds.top + x.bounds.height);
        return { id: w.id, display: d ? d.index : null, state: w.state, focused: w.focused, left: w.left, top: w.top, width: w.width, height: w.height, tabs: w.tabs.length };
      });
    }
    case 'setdisplay': await chrome.storage.local.set({ [DISPLAY_KEY]: String(c.display) }); return { defaultDisplay: String(c.display) };
    case 'newwin': { const r = await bridgeWindowOn(c.display || await getDefaultDisplay()); if (c.url) { const t = await chrome.tabs.create({ windowId: r.windowId, url: c.url, active: true }); r.tabId = t.id; } return r; }
    case 'movetab': {
      const target = c.windowId != null ? { windowId: +c.windowId } : await bridgeWindowOn(c.display || await getDefaultDisplay());
      const t = await chrome.tabs.move(c.tabId, { windowId: target.windowId, index: -1 });
      await chrome.tabs.update(c.tabId, { active: true });
      return { tabId: c.tabId, windowId: target.windowId };
    }
  }
}
// newtab: honours windowId / display; with neither it opens in the bridge window of the default display ('any' = old behaviour).
async function newTabIn(c) {
  const spec = c.display || (c.windowId == null ? await getDefaultDisplay() : 'any');
  let windowId = c.windowId;
  if (windowId == null && spec !== 'any') windowId = (await bridgeWindowOn(spec)).windowId;
  const t = await chrome.tabs.create({ ...(windowId != null ? { windowId } : {}), url: c.url || 'about:blank', active: c.active !== false });
  return { id: t.id, url: t.url, windowId: t.windowId };
}
