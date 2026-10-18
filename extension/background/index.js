'use strict';

// Patches — MV3 background service worker.
// Coordinates AI patch generation (kept out of the content script and page),
// patch persistence, cloud sync, and auth gating via the offscreen Firebase
// auth document.
//
// MV3 lifecycle: this worker sleeps between events and holds no long-lived
// state; everything lives in chrome.storage.local and chrome.tabs.
// Firebase Authentication runs in an offscreen document (IndexedDB), because
// service workers cannot use IndexedDB, which persistent auth sessions require.

import {
  getDomain,
  getPatchesFor,
  getPatchMap,
  savePatchMap,
  addPatch,
  deletePatch,
  resetDomain,
  setPatchAspectEnabled,
  getSettings,
  saveSettings,
  getAuthCache,
  setAuthCache,
  DEFAULT_SETTINGS,
} from './patchStore.js';
import {
  normalisePatch,
  generateCSSFromPrompt,
  SUPPORTED_MODELS,
  DEFAULT_MODEL,
} from './patchAgent.js';
import { isValidGeminiApiKey, maskKey } from './geminiKey.js';

const INJECTABLE_PROTOCOLS = new Set(['http:', 'https:']);
const RESTRICTED_HOST_SUFFIXES = ['chromewebstore.google.com'];

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// Message types that require a signed-in Firebase session.
const PROTECTED_TYPES = new Set([
  'generate-patch',
  'delete-patch',
  'reset-domain-patches',
  'set-patch-aspect-enabled',
  'toggle-patches',
  'save-api-key',
]);

function isInjectableUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!INJECTABLE_PROTOCOLS.has(parsed.protocol)) return false;
  return !RESTRICTED_HOST_SUFFIXES.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
}

async function getActiveTab() {
  // Side panel pages have no window of their own; "lastFocusedWindow" resolves
  // the web tab the user is actually on for both panel and popup callers.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function tabInfo(tab) {
  if (!tab || !tab.url) {
    return { url: '', domain: '', injectable: false };
  }
  return {
    url: tab.url,
    domain: getDomain(tab.url),
    injectable: isInjectableUrl(tab.url),
  };
}

// ── Offscreen auth document lifecycle ────────────────────────────────────────
// Firebase Auth needs IndexedDB; service workers don't have it, so auth runs
// in an offscreen document reusing the repo's firebase-config.json.
async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return true;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS'],
      justification: 'Firebase Authentication requires IndexedDB for persistent sessions, which service workers cannot access.',
    });
  } catch {
    // Concurrent creation is fine; the document wins either way.
  }
  return true;
}

/**
 * Send a targeted message to the offscreen auth document, retrying while the
 * document spins up (its module script + Firebase config fetch take a moment).
 */
async function sendToOffscreen(message, { tries = 20, delayMs = 250 } = {}) {
  await ensureOffscreenDocument();
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage({ ...message, target: 'offscreen-auth' }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'No response from offscreen auth document.' });
        });
      });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (!/Receiving end does not exist/i.test(msg) && attempt >= tries - 1) {
        return { ok: false, error: msg };
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { ok: false, error: 'Authentication service did not become ready.' };
}

// ── Content script helpers ───────────────────────────────────────────────────
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

// ── Native side panel: launcher toggle + authoritative open state ──────────
// ROOT-CAUSE NOTE (regression fix): chrome.sidePanel.open() carries the
// click's user-gesture context ONLY when it is the first extension call on
// the message path. The previous toggle implementation awaited a
// chrome.storage.local read in the worker BEFORE calling open(), which
// invalidates that gesture context and makes open() reject with "may only be
// called in response to a user gesture" — the panel then never opened.
// The LAUNCHER now reads the persisted state in the page (no gesture cost)
// and commands 'open-side-panel' or 'close-side-panel'; the worker calls
// open() as its very first operation. close() is not gesture-gated (verified
// on Chrome 155) and may await freely; it self-corrects stale state.
//
// Authoritative lifecycle: sidePanel.onOpened/onClosed events fire for
// programmatic opens, other open paths, and the user's manual ✕; each event
// is mirrored to chrome.storage.local ('panelOpen') so the freshly restarted
// worker (and the launcher) never act on a stale default. The state is never
// inferred from sidePanel.getOptions().
const PANEL_OPEN_KEY = 'panelOpen';

