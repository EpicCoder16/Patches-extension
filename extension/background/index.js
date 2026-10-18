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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

async function ensureContentScript(tab) {
  if (!tab || typeof tab.id !== 'number' || !tabInfo(tab).injectable) return false;
  const ping = await sendToTab(tab.id, { type: 'patches-ping' });
  if (ping && ping.ok) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/patches-content.js', 'content/patchesSidebar.js'],
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
      error: 'Sign in to use Patches. Open the sidebar or popup to sign in or create an account.',
    };
  }
  return null;
}

// ── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Messages from the offscreen auth document (auth-state broadcasts) and the
  // sidebar iframe's readiness ping. Unknown types within this targeted
  // namespace must FAIL loudly — silently ACKing them masks lost writes.
  if (message && message.target === 'background') {
    (async () => {
      if (message.type === 'auth-state-changed') {
        await setAuthCache(message);
        if (message.signedIn) await syncCloudIntoLocal();
        sendResponse({ ok: true });
      } else if (message.type === 'sidebar-view-ready') {
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

async function handleMessage(message) {
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
          launcherEnabled: settings.launcherEnabled !== false,
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

    case 'set-launcher-enabled': {
      await saveSettings({ launcherEnabled: !!message.enabled });
      await revealLauncherOnAllTabs();
      return { ok: true, enabled: !!message.enabled };
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

async function revealLauncherOnAllTabs() {
  const settings = await getSettings();
  await forEachWebTab(async (tab) => {
    await sendToTab(tab.id, {
      type: 'patches-ui',
      launcherEnabled: settings.launcherEnabled !== false,
    });
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  // Seed defaults without clobbering existing user data on update.
  await saveSettings({
    patchesEnabled: settings.patchesEnabled !== undefined ? settings.patchesEnabled : DEFAULT_SETTINGS.patchesEnabled,
  });
  // Warm the auth document so sign-in state appears before first interaction.
  await ensureOffscreenDocument();
  await syncCloudIntoLocal();
});
