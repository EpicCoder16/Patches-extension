'use strict';

// Ported from lib/geminiKey.js (Electron) — unchanged logic.

const MIN_KEY_LENGTH = 16;

/**
 * Google AI Studio now issues authorization keys (AQ.).
 * Legacy standard keys (AIza) are still accepted here until the API rejects them.
 */
function isValidGeminiApiKey(value) {
  const key = String(value || '').trim();
  if (key.length < MIN_KEY_LENGTH) return false;
  return key.startsWith('AQ.') || key.startsWith('AIza');
}

function geminiKeyFormatError() {
  return 'Gemini API key should start with AQ. (new authorization keys) or AIza (legacy).';
}

function maskKey(key) {
  return key && key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : String(key || '');
}

export { isValidGeminiApiKey, geminiKeyFormatError, maskKey, MIN_KEY_LENGTH };
