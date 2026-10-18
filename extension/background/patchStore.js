'use strict';

// Patch persistence on chrome.storage.local, mirroring the desktop app's data
// shape (storage/patches.json): { [domain]: [{ id, prompt, css, aspects, createdAt }] }

const PATCHES_KEY = 'patches';
const SETTINGS_KEY = 'settings';
const AUTH_KEY = 'auth';

const DEFAULT_SETTINGS = {
  geminiApiKey: '',
  model: '',
  patchesEnabled: true,
};

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

async function getPatchMap() {
  const stored = await chrome.storage.local.get(PATCHES_KEY);
  const map = stored[PATCHES_KEY];
  return map && typeof map === 'object' ? map : {};
}

async function savePatchMap(patchMap) {
  await chrome.storage.local.set({ [PATCHES_KEY]: patchMap });
}

async function getPatchesFor(domain) {
  const map = await getPatchMap();
  return map[domain] || [];
}

async function addPatch(domain, patch) {
  const map = await getPatchMap();
  if (!map[domain]) map[domain] = [];
  map[domain].push(patch);
  await savePatchMap(map);
  return map[domain];
}

async function mutatePatchList(domain, mutator) {
  const map = await getPatchMap();
  const list = map[domain];
  if (!list) return [];
  mutator(list);
  await savePatchMap(map);
  return list;
}

async function deletePatch(domain, patchId) {
  return mutatePatchList(domain, (list) => {
    const idx = list.findIndex((p) => p.id === patchId);
    if (idx >= 0) list.splice(idx, 1);
  });
}

async function resetDomain(domain) {
  const map = await getPatchMap();
  map[domain] = [];
  await savePatchMap(map);
}

async function setPatchAspectEnabled(domain, patchId, aspectId, enabled) {
  return mutatePatchList(domain, (list) => {
    const patch = list.find((p) => p.id === patchId);
    if (!patch || !Array.isArray(patch.aspects)) return;
    const aspect = patch.aspects.find((a) => a.id === String(aspectId));
    if (aspect) aspect.enabled = !!enabled;
    patch.css = patch.aspects
      .filter((a) => a.enabled && String(a.css).trim())
      .map((a) => a.css)
      .join('\n');
  });
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// ── Auth cache ───────────────────────────────────────────────────────────────
// Written whenever the offscreen Firebase document broadcasts onAuthStateChanged.
// The service worker reads this to gate protected operations without having to
// wake a document; the offscreen document's Firebase session is the source of truth.
async function getAuthCache() {
  const stored = await chrome.storage.local.get(AUTH_KEY);
  const auth = stored[AUTH_KEY];
  return auth && typeof auth === 'object'
    ? auth
    : { signedIn: false, uid: '', email: '', configError: '' };
}

async function setAuthCache(state) {
  const prev = await getAuthCache();
  const next = {
    signedIn: !!state.signedIn,
    uid: String(state.uid || ''),
    email: String(state.email || ''),
    configError: String(state.configError || ''),
    changedAt: (prev.changedAt && prev.signedIn === !!state.signedIn) ? prev.changedAt : Date.now(),
  };
  await chrome.storage.local.set({ [AUTH_KEY]: next });
  return next;
}

async function onStorageChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') cb(changes);
  });
}

export {
  PATCHES_KEY,
  SETTINGS_KEY,
  AUTH_KEY,
  DEFAULT_SETTINGS,
  getAuthCache,
  setAuthCache,
  getDomain,
  getPatchMap,
  savePatchMap,
  getPatchesFor,
  addPatch,
  deletePatch,
  resetDomain,
  setPatchAspectEnabled,
  getSettings,
  saveSettings,
  onStorageChanged,
};
