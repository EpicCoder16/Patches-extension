'use strict';

// Patches — content script (self-contained; runs at document_idle).
// Responsibilities:
//   1. Apply saved patches for this domain on page load (chrome.storage.local).
//   2. Build a trimmed DOM outline (LAYOUT_HINTS + PAGE_OUTLINE) as AI context.
//   3. Listen for apply/refresh/prune messages from the background worker.
//
// Webpage content is treated as untrusted: nothing is executed from the page,
// only CSS text is placed inside a <style> element — never JS, never inline HTML.

(function () {
  // Double-injection guard (content script + chrome.scripting fallback inject).
  if (window.__patchesCoreInstalled) return;
  window.__patchesCoreInstalled = true;

  const STYLE_ELEMENT_ID = 'patches-extension-styles';
  const OUTLINE_MAX_CHARS = 12000;

  // Only meaningful on real web pages; Chrome blocks injection elsewhere anyway.
  const protocol = (location.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return;

  function getDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return url; }
  }

  const DOMAIN = getDomain(location.href);

  // ── Style element management ─────────────────────────────────────────────
  let styleElement = null;

  function getStyleElement() {
    if (!styleElement || !styleElement.isConnected) {
      styleElement = document.getElementById(STYLE_ELEMENT_ID);
      if (!styleElement) {
        const target = document.head || document.documentElement;
        if (!target) return null;
        styleElement = document.createElement('style');
        styleElement.id = STYLE_ELEMENT_ID;
        target.appendChild(styleElement);
      }
    }
    return styleElement;
  }

  function removeStyles() {
    const el = document.getElementById(STYLE_ELEMENT_ID);
    if (el) el.remove();
    styleElement = null;
  }

  function applyCss(css) {
    const trimmed = String(css || '').trim();
    if (!trimmed) {
      removeStyles();
      return;
    }
    const el = getStyleElement();
    if (!el) return;
    el.textContent = trimmed;
  }

  // ── Restore saved patches ────────────────────────────────────────────────
  async function applySavedPatches() {
    try {
      const stored = await chrome.storage.local.get(['patches', 'settings']);
      const patchMap = stored.patches || {};
      const settings = stored.settings || {};
      const list = patchMap[DOMAIN] || [];

      if (settings.patchesEnabled === false) {
        removeStyles();
        return;
      }

      const combined = [];
      for (const raw of list) {
        const aspects = Array.isArray(raw.aspects) && raw.aspects.length
          ? raw.aspects
          : (raw.css ? [{ id: '0', label: 'Styles', css: raw.css, enabled: true }] : []);
        for (const aspect of aspects) {
          if (aspect && aspect.enabled !== false && String(aspect.css || '').trim()) {
            combined.push(String(aspect.css).trim());
          }
        }
      }
      applyCss(combined.join('\n'));
    } catch {
      // Storage can be unavailable in transient states — never break the host page.
    }
  }

  // ── DOM outline for AI context (ported from the desktop app) ──────────────
  function layoutHints() {
    const lines = [];
    const sels = [
      '#guide', '#guide-wrapper', '#guide-inner-content', '#guide-content', '#guide-button',
      'ytd-mini-guide-renderer', 'ytd-guide-renderer', 'ytd-app',
      '#primary', '#secondary', '#content', '#columns', '#masthead', 'ytd-masthead',
      '#sidebar', 'aside[role="complementary"]', '[data-testid="sidebar"]'
    ];
    for (let i = 0; i < sels.length; i++) {
      try {
        const el = document.querySelector(sels[i]);
        if (el) lines.push('PRESENT ' + sels[i] + ' <' + el.tagName.toLowerCase() + '>');
      } catch (e) { /* invalid selector on this site */ }
    }
    return lines.join('\n');
  }

  function outline(el, depth) {
    if (depth > 8) return '';
    const tag = el.tagName.toLowerCase();
    // Selector signals only — attribute values that could carry page secrets are skipped.
    const id    = el.id    ? ' id="'    + el.id    + '"' : '';
    const cls   = (el.className && typeof el.className === 'string')
                      ? ' class="' + el.className.trim().slice(0, 80) + '"' : '';
    const role  = el.getAttribute('role')       ? ' role="'       + el.getAttribute('role')       + '"' : '';
    const label = el.getAttribute('aria-label') ? ' aria-label="' + el.getAttribute('aria-label') + '"' : '';
    const text  = el.childElementCount === 0
                      ? (el.innerText || '').trim().slice(0, 60).replace(/\n/g, ' ')
                      : '';
    const children = Array.from(el.children).map((c) => outline(c, depth + 1)).join('');
    return '<' + tag + id + cls + role + label + '>'
         + (text ? text : children)
         + '</' + tag + '>';
  }

  function buildPageContext() {
    try {
      const hints = layoutHints();
      const tree = outline(document.body, 0);
      const combined = (hints
        ? 'LAYOUT_HINTS:\n' + hints + '\n\nPAGE_OUTLINE:\n'
        : 'PAGE_OUTLINE:\n') + tree;
      return combined.slice(0, OUTLINE_MAX_CHARS);
    } catch (e) {
      return (document.body && document.body.innerHTML || '').slice(0, 5000);
    }
  }

  // ── Messaging ────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;
    switch (message.type) {
      case 'patches-ping':
        sendResponse({ ok: true, domain: DOMAIN });
        return;
      case 'get-page-context':
        sendResponse({ ok: true, outline: buildPageContext(), domain: DOMAIN });
        return;
      case 'patches-refresh':
        applySavedPatches().then(() => sendResponse({ ok: true }));
        return true; // async sendResponse
      default:
        return;
    }
  });

  // Keep open tabs in sync when patches/settings change anywhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.patches && !changes.settings) return;
    applySavedPatches();
  });

  // SPA soft navigations keep the same document; patches persist via the style
  // element. Full navigations re-inject this script, which re-applies patches.
  applySavedPatches();
})();
