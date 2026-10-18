'use strict';

// Patches — floating launcher (content script).
//
// A small, isolated shadow-DOM button on the right edge of the page, styled in
// the light sage-green brand palette. Clicking it asks the background service
// worker to TOGGLE Chrome's native side panel (open, or close if already
// open — the worker tracks authoritative state via sidePanel.onOpened/
// onClosed). The webpage reflows around the open panel instead of being
// covered. Message passing from this click carries the required user-gesture
// context into the worker. The launcher is always visible on supported pages.

(function () {
  const protocol = (location.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return;
  // chrome.runtime.id is undefined if the extension was reloaded/updated.
  if (!(chrome && chrome.runtime && chrome.runtime.id)) return;
  // Double-injection guard (declared content script + chrome.scripting fallback).
  if (window.__patchesLauncherInstalled) return;
  window.__patchesLauncherInstalled = true;

  const LOGO_URL = chrome.runtime.getURL('icons/icon32.png');

  const launcherHost = document.createElement('div');
  launcherHost.setAttribute('data-patches', 'launcher-host');
  // Zero-size anchor at the viewport corner; the button inside positions itself
  // fixed to the right edge, so it never affects the page's own layout.
  launcherHost.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483645;';
  const launcherRoot = launcherHost.attachShadow({ mode: 'closed' });
  const launcherStyle = document.createElement('style');
  launcherStyle.textContent = `
    :host { all: initial; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; }
    .launcher {
      position: fixed;
      top: 50%;
      right: 0;
      transform: translateY(-50%);
      width: 36px;
      height: 48px;
      padding: 0 5px 0 9px;
      display: flex;
      align-items: center;
      gap: 6px;
      border: 1px solid rgba(157, 185, 160, 0.75);
      border-right: none;
      border-radius: 10px 0 0 10px;
      background: #FDFDFD;
      color: #253329;
      box-shadow: -3px 2px 12px rgba(37, 51, 41, 0.14);
      cursor: pointer;
      pointer-events: auto;
      transition: background .15s, width .15s, box-shadow .15s, border-color .15s;
      overflow: hidden;
      white-space: nowrap;
    }
    .launcher img { width: 18px; height: 18px; border-radius: 5px; flex-shrink: 0; }
    .launcher .label {
      font-size: 11.5px; font-weight: 600; color: #253329;
      opacity: 0; transform: translateX(4px);
      transition: opacity .15s, transform .15s;
    }
    .launcher:hover, .launcher:focus-visible {
      width: 96px;
      background: #D2E1D5;
      border-color: rgba(96, 132, 99, 0.6);
      box-shadow: -4px 2px 16px rgba(37, 51, 41, 0.18);
      outline: none;
    }
    .launcher:hover .label, .launcher:focus-visible .label { opacity: 1; transform: none; }
    .launcher:focus-visible { outline: 2px solid #608463; outline-offset: -2px; }
    :host(.hidden) .launcher { display: none; }
  `;
  const launcherBtn = document.createElement('button');
  launcherBtn.className = 'launcher';
  launcherBtn.type = 'button';
  launcherBtn.setAttribute('aria-label', 'Open Patches');
  launcherBtn.title = 'Open Patches';
  launcherBtn.innerHTML = `<img src="${LOGO_URL}" alt="" draggable="false"/><span class="label">Patches</span>`;
  launcherRoot.appendChild(launcherStyle);
  launcherRoot.appendChild(launcherBtn);

  launcherBtn.addEventListener('click', () => {
    let contextInvalidated = false;
    try {
      if (!chrome.runtime || !chrome.runtime.id) contextInvalidated = true;
    } catch {
      contextInvalidated = true;
    }
    if (contextInvalidated) return;
    // Message from this click carries the Chrome-required user-gesture context;
    // the service worker opens or closes chrome.sidePanel for this tab.
    try {
      chrome.runtime.sendMessage({ type: 'toggle-side-panel' }, () => {
        void chrome.runtime.lastError; // worker asleep or panel already open — Chrome owns this
      });
    } catch {
      // Extension context iterating (reload mid-click) — nothing to do.
    }
  });

  (document.documentElement || document.body).appendChild(launcherHost);

  // The launcher is always visible on supported pages: the former
  // "Show floating launcher" setting was removed, and stale preferences that
  // had it disabled are intentionally ignored.

  async function boot() {
    // Nothing to initialise — the button is appended above. Kept as an
    // explicit boot step so the future behaviour stays easy to hook.
  }

  // Test hook — content-script isolated world only (not reachable from web
  // pages). Lets automated tests observe the launcher without touching page world.
  window.__patchesLauncherTest = {
    isHidden: () => launcherHost.classList.contains('hidden'),
  };

  boot();
})();
