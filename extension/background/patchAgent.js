'use strict';

// Ported from main.js (Electron) — system prompt, CSS sanitising, aspect parsing,
// and patch normalisation for AI-generated CSS. Logic unchanged; ES module form.

import { callGeminiGenerateContent } from './geminiClient.js';

// Default: current stable Gemini 3.x Flash (v1beta). Shut-down IDs (e.g. gemini-2.0-flash) 404 on every
// request; keep this list synced with https://ai.google.dev/gemini-api/docs/models
export const DEFAULT_MODEL = 'gemini-3.8-flash';

export const SUPPORTED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
];

export const MAX_CSS_LENGTH = 200000;

const SYSTEM_PROMPT = `You are an expert CSS engineer whose sole job is to write CSS patches for websites.

OUTPUT FORMAT (mandatory):
Return exactly one JSON object, no markdown fences, no text before or after. Shape:
{"aspects":[{"label":"short human-readable name","css":"valid CSS rules here"}]}
- Use one aspect for a single cohesive change (one theme, one feature).
- Use multiple aspects when the user asked for clearly separate changes (e.g. "dark mode and larger font" → one aspect for dark backgrounds/text colors, one for font-size/line-height) so they can be toggled independently later.
- Each "css" value must be complete valid CSS with selectors and braces; put !important on declarations that must override the site.

TYPOGRAPHY — "larger font", "bigger text", etc.:
- Do NOT set html { font-size: 18px } or 20px+ unless the user explicitly asks for very large text. That rem-scales the entire UI and looks broken.
- Prefer a **modest** bump: html { font-size: 106% !important; } to html { font-size: 112% !important; }, OR body { font-size: 1.0625rem !important; }, OR body { zoom: 1.06 !important; } (Chrome), staying roughly in the 5–12% range.
- If the snapshot shows specific content areas, you may target those instead of the whole page.

DARK MODE — "dark mode", "dark theme", etc.:
- Dark mode means **readable contrast**: near-white text on near-black backgrounds sitewide.
- Always set dark page background on html, body (e.g. #0f0f0f, #121212, #181818) AND set light foreground text (e.g. #e8eaed, #f1f1f1) on body and on common text containers.
- Many sites leave text dark after background changes: add broad rules so text is light, e.g. body, #content, main, article, p, span, h1, h2, h3, h4, div[role="main"] { color: #e8eaed !important; } plus site-specific tags from the snapshot (e.g. ytd-* on YouTube). Style links distinctly (e.g. a { color: #8ab4f8 !important; }) so they stay visible.
- Override common "stuck dark text" by targeting classes/ids from the snapshot and * where needed for color (use carefully).

HIDE SIDEBAR / PANEL / RAIL:
- Use display: none !important; on the narrow column hosts. Prefer selectors from LAYOUT_HINTS and PAGE_OUTLINE (ids like #guide, #sidebar).
- Custom elements (e.g. ytd-mini-guide-renderer) are **hosts**: hiding the host hides the entire subtree including shadow DOM. Prefer ytd-mini-guide-renderer, ytd-guide-renderer, #guide, #guide-wrapper when present in hints.
- If one selector fails, combine several likely selectors with comma-separated rules.

RULES for the CSS inside each aspect:
1. Use the most specific selectors possible from LAYOUT_HINTS, PAGE_OUTLINE, class names and IDs.
2. Hide elements with: display: none !important;
3. If the request is ambiguous, cover the most likely interpretations in that aspect's CSS.
4. Never write selectors that hide or break every element on the page (e.g. * { display: none }) or rules that could break forms and buttons the user needs.

COLOR / PALETTE CHANGES (blues→reds, brand recolor, etc.):
The HTML snapshot does NOT show colors from external stylesheets or computed styles—only structure, classes, and sometimes inline attributes. Many "blue" UIs are styled via CSS files you cannot see.
- For broad "change blues to reds" / recolor requests: include rules on html or body using filter, e.g. filter: hue-rotate(-140deg) saturate(1.1) !important; and -webkit-filter with the same (tune degrees until blue shifts toward red/orange). Label that aspect clearly (e.g. "Global hue shift") so the user knows it affects the whole page including images.
- ALSO add selector-based overrides using classes/ids from the snapshot for color, background-color, border-color, fill, stroke where it helps.
- Prefer not to rely on guessing hex codes from the snapshot alone; combine filter + targeted selectors.

Never put prose outside the JSON. Never use markdown code fences around the JSON.`;

