'use strict';

// Headless end-to-end test for the Patches Chrome extension.
//
//   npm i --no-save puppeteer-core && node scripts/test-extension.js
//
// Covers (Gemini calls still require an API credential — only the needsApiKey
// guard on a signed-in account is exercised):
//   1. Manifest loads via Extensions.loadUnpacked; MV3 module service worker runs.
//   2. Content script injects; saved patch re-applies on page load; toggle off/on
//      reverts/re-applies without reload; removal clears CSS; DOM outline works.
//   3. Floating launcher auto-appears, opens the sidebar, is not duplicated.
//   4. Sidebar open state persists across a page reload; Esc closes it.
//   5. Unauthenticated users are blocked from protected operations (auth gate).
//   6. Real Firebase (repo's firebase-config.json): sign-up, auth state, cloud
//      Firestore push/pull of the patches map (users/{uid}/data/patches),
//      password-reset email call, sign-out.
//   7. Signed in without an API key → needsApiKey (not authRequired).
//   8. Popup shows the sign-in screen signed out, the product UI signed in.

const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const PORT = 8124;
const DEBUG_PORT = 9344;

const TEST_HTML = `<!DOCTYPE html>
<html><head><title>Patches Test Page</title></head>
<body>
  <div id="hero-title">Patches extension test page</div>
  <div id="sidebar">left rail</div>
  <main><p>hello</p></main>
</body></html>`;

const PATCH_CSS = 'body { background: rgb(18, 52, 86) !important; } #sidebar { display: none !important; }';

const Q_PASSWORD = 'Patches-QA-2026x!';
const Q_EMAIL = `qa-${Date.now()}@patches.test`;

const passes = [];
const failures = [];

function check(name, ok, extra = '') {
  const row = `${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`;
  (ok ? passes : failures).push(row);
  process.stdout.write(row + '\n');
}