// Lifecycle-event bookkeeping for close verification. sidePanel.close()
// resolves EVEN WHEN NO PANEL WAS OPEN (idempotent), so a resolved close does
// not prove the tracked state was right: Chrome fires onClosed ONLY for a
// real close. If any lifecycle event has been seen (panelEventsSeen) we wait
// briefly for an onClosed after the call; no event → nothing was actually
// open → report 'corrected' so the launcher can re-open within same gesture.
// If no events have been observed (test doubles, very old Chrome), trust the
// close result. Worker restarts are covered by the persisted state + events.
let panelEventsSeen = false;
let lastPanelClosedAt = 0;

async function persistPanelState(open, scope = {}) {
  await chrome.storage.local.set({
    [PANEL_OPEN_KEY]: {
      open: !!open,
      tabId: Number.isFinite(scope.tabId) ? scope.tabId : null,
      windowId: Number.isFinite(scope.windowId) ? scope.windowId : null,
      at: Date.now(),
    },
  });
}

async function getPanelOpenState() {
  const stored = await chrome.storage.local.get(PANEL_OPEN_KEY);
  const entry = stored[PANEL_OPEN_KEY];
  return {
    open: Boolean(entry && entry.open),
    tabId: entry && Number.isFinite(entry.tabId) ? entry.tabId : null,
    windowId: entry && Number.isFinite(entry.windowId) ? entry.windowId : null,
    known: Boolean(entry),
  };
}

// Feature-detected: on builds without the events the optimistic writes made
// alongside each successful open/close keep the state usable.
if (chrome.sidePanel && chrome.sidePanel.onOpened && typeof chrome.sidePanel.onOpened.addListener === 'function') {
  chrome.sidePanel.onOpened.addListener(async (info) => {
    panelEventsSeen = true;
    await persistPanelState(true, info || {});
  });
}
if (chrome.sidePanel && chrome.sidePanel.onClosed && typeof chrome.sidePanel.onClosed.addListener === 'function') {
  chrome.sidePanel.onClosed.addListener(async (info) => {
    panelEventsSeen = true;
    lastPanelClosedAt = Date.now();
    await persistPanelState(false, info || {});
  });
}

/** Resolves true when an onClosed event is observed after `afterMs` (a real
 * panel close), false when the short window elapses without an event. */
function waitForCloseEventAfter(afterMs, timeoutMs = 400) {
  if (!panelEventsSeen) return Promise.resolve(true); // events not observable — trust close()
  if (lastPanelClosedAt > afterMs) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (lastPanelClosedAt > afterMs) resolve(true);
      else if (Date.now() - started >= timeoutMs) resolve(false);
      else setTimeout(poll, 40);
    };
    poll();
  });
}

/**
 * Open the panel for the tab that clicked the launcher. GESTURE-CRITICAL:
 * chrome.sidePanel.open() is the FIRST await of this handler — the launcher
 * already performed the state lookup, so the worker must not await anything
 * before open() or the click's user gesture is invalidated.
 */
async function openSidePanelForSender(sender) {
  const { sidePanel } = chrome;
  if (!sidePanel || typeof sidePanel.open !== 'function') {
    return { ok: false, error: 'Chrome\u2019s side panel API is unavailable in this browser.' };
  }
  const tabId = sender && sender.tab && Number.isFinite(sender.tab.id) ? sender.tab.id : null;
  if (tabId != null) {
    try {
      await sidePanel.open({ tabId }); // first extension call — preserves the user gesture
      await persistPanelState(true, { tabId });
      return { ok: true, action: 'opened', tabId };
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/gesture/i.test(msg)) {
        // Programmatic calls without a pointer/keyboard gesture are rejected —
        // the real launcher click carries one, so this is tooling/test noise.
        return { ok: false, gestureRequired: true, error: msg };
      }
      return { ok: false, error: msg };
    }
  }
  // Rare: no sender tab (e.g. relayed message). Resolve the focused window —
  // an await is unavoidable here, but this path is not the launcher's.
  let windowId = null;
  try {
    const win = await chrome.windows.getLastFocused();
    windowId = win && win.id;
  } catch { /* no focused window */ }
  if (windowId == null) return { ok: false, error: 'Could not determine the tab the click came from.' };
  try {
    await sidePanel.open({ windowId });
    await persistPanelState(true, { windowId });
    return { ok: true, action: 'opened', windowId };
  } catch (err) {
    const msg = String((err && err.message) || err);
    return { ok: false, gestureRequired: /gesture/i.test(msg) || undefined, error: msg };
  }
}