function domainPatchHints(domain) {
  if (domain === 'youtube.com') {
    return `SITE-SPECIFIC (youtube.com):
- Left nav: ytd-mini-guide-renderer, ytd-guide-renderer, #guide, #guide-wrapper, #guide-inner-content, #guide-content. Hiding the host (e.g. ytd-mini-guide-renderer { display: none !important; }) hides the whole column including shadow DOM. Prefer selectors listed as PRESENT in LAYOUT_HINTS.
- Dark mode: YouTube uses theme flags (often html[dark] or similar) and many ytd-* tags. After darkening backgrounds, force light text on body, #content, #primary, #secondary, and common ytd-* text containers so UI stays readable.\n\n`;
  }
  return '';
}

// ── CSS sanitiser ─────────────────────────────────────────────────────────────
function sanitiseCSS(raw) {
  let css = raw.replace(/^```(?:css)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const firstBrace = css.indexOf('{');
  if (firstBrace > 0) {
    const before = css.slice(0, firstBrace);
    if (/^[A-Z][^{}\n]*$/.test(before.trim())) {
      css = css.slice(firstBrace - before.trim().lastIndexOf(' ') - 1).trim();
    }
  }
  if (!css.includes('{') || !css.includes('}'))
    throw new Error('Model did not return valid CSS. Try rephrasing your prompt.');
  if (css.length > MAX_CSS_LENGTH)
    throw new Error('Generated CSS is too large to apply safely.');
  return css;
}

/** Strip markdown fences and parse {"aspects":[{label,css},...]} from model output. */
function parseModelAspects(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try {
    const data = JSON.parse(text);
    if (data.aspects && Array.isArray(data.aspects) && data.aspects.length) {
      const out = [];
      for (let i = 0; i < data.aspects.length; i++) {
        const a = data.aspects[i];
        const piece = String(a.css || '').trim();
        if (!piece) continue;
        try {
          out.push({
            label: (String(a.label || `Part ${out.length + 1}`).trim().slice(0, 120)) || `Part ${out.length + 1}`,
            css: sanitiseCSS(piece),
          });
        } catch {
          /* skip invalid aspect */
        }
      }
      if (out.length) return out;
    }
  } catch { /* not JSON */ }
  return [{ label: 'Styles', css: sanitiseCSS(raw) }];
}

function normalisePatch(patch) {
  if (patch.aspects && Array.isArray(patch.aspects) && patch.aspects.length) {
    return {
      ...patch,
      aspects: patch.aspects.map((a, i) => ({
        id:    String(a.id != null ? a.id : i),
        label: ((a.label && String(a.label).trim()) || `Part ${i + 1}`),
        css:   String(a.css || ''),
        enabled: a.enabled !== false,
      })),
    };
  }
  if (patch.css) {
    return {
      ...patch,
      aspects: [{ id: '0', label: 'Styles', css: patch.css, enabled: true }],
    };
  }
  return { ...patch, aspects: [] };
}

function combinedPatchCss(patch) {
  const p = normalisePatch(patch);
  return p.aspects.filter((a) => a.enabled && String(a.css).trim()).map((a) => a.css).join('\n');
}

/** Same as above but tolerant of very long single-aspect CSS saved from storage. */
function isValidPatchCss(patch) {
  return combinedPatchCss(patch).length <= MAX_CSS_LENGTH;
}

/**
 * Generate CSS aspects from a user request + trimmed DOM outline captured by the
 * content script. Mirrors main.js generateCSSFromPrompt.
 */
async function generateCSSFromPrompt({ prompt, domOutline, domain, apiKey, model }) {
  const hints = domainPatchHints(domain || '');
  const userText = `TASK: ${prompt}\n\n${hints}PAGE STRUCTURE (LAYOUT_HINTS list which major containers exist; PAGE_OUTLINE is a tree of tags with id/class/role):\n${domOutline}\n\nRespond with only the JSON object described in your instructions.`;

  const generated = await callGeminiGenerateContent({
    apiKey,
    preferredModel: model,
    supportedModels: SUPPORTED_MODELS,
    systemText: SYSTEM_PROMPT,
    userText,
    generationConfig: {
      temperature:     0.2,
      topP:            0.9,
      maxOutputTokens: 8192,
    },
  });

  return {
    aspects: parseModelAspects(generated.text),
    usedModel: generated.usedModel,
    fallbackUsed: generated.fallbackUsed,
    fallbackError: generated.fallbackError,
  };
}

export {
  SYSTEM_PROMPT,
  domainPatchHints,
  sanitiseCSS,
  parseModelAspects,
  normalisePatch,
  combinedPatchCss,
  isValidPatchCss,
  generateCSSFromPrompt,
};