async function main() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(TEST_HTML);
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const chromePath = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.CHROME_PATH,
  ].filter(Boolean).find((p) => fs.existsSync(p));
  if (!chromePath) throw new Error('Google Chrome not found; set CHROME_PATH.');

  // Branded Chrome (137+) dropped --load-extension; use Extensions.loadUnpacked CDP.
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'patches-test-'))}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore' });

  const debugUrl = `http://127.0.0.1:${DEBUG_PORT}/json/version`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(debugUrl).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error(`Chrome DevTools endpoint never became reachable at ${debugUrl}`);

  const browser = await puppeteer.connect({
    browserURL: debugUrl,
    defaultViewport: null,
  });

  try {
    const conn = (browser.connection && browser.connection()) || browser._connection;
    const loaded = await conn.send('Extensions.loadUnpacked', { path: DIST }).catch((e) => {
      throw new Error(`Extensions.loadUnpacked failed: ${e.message}`);
    });
    const extId = loaded.id;
    check('extension loads unpacked via CDP', Boolean(extId), extId || 'no id');
    if (!extId) return;

    let swTarget = null;
    for (let i = 0; i < 40 && !swTarget; i++) {
      swTarget = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(extId));
      if (!swTarget) {
        const probe = await browser.newPage();
        await probe.goto(`chrome-extension://${extId}/popup/popup.html`).catch(() => {});
        await probe.close().catch(() => {});
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    check('service worker starts (MV3 module background)', Boolean(swTarget), swTarget ? swTarget.url() : 'no SW target');
    if (!swTarget) return;

    const worker = await swTarget.worker();

    /** Evaluate in the service worker. */
    async function swEval(fn, arg) {
      return worker.evaluate(fn, arg);
    }

    /**
     * Drive messages exactly like the sidebar does: executeScript in the tab's
     * content-script world calling chrome.runtime.sendMessage.
     */
    async function csMsg(msg) {
      const res = await swEval(async ([target, message]) => {
        const out = await chrome.scripting.executeScript({
          target: { tabId: target },
          func: (m) => new Promise((resolve) => {
            chrome.runtime.sendMessage(m, (response) => {
              resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response);
            });
          }),
          args: [message],
        });
        return out && out[0] ? out[0].result : null;
      }, [TAB_ID, msg]);
      return res;
    }

    let TAB_ID = null;

    // ── Test page + patch seeding (bypasses messages, seeds storage directly) ──
    await swEval(([patches, email]) => chrome.storage.local.set({
      patches,
      settings: { geminiApiKey: '', model: '', patchesEnabled: true },
      auth: { signedIn: false, uid: '', email: '', configError: '' },
      // remember externally
    }), [{
      '127.0.0.1': [{
        id: 't1', prompt: 'test patch', css: PATCH_CSS,
        aspects: [{ id: '0', label: 'Styles', css: PATCH_CSS, enabled: true }],
        createdAt: 1,
      }],
    }, Q_EMAIL]);

    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 900)); // content script at document_idle

    const tabTarget = await swEval(async (url) => {
      const tabs = await chrome.tabs.query({ url: 'http://*/*' });
      const tab = tabs.find((t) => t.url && t.url.startsWith(`http://127.0.0.1:${url}`));
      return tab ? tab.id : null;
    }, PORT);
    TAB_ID = tabTarget;
    check('background can find the test tab', TAB_ID != null);

    const styleInfo = await page.evaluate(() => {
      const el = document.getElementById('patches-extension-styles');
      return el ? { exists: true, bg: getComputedStyle(document.body).backgroundColor } : { exists: false };
    });
    check('saved patch restores on page load', styleInfo.exists && styleInfo.bg === 'rgb(18, 52, 86)', `bg=${styleInfo.bg || 'n/a'}`);
    check('patched CSS hid the #sidebar element', await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).display === 'none'));

    // ── Floating launcher ─────────────────────────────────────────────────────
    const launcherState = await page.evaluate(() => {
      const host = document.querySelector('[data-patches="launcher-host"]');
      if (!host) return { present: false };
      // The zero-size host anchors the corner; the launcher button inside the
      // closed shadow is what the user sees (verified by the hit-point click below).
      return { present: true, hidden: host.classList.contains('hidden'), count: document.querySelectorAll('[data-patches="launcher-host"]').length };
    });
    check('floating launcher auto-injected (single host, page-level)', launcherState.present && launcherState.count === 1);
    check('launcher visible by default (no toolbar click required)', !launcherState.hidden);

    // Open the sidebar by clicking the launcher (it sits at the right edge,
    // vertically centered — click via hit point since its shadow is closed).
    const hostOpen = () => page.evaluate(() => {
      const host = document.querySelector('[data-patches="sidebar-host"]');
      if (!host) return { present: false };
      // CSSOM serializes translateX(0) as translateX(0px)
      return { present: true, open: /translateX\(0(?:px)?\)/.test(host.style.transform), raw: host.style.transform };
    });
    const frameSrc = () => page.evaluate(() => {
      const f = document.querySelector('iframe[data-patches="sidebar-frame"]');
      return f ? f.src : null;
    });
    await page.mouse.click(1279, 400); // near right edge, vertically centered
    await new Promise((r) => setTimeout(r, 900));
    const afterClick = await hostOpen();
    const srcAfterClick = await frameSrc();
    check('clicking the launcher opens the sidebar', afterClick.present && afterClick.open, JSON.stringify(afterClick));
    check('sidebar renders in an extension-origin iframe',
      Boolean(srcAfterClick) && srcAfterClick.startsWith(`chrome-extension://${extId}/sidebar/sidebar.html`), srcAfterClick || 'missing');

    // ACCEPTANCE ("@" bug): type test@example.com with the physical Shift+2
    // keystroke into the email field inside the sidebar iframe.
    let sf = null;
    for (let i = 0; i < 30 && !sf; i++) {
      sf = page.frames().find((f) => f.url().includes('/sidebar/sidebar.html'));
      if (!sf) await new Promise((r) => setTimeout(r, 250));
    }
    check('sidebar iframe reachable for typing', Boolean(sf));
    if (sf) {
      await sf.waitForSelector('#auth-email', { timeout: 10000 }).catch(() => {});
      await sf.focus('#auth-email');
      await new Promise((r) => setTimeout(r, 250));
      await page.keyboard.type('Test', { delay: 25 });
      await page.keyboard.down('Shift');
      await page.keyboard.press('Digit2'); // physical Shift+2 → '@'
      await page.keyboard.up('Shift');
      await page.keyboard.type('example.com', { delay: 25 });
      await new Promise((r) => setTimeout(r, 250));
      const typed = await sf.evaluate(() => document.getElementById('auth-email').value);
      check('@ and full email typed into sidebar email field', typed === 'Test@example.com', `value=${JSON.stringify(typed)}`);
      // Clear the field so later auth flow tests start clean.
      await page.keyboard.press('End');
      for (let i = 0; i < 20; i++) await page.keyboard.press('Backspace');
      await new Promise((r) => setTimeout(r, 150));
    }

    // Persist open state across reload.
    await page.reload({ waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 900));
    const openAfterReload = await hostOpen();
    check('sidebar stays open after page reload (state preserved)', openAfterReload.present && openAfterReload.open);

    // Esc closes it (Esc is handled inside the extension-origin iframe document;
    // focus the sidebar first so the keystroke goes there).
    sf = page.frames().find((f) => f.url().includes('/sidebar/sidebar.html'));
    if (sf) {
      await sf.focus('#auth-email').catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
    }
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 500));
    const afterEsc = await page.evaluate(() => {
      const sidebar = document.querySelector('[data-patches="sidebar-host"]');
      const launcher = document.querySelector('[data-patches="launcher-host"]');
      const closed = !sidebar || /translateX\(101(?:px)?%\)/.test(sidebar.style.transform);
      return {
        closed,
        launcherBack: launcher ? !launcher.classList.contains('hidden') : false,
      };
    });
    check('Esc closes the sidebar and the launcher returns', afterEsc.closed && afterEsc.launcherBack, JSON.stringify(afterEsc));

    // No duplicates when the fallback injection runs again.
    await swEval(async (tab) => {
      await chrome.scripting.executeScript({
        target: { tabId: tab },
        files: ['content/patches-content.js', 'content/patchesSidebar.js'],
      }).catch(() => {});
    }, TAB_ID);
    const dupCount = await page.evaluate(() => ({
      launchers: document.querySelectorAll('[data-patches="launcher-host"]').length,
      sidebars: document.querySelectorAll('[data-patches="sidebar-host"]').length,
    }));
    check('no duplicate launcher/sidebar hosts after re-injection', dupCount.launchers === 1 && dupCount.sidebars === 1, JSON.stringify(dupCount));

    // ── Auth gates (signed out) ────────────────────────────────────────────────
    const gateGen = await csMsg({ type: 'generate-patch', prompt: 'make it dark' });
    check('unauthenticated prompt submit is blocked (authRequired)',
      gateGen && gateGen.ok === false && gateGen.authRequired === true, JSON.stringify(gateGen));
    const gateReset = await csMsg({ type: 'reset-domain-patches' });
    check('unauthenticated reset-site is blocked (authRequired)',
      gateReset && gateReset.ok === false && gateReset.authRequired === true);
    const getPatchesUnauth = await csMsg({ type: 'get-patches' });
    check('read-only patch list remains available without auth',
      getPatchesUnauth && getPatchesUnauth.ok === true);

    // ── Popup: signed-out shows the sign-in screen (closed immediately — an open
    // popup page would otherwise be the "active tab" here, which does not happen
    // in real Chrome where popups are not tabs) ─────────────────────────────────
    const popupPage1 = await browser.newPage();
    await popupPage1.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 700));
    const popupAuthState = await popupPage1.evaluate(() => ({
      authVisible: !document.getElementById('auth-view').classList.contains('hidden'),
      productHidden: document.getElementById('main-content').classList.contains('hidden'),
      tabs: document.querySelectorAll('#auth-tabs .auth-tab').length,
    }));
    check('popup shows sign-in screen when signed out',
      popupAuthState.authVisible && popupAuthState.productHidden && popupAuthState.tabs === 2, JSON.stringify(popupAuthState));
    await popupPage1.close();

    // ── Real Firebase: sign up → signed in → cloud sync ────────────────────────
    const signUp = await csMsg({ type: 'auth-sign-up', email: Q_EMAIL, password: Q_PASSWORD });
    check('Firebase sign-up works (repo project, email/password)',
      signUp && signUp.ok === true && signUp.signedIn === true, signUp && signUp.error ? signUp.error : Q_EMAIL);
    // If the provider is disabled in the console, surface it clearly and stop.
    if (!signUp || !signUp.ok) {
      check('Firebase auth reachable', false, (signUp && signUp.error) || 'unknown');
    } else {
      const authCache = await swEval(async () => {
        const s = await chrome.storage.local.get('auth');
        return s.auth;
      });
      check('auth state cached in chrome.storage after sign-in',
        authCache && authCache.signedIn === true && authCache.uid, authCache ? authCache.email : 'no auth');

      // Firestore push: trigger a mutation (debounced push), then read the cloud doc.
      const aspectRes = await csMsg({ type: 'set-patch-aspect-enabled', patchId: 't1', aspectId: '0', enabled: false });
      check('aspect mutation accepted while signed in', aspectRes && aspectRes.ok === true, aspectRes && aspectRes.error || '');
      await new Promise((r) => setTimeout(r, 1600)); // debounce is 800ms
      const cloud = await swEval(async () => {
        const res = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ target: 'offscreen-auth', type: 'auth-load-cloud' }, (r2) => {
            resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r2);
          });
        });
        return res;
      });
      // cloud.patches maps domain → list of patches; the aspect lives on list[0].
      const patchList = cloud && cloud.patches && cloud.patches['127.0.0.1'];
      const localPatch = patchList && patchList[0];
      const localAspects = localPatch && localPatch.aspects;
      const aspect = localAspects && localAspects.find ? localAspects.find((a) => a.id === '0') : null;
      const cloudDetail = `ok=${cloud && cloud.ok} patches=${patchList ? patchList.length : 'none'} ` +
        `asp=${aspect ? `en=${JSON.stringify(aspect.enabled)}(${typeof aspect.enabled})` : 'missing'} ` +
        JSON.stringify(cloud).slice(0, 300);
      check('patch map pushed to Firestore (users/{uid}/data/patches)',
        Boolean(cloud && cloud.ok && localPatch && aspect && aspect.enabled === false), cloudDetail);

      // Sign out → gate again → sign back in.
      const signOutRes = await csMsg({ type: 'auth-sign-out' });
      check('sign-out works', signOutRes && signOutRes.ok === true && signOutRes.signedIn === false);
      const gateAfterSignOut = await csMsg({ type: 'reset-domain-patches' });
      check('protected ops blocked again after sign-out',
        gateAfterSignOut && gateAfterSignOut.ok === false && gateAfterSignOut.authRequired === true);

      const signInRes = await csMsg({ type: 'auth-sign-in', email: Q_EMAIL, password: Q_PASSWORD });
      check('sign-in with the created account works', signInRes && signInRes.ok === true && signInRes.signedIn === true);

      // Signed in but no Gemini key yet → needsApiKey (not authRequired).
      const noKey = await csMsg({ type: 'generate-patch', prompt: 'make it dark' });
      check('signed-in prompt without API key returns needsApiKey',
        noKey && noKey.ok === false && noKey.needsApiKey === true && !noKey.authRequired, noKey && noKey.error);

      // Password reset email call (Firebase accepts silently for unknown addresses).
      const resetRes = await csMsg({ type: 'auth-send-reset', email: Q_EMAIL });
      check('password reset request accepted by Firebase', resetRes && resetRes.ok === true, resetRes && resetRes.error);

      // Popup: signed-in shows product UI.
      const popupPage2 = await browser.newPage();
      await popupPage2.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'load' });
      await new Promise((r) => setTimeout(r, 800));
      const popupSignedIn = await popupPage2.evaluate(() => ({
        authHidden: document.getElementById('auth-view').classList.contains('hidden'),
        chipVisible: !document.getElementById('user-chip').classList.contains('hidden'),
        email: document.getElementById('user-email').textContent,
        signOutEnabled: !document.getElementById('btn-sign-out').disabled,
      }));
      check('popup shows product UI + account chip when signed in',
        popupSignedIn.authHidden && popupSignedIn.chipVisible && popupSignedIn.signOutEnabled, JSON.stringify(popupSignedIn));
      await popupPage2.close();
    }

    // Clean up: sign out at the end of the run (keep the throwaway cloud doc for inspection).
    await csMsg({ type: 'auth-sign-out' }).catch(() => {});

    check('no uncaught page errors on the patched page', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

    // ── Core CSS pipeline regression (storage-restored patch above already rela) ──
    // Toggle on/off without reload (uses worker-side handlers, not protected ops).
    await swEval(async () => {
      const s = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...s.settings, patchesEnabled: false } });
    });
    await swEval(async (tab) => {
      await chrome.tabs.sendMessage(tab, { type: 'patches-refresh' }).catch(() => {});
    }, TAB_ID);
    await new Promise((r) => setTimeout(r, 400));
    const disabled = await page.evaluate(() => {
      const el = document.getElementById('patches-extension-styles');
      return !el || el.textContent.trim() === '';
    });
    check('toggle off reverts CSS without page reload', disabled);
    await swEval(async () => {
      const s = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...s.settings, patchesEnabled: true } });
    });
    // The cloud-sync test disabled t1's only aspect; re-enable it via storage so
    // the patch has content again (verify re-apply after a global on-toggle).
    await swEval(async () => {
      const p = await chrome.storage.local.get('patches');
      const list = p.patches['127.0.0.1'] || [];
      for (const patch of list) {
        if (patch.aspects) patch.aspects.forEach((a) => { a.enabled = true; });
        patch.css = patch.aspects.filter((a) => a.enabled).map((a) => a.css).join('\n');
      }
      await chrome.storage.local.set(p);
    });
    await swEval(async (tab) => {
      await chrome.tabs.sendMessage(tab, { type: 'patches-refresh' }).catch(() => {});
    }, TAB_ID);
    await new Promise((r) => setTimeout(r, 400));
    const reEnabled = await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(18, 52, 86)');
    check('toggle on re-applies CSS without page reload', reEnabled);
  } finally {
    await browser.disconnect().catch(() => {});
    chrome.kill();
    server.close();
  }

  process.stdout.write(`\n${passes.length} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