/**
 * Close the panel. NOT gesture-gated (verified on Chrome 155): retry the
 * scope the panel was opened with first, then the current tab/window. If
 * Chrome reports no active panel for any scope, the tracked state was stale
 * — correct it (the onClosed event writes exactly this) and answer
 * action:'corrected' so the launcher can immediately re-request an open
 * within the same user-gesture click.
 */
async function closeSidePanelForSender(sender) {
  const { sidePanel } = chrome;
  if (!sidePanel || typeof sidePanel.open !== 'function') {
    return { ok: false, error: 'Chrome\u2019s side panel API is unavailable in this browser.' };
  }
  if (typeof sidePanel.close !== 'function') {
    // Older Chrome without sidePanel.close(): cannot close programmatically.
    return { ok: false, unsupported: true, error: 'This Chrome version cannot close the side panel programmatically; use Chrome\u2019s ✕.' };
  }
  const state = await getPanelOpenState();
  const senderTabId = sender && sender.tab && Number.isFinite(sender.tab.id) ? sender.tab.id : null;
  const senderWindowId = sender && sender.tab && Number.isFinite(sender.tab.windowId) ? sender.tab.windowId : null;
  let focusWindowId = state.windowId;
  if (focusWindowId == null) {
    try { const win = await chrome.windows.getLastFocused(); focusWindowId = win && win.id; } catch { /* none */ }
  }
  const scopes = [];
  const pushScope = (scope) => {
    if (!scope || !scopes.some((s) => ('tabId' in s ? s.tabId === scope.tabId : s.windowId === scope.windowId))) scopes.push(scope);
  };
  if (state.tabId != null) pushScope({ tabId: state.tabId });
  if (senderTabId != null) pushScope({ tabId: senderTabId });
  if (state.windowId != null) pushScope({ windowId: state.windowId });
  if (focusWindowId != null) pushScope({ windowId: focusWindowId });

  let gestureRequired = false;
  let lastError = null;
  for (const scope of scopes) {
    const callAt = Date.now();
    try {
      await sidePanel.close(scope);
    } catch (err) {
      lastError = String((err && err.message) || err);
      if (/gesture/i.test(lastError)) { gestureRequired = true; break; }
      // "No active … side panel" / "No tab with id" → panel not reachable in
      // that scope; try the next one.
      continue;
    }
    // Verify with the lifecycle event that a panel was really closed — a
    // resolved close() may be a no-op when the tracked state was stale.
    const reallyClosed = await waitForCloseEventAfter(callAt);
    await persistPanelState(false, scope);
    return { ok: true, action: reallyClosed ? 'closed' : 'corrected' };
  }
  if (gestureRequired) return { ok: false, gestureRequired: true, error: lastError };
  // Stale-state recovery: Chrome has no active panel in any known scope (the
  // user closed it via Chrome's ✕, a restart cleared it, or scope ids aged).
  await persistPanelState(false, { tabId: state.tabId, windowId: state.windowId });
  return { ok: true, action: 'corrected' };
}

