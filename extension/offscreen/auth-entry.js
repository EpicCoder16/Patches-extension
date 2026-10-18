'use strict';

// Patches — offscreen auth document (MV3).
//
// Service workers cannot use IndexedDB, but Firebase Auth needs it for a
// persistent sign-in session. This offscreen document hosts the Firebase SDK
// (bundled locally — no remote code per MV3) and reuses the repository's
// existing firebase-config.json and Firestore schema:
//   users/{uid}/data/patches → { json: <stringified patchMap>, updatedAt }
//
// Messaging contract (all messages carry target):
//   background → here:  { target: 'offscreen-auth', type: 'auth-sign-in' | 'auth-sign-up'
//                         | 'auth-sign-out' | 'auth-send-reset' | 'auth-get-state'
//                         | 'auth-load-cloud' | 'auth-save-cloud', ... }
//   here → background:  { target: 'background', type: 'auth-state-changed',
//                         signedIn, uid, email, configError }

import { initializeApp } from 'firebase/app';
import {
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  indexedDBLocalPersistence,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';

let app = null;
let auth = null;
let db = null;
let configError = '';
let currentUser = null;

async function init() {
  let cfg;
  try {
    const res = await fetch(chrome.runtime.getURL('offscreen/firebase-config.json'));
    cfg = await res.json();
  } catch (e) {
    configError = 'Firebase configuration is missing from the build. Rebuild the extension.';
    return;
  }
  if (!cfg || !cfg.apiKey || !cfg.authDomain || !cfg.projectId || !cfg.appId) {
    configError = 'Firebase configuration is incomplete. Ask the maintainer to fill in firebase-config.json.';
    return;
  }
  try {
    app = initializeApp(cfg);
    auth = getAuth(app);
    db = getFirestore(app);
    // Persistent sessions: IndexedDB works in offscreen documents (not in service workers).
    await setPersistence(auth, indexedDBLocalPersistence).catch(async () => {
      // Some environments block IndexedDB persistence; fall back to session-level.
      await setPersistence(auth, browserSessionPersistence);
    });
    onAuthStateChanged(auth, (user) => {
      currentUser = user || null;
      broadcastState();
    });
  } catch (e) {
    configError = `Firebase failed to initialize: ${e && e.message ? e.message : e}`;
  }
}

function snapshotState() {
  return {
    signedIn: Boolean(currentUser),
    uid: currentUser ? currentUser.uid : '',
    email: currentUser && currentUser.email ? currentUser.email : '',
    configError,
  };
}

function broadcastState() {
  try {
    chrome.runtime.sendMessage({ target: 'background', type: 'auth-state-changed', ...snapshotState() }, () => {
      void chrome.runtime.lastError; // background asleep — the cache is written on next query
    });
  } catch { /* extension context iterating */ }
}

// ── Firestore patch sync (schema reused from the desktop app) ────────────────
function patchesDoc(uid) {
  return doc(db, 'users', uid, 'data', 'patches');
}

async function loadCloudPatches() {
  if (!currentUser || !db) return {};
  try {
    const snap = await getDoc(patchesDoc(currentUser.uid));
    if (!snap.exists() || !snap.data() || !snap.data().json) return {};
    const raw = snap.data().json;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    const err = new Error(`Could not load cloud patches: ${e && e.code ? e.code : e && e.message ? e.message : e}`);
    err.cloudSync = true;
    throw err;
  }
}

async function saveCloudPatches(patchMap) {
  if (!currentUser || !db) {
    return { ok: false, error: 'Signed out — cloud sync skipped.' };
  }
  try {
    await setDoc(patchesDoc(currentUser.uid), { json: JSON.stringify(patchMap), updatedAt: Date.now() }, { merge: true });
    return { ok: true };
  } catch (e) {
    const err = new Error(`Could not save patches to the cloud: ${e && e.code ? e.code : e && e.message ? e.message : e}`);
    err.cloudSync = true;
    throw err;
  }
}

// ── Auth operations (error mapping ported from renderer/auth.js) ─────────────
const AUTH_ERROR_MESSAGES = {
  'auth/email-already-in-use': 'An account with this email already exists. Try signing in.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/user-not-found': 'No account found for this email.',
  'auth/wrong-password': 'Incorrect password.',
  'auth/invalid-credential': 'Invalid email or password.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/missing-password': 'Enter your password.',
  'auth/network-request-failed': 'Network error — check your connection and try again.',
  'auth/operation-not-allowed': 'Email/password sign-in is not enabled for this Firebase project (Authentication → Sign-in method).',
};

function authError(err) {
  const code = err && err.code ? err.code : '';
  return AUTH_ERROR_MESSAGES[code] || (err && err.message) || 'Authentication failed.';
}

async function handle(message) {
  if (!message || !message.type) return { ok: false, error: 'Bad auth message.' };

  switch (message.type) {
    case 'auth-get-state':
      return { ok: true, ...snapshotState() };

    case 'auth-sign-in': {
      if (!auth) return { ok: false, error: configError || 'Authentication is unavailable.' };
      await signInWithEmailAndPassword(auth, String(message.email || ''), String(message.password || ''));
      return { ok: true, ...snapshotState() };
    }

    case 'auth-sign-up': {
      if (!auth) return { ok: false, error: configError || 'Authentication is unavailable.' };
      await createUserWithEmailAndPassword(auth, String(message.email || ''), String(message.password || ''));
      return { ok: true, ...snapshotState() };
    }

    case 'auth-sign-out': {
      if (auth) await signOut(auth);
      return { ok: true, ...snapshotState() };
    }

    case 'auth-send-reset': {
      if (!auth) return { ok: false, error: configError || 'Authentication is unavailable.' };
      await sendPasswordResetEmail(auth, String(message.email || ''));
      return {
        ok: true,
        message: `Password reset email sent to ${String(message.email || '')}. Check your inbox.`,
      };
    }

    case 'auth-load-cloud':
      return { ok: true, patches: await loadCloudPatches() };

    case 'auth-save-cloud':
      return await saveCloudPatches(message.patches || {});

    default:
      return { ok: false, error: `Unknown auth message: ${message.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen-auth') return false;
  (async () => {
    try {
      sendResponse(await handle(message));
    } catch (e) {
      sendResponse({ ok: false, error: authError(e) });
    }
  })().catch(() => sendResponse({ ok: false, error: 'Unexpected authentication failure.' }));
  return true; // async sendResponse
});

init();