async function ensureContentScript(tab) {
  if (!tab || typeof tab.id !== 'number' || !tabInfo(tab).injectable) return false;
  const ping = await sendToTab(tab.id, { type: 'patches-ping' });
  if (ping && ping.ok) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/patches-content.js', 'content/launcher.js'],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Cloud sync (schema + rules reused from the desktop app) ──────────────────
function mergePatchesPreferCloud(cloud, local) {
  const cloudKeys = Object.keys(cloud || {});
  if (cloudKeys.length) return cloud;
  return local || {};
}

async function syncCloudIntoLocal() {
  const auth = await getAuthCache();
  if (!auth.signedIn) return;
  const cloudRes = await sendToOffscreen({ type: 'auth-load-cloud' });
  if (!cloudRes || !cloudRes.ok) return;
  const local = await getPatchMap();
  const merged = mergePatchesPreferCloud(cloudRes.patches, local);
  const localKeys = Object.keys(local || {});
  const changed = JSON.stringify(merged) !== JSON.stringify(local);
  await savePatchMap(merged);
  await refreshAllPatches();
  // Upload local-only patches so a fresh account on a new device keeps its work,
  // mirroring the desktop app's shouldUploadLocal behaviour.
  const shouldUpload = !Object.keys(cloudRes.patches || {}).length && localKeys.length > 0;
  if (shouldUpload) {
    void pushPatchesToCloud();
  }
  void changed;
}

let pushTimer = null;
async function pushPatchesToCloud() {
  const auth = await getAuthCache();
  if (!auth.signedIn) return;
  const patchMap = await getPatchMap();
  const res = await sendToOffscreen({ type: 'auth-save-cloud', patches: patchMap });
  if (!res || !res.ok) {
    console.warn('[patches] cloud push skipped/failed:', (res && res.error) || 'unknown');
  }
}

/** Debounced push after local mutations so rapid toggles don't spam writes. */
function scheduleCloudPush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushPatchesToCloud().catch(() => {});
  }, 800);
}

// ── Auth gates ───────────────────────────────────────────────────────────────
async function requireAuth() {
  const auth = await getAuthCache();
  if (!auth.signedIn) {
    return {
      ok: false,
      authRequired: true,
      error: 'Sign in to use Patches. Open the side panel or popup to sign in or create an account.',
    };
  }
  return null;
}

// ── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages from the side panel page, the offscreen auth document (auth-state
  // broadcasts), and test hooks. Unknown types within this targeted namespace
  // must FAIL loudly — silently ACKing them masks lost writes.
  if (message && message.target === 'background') {
    (async () => {
      if (message.type === 'auth-state-changed') {
        await setAuthCache(message);
        if (message.signedIn) await syncCloudIntoLocal();
        sendResponse({ ok: true });
      } else if (message.type === 'panel-view-ready') {
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: `Invalid internal message: ${message.type}` });
      }
    })();
    return true;
  }

  (async () => {
    try {
      if (PROTECTED_TYPES.has(message.type)) {
        const gate = await requireAuth();
        if (gate) {
          sendResponse(gate);
          return;
        }
      }
      const result = await handleMessage(message, sender);
      sendResponse(result || { ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: (err && err.message) || String(err),
        geminiQuota: Boolean(err && err.geminiQuota),
        geminiModelUnavailable: Boolean(err && err.geminiModelUnavailable),
        networkProblem: Boolean(err && err.networkProblem),
        errorDetail: (err && (err.geminiErrorDetail || err.rawGeminiBody)) || undefined,
        needsApiKey: Boolean(err && err.needsApiKey),
        cloudSync: Boolean(err && err.cloudSync),
      });
    }
  })();
  return true; // async sendResponse
});

// ── Native side panel (opens on launcher click; user gesture required) ──────
async function handleMessage(message, sender) {
  const type = message && message.type;
  switch (type) {
    // ── Auth (relayed to the offscreen Firebase document) ─────────────────────
    case 'get-auth-state': {
      const cached = await getAuthCache();
      if (await hasOffscreenDocument()) {
        const fresh = await sendToOffscreen({ type: 'auth-get-state' }, { tries: 3, delayMs: 150 });
        if (fresh && fresh.ok) {
          await setAuthCache(fresh);
          return {
            ok: true,
            signedIn: fresh.signedIn,
            uid: fresh.uid,
            email: fresh.email,
            configError: fresh.configError || '',
          };
        }
      }
      return { ok: true, signedIn: Boolean(cached.signedIn), uid: cached.uid, email: cached.email, configError: cached.configError };
    }

    case 'auth-sign-in': {
      const res = await sendToOffscreen({ type: 'auth-sign-in', email: message.email, password: message.password });
      if (res && res.ok) {
        await setAuthCache(res);
        await syncCloudIntoLocal();
      }
      return res;
    }

    case 'auth-sign-up': {
      const res = await sendToOffscreen({ type: 'auth-sign-up', email: message.email, password: message.password });
      if (res && res.ok) {
        await setAuthCache(res);
        await syncCloudIntoLocal();
      }
      return res;
    }

    case 'auth-sign-out': {
      const res = await sendToOffscreen({ type: 'auth-sign-out' });
      if (res && res.ok) await setAuthCache({ signedIn: false, uid: '', email: '' });
      return res;
    }

    case 'auth-send-reset':
      return sendToOffscreen({ type: 'auth-send-reset', email: message.email });

    // ── Tabs / page state ─────────────────────────────────────────────────────
    case 'open-side-panel':
    case 'toggle-side-panel': // pre-toggle alias → behaves as open (safe default)
      return openSidePanelForSender(sender);

    case 'close-side-panel':
      return closeSidePanelForSender(sender);

    case 'get-tab-info': {
      const tab = await getActiveTab();
      return { ok: true, ...tabInfo(tab) };
    }

    case 'ensure-content-script': {
      const tab = await getActiveTab();
      const ready = await ensureContentScript(tab);
      return { ok: ready };
    }

    case 'generate-patch':
      return generatePatch(message.prompt);

    case 'get-patches': {
      const tab = await getActiveTab();
      const info = tabInfo(tab);
      const list = info.domain ? await getPatchesFor(info.domain) : [];
      return { ok: true, domain: info.domain, patches: list.map(normalisePatch) };
    }

    case 'delete-patch': {
      const tab = await getActiveTab();
      const info = tabInfo(tab);
      if (!info.injectable) return { ok: false, error: 'This page cannot be patched.' };
      await deletePatch(info.domain, message.patchId);
      await refreshTabPatches(info.url);
      scheduleCloudPush();
      return { ok: true };
    }

    case 'reset-domain-patches': {
      const tab = await getActiveTab();
      const info = tabInfo(tab);
      if (!info.injectable) return { ok: false, error: 'This page cannot be patched.' };
      await resetDomain(info.domain);
      await refreshTabPatches(info.url);
      scheduleCloudPush();
      return { ok: true };
    }

    case 'set-patch-aspect-enabled': {
      const tab = await getActiveTab();
      const info = tabInfo(tab);
      if (!info.injectable) return { ok: false, error: 'This page cannot be patched.' };
      await setPatchAspectEnabled(info.domain, message.patchId, message.aspectId, message.enabled);
      await refreshTabPatches(info.url);
      scheduleCloudPush();
      return { ok: true };
    }

    case 'toggle-patches': {
      await saveSettings({ patchesEnabled: !!message.enabled });
      await refreshAllPatches();
      return { ok: true, enabled: !!message.enabled };
    }

    // ── Settings ───────────────────────────────────────────────────────────────
    case 'get-settings': {
      const settings = await getSettings();
      return {
        ok: true,
        settings: {
          hasApiKey: Boolean(settings.geminiApiKey),
          maskedKey: settings.geminiApiKey ? maskKey(settings.geminiApiKey) : '',
          model: settings.model || DEFAULT_MODEL,
          supportedModels: SUPPORTED_MODELS,
          patchesEnabled: settings.patchesEnabled !== false,
        },
      };
    }

    case 'save-api-key': {
      const key = String(message.key || '').trim();
      if (!key) return { ok: false, error: 'API key is required.' };
      if (!isValidGeminiApiKey(key)) {
        return { ok: false, error: 'Gemini API key should start with AQ. (new authorization keys) or AIza (legacy).' };
      }
      await saveSettings({ geminiApiKey: key });
      return { ok: true, maskedKey: maskKey(key) };
    }

    case 'set-model': {
      const model = String(message.model || '').trim();
      if (!SUPPORTED_MODELS.includes(model)) return { ok: false, error: 'Unsupported model.' };
      await saveSettings({ model });
      return { ok: true, model };
    }

    default:
      return { ok: false, error: `Unknown message: ${type}` };
  }
}

// ── Patch generation (AI pipeline unchanged) ─────────────────────────────────
async function generatePatch(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: 'Describe the change you want first.' };

  const tab = await getActiveTab();
  const info = tabInfo(tab);
  if (!tab || !info.injectable) {
    return {
      ok: false,
      unsupported: true,
      error: 'Patches cannot modify browser pages like this one. Open a normal website (http/https) and try again.',
    };
  }

  const ready = await ensureContentScript(tab);
  if (!ready) {
    return {
      ok: false,
      error: 'Could not connect to this page. Reload the tab and try again.',
    };
  }

  const settings = await getSettings();
  if (!String(settings.geminiApiKey || '').trim()) {
    return {
      ok: false,
      needsApiKey: true,
      error: 'Add your Gemini API key in Settings to generate patches with AI.',
    };
  }

  const context = await sendToTab(tab.id, { type: 'get-page-context' });
  if (!context || !context.outline) {
    return {
      ok: false,
      error: 'Could not read this page\u2019s structure. Reload the tab and try again.',
    };
  }

  // MV3: while a long AI call is in flight, nothing else may keep this worker
  // alive. Poll an extension API periodically to reset the idle timer so the
  // request is not killed mid-generation.
  const keepalive = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* worker dying */ }
  }, 20000);

  let generated;
  try {
    generated = await generateCSSFromPrompt({
      prompt: text,
      domOutline: context.outline,
      domain: info.domain,
      apiKey: settings.geminiApiKey,
      model: settings.model || DEFAULT_MODEL,
    });
  } catch (err) {
    if (err && /network error/i.test(String(err.message || ''))) {
      // Fetch-level failure (DNS/firewall/captive portal/connection drop), not
      // an API-level error. Give users an actionable message instead of
      // the raw "Network error: Failed to fetch".
      const e2 = new Error(
        'Patches could not reach Google\u2019s Gemini API. Your network may be\n'
        + 'blocking it (some school or work networks do) or the connection dropped.\n'
        + 'Try again — or check the site on another network (e.g. phone hotspot).'
      );
      e2.networkProblem = true;
      e2.errorDetail = err.message;
      throw e2;
    }
    throw err;
  } finally {
    clearInterval(keepalive);
  }

  const aspects = generated.aspects.map((a, i) => ({
    id: String(i),
    label: a.label,
    css: a.css,
    enabled: true,
  }));
  const css = aspects.map((a) => a.css).join('\n');

  const patch = {
    id: `p-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    prompt: text,
    css,
    aspects,
    createdAt: Date.now(),
  };
  await addPatch(info.domain, patch);

  await sendToTab(tab.id, { type: 'patches-refresh' });
  scheduleCloudPush();

  return {
    ok: true,
    domain: info.domain,
    patch: normalisePatch(patch),
    usedModel: generated.usedModel,
    fallbackUsed: generated.fallbackUsed,
    fallbackError: generated.fallbackError,
  };
}

// ── Applying patches on tabs ─────────────────────────────────────────────────
async function forEachWebTab(cb) {
  const tabs = [
    ...await chrome.tabs.query({ url: 'http://*/*' }),
    ...await chrome.tabs.query({ url: 'https://*/*' }),
  ];
  for (const tab of tabs) {
    if (tab.id == null || !tab.url) continue;
    await cb(tab);
  }
}

async function refreshTabPatches(url) {
  const domain = getDomain(url || '');
  if (!domain) return;
  await forEachWebTab(async (tab) => {
    if (domain && getDomain(tab.url) !== domain) return;
    await sendToTab(tab.id, { type: 'patches-refresh' });
  });
}

async function refreshAllPatches() {
  await forEachWebTab(async (tab) => {
    await sendToTab(tab.id, { type: 'patches-refresh' });
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  // Seed default settings without clobbering existing user data on update.
  await saveSettings({
    patchesEnabled: settings.patchesEnabled !== undefined ? settings.patchesEnabled : DEFAULT_SETTINGS.patchesEnabled,
  });
  // The "Show floating launcher" setting was removed — drop the stale
  // preference so old data cannot disagree with the always-visible launcher.
  if ('launcherEnabled' in settings) {
    const rest = { ...settings };
    delete rest.launcherEnabled;
    await chrome.storage.local.set({ settings: rest });
  }
  // Warm the auth document so sign-in state appears before first interaction.
  await ensureOffscreenDocument();
  await syncCloudIntoLocal();
});
