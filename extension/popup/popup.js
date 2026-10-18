'use strict';

// Patches popup — Firebase-auth-gated. Talks to the MV3 background service
// worker via chrome.runtime messages, mirroring the side panel's capabilities.

const $ = (id) => document.getElementById(id);

const el = {
  domainBadge:   $('domain-badge'),
  userChip:      $('user-chip'),
  userEmail:     $('user-email'),
  patchToggle:   $('patch-toggle'),
  btnSettings:   $('btn-settings'),
  unsupported:   $('unsupported'),
  mainContent:   $('main-content'),
  settingsView:  $('settings-view'),

  // Auth
  authView:      $('auth-view'),
  authTabs:      Array.from(document.querySelectorAll('#auth-tabs .auth-tab')),
  authError:     $('auth-error'),
  authNotice:    $('auth-notice'),
  authForm:      $('auth-form'),
  authEmail:     $('auth-email'),
  authPassword:  $('auth-password'),
  authTogglePW:  $('auth-toggle-password'),
  authForgot:    $('auth-forgot'),
  authSubmit:    $('auth-submit'),

  // Main / patches
  promptInput:   $('prompt-input'),
  btnGenerate:   $('btn-generate'),
  hintChips:     $('hint-chips'),
  status:        $('status'),
  savedView:     $('saved-view'),
  patchList:     $('patch-list'),
  patchEmpty:    $('patch-empty'),
  btnResetSite:  $('btn-reset-site'),

  // Settings
  btnBack:       $('btn-settings-back'),
  keyStatus:     $('key-status'),
  keyInput:      $('key-input'),
  btnToggleKey:  $('btn-toggle-key'),
  settingsError: $('settings-error'),
  btnSaveKey:    $('btn-save-key'),
  modelSelect:   $('model-select'),
  accountEmail:  $('account-email'),
  btnSignOut:    $('btn-sign-out'),
};

let state = {
  url: '',
  domain: '',
  injectable: false,
  auth: { signedIn: false, email: '', uid: '', configError: '' },
  authMode: 'signin',
  authBusy: false,
  patches: [],
  settings: null,
  isGenerating: false,
};

// ── Messaging ────────────────────────────────────────────────────────────────
function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response from background worker.' });
    });
  });
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isLikelyHighDemand(errorText) {
  return /high demand|rate.?limit|resource_exhausted|too many requests|try again later|quota exceeded/i.test(
    String(errorText || '')
  );
}

// ── Status area ──────────────────────────────────────────────────────────────
function statusHidden() {
  el.status.className = 'hidden';
  el.status.innerHTML = '';
}

function statusLoading(text) {
  el.status.className = 'loading';
  el.status.innerHTML = `<div class="spinner"></div><span>${escapeHTML(text)}</span>`;
}

function statusSuccess(patch) {
  const aspects = (patch.aspects || [])
    .map((a) => `<div class="status-aspect-row"><span class="status-aspect-label">${escapeHTML(a.label)}</span><span>applied</span></div>`)
    .join('');
  el.status.className = 'success';
  el.status.innerHTML = `
    <span class="status-title">Patch applied on ${escapeHTML(state.domain)}</span>
    ${aspects ? `<div class="status-aspects">${aspects}</div>` : ''}`;
}

function statusError({ title, body, actions = [], detailsHtml = '' }) {
  const actionsHtml = actions.length
    ? `<div class="status-actions">${actions.map((a, i) => `<button type="button" class="status-action-btn" data-action="${i}">${escapeHTML(a.label)}</button>`).join('')}</div>`
    : '';
  el.status.className = 'error';
  el.status.innerHTML = `
    <span class="status-title">${escapeHTML(title || 'Something went wrong')}</span>
    ${body ? `<span class="status-body">${escapeHTML(body)}</span>` : ''}
    ${actionsHtml}
    ${detailsHtml ? `<details class="status-details"><summary>Technical details</summary><pre>${escapeHTML(detailsHtml)}</pre></details>` : ''}`;

  el.status.querySelectorAll('.status-action-btn').forEach((btn) => {
    const action = actions[Number(btn.dataset.action)];
    if (action) btn.addEventListener('click', action.run);
  });
}

// ── Rendering ────────────────────────────────────────────────────────────────
function render() {
  const signedIn = Boolean(state.auth.signedIn);
  const isNormalSite = state.injectable && state.url;

  // Auth gate: hide every product view while signed out.
  el.authView.classList.toggle('hidden', signedIn);
  el.unsupported.classList.toggle('hidden', !signedIn || !isNormalSite);
  el.mainContent.classList.toggle('hidden', !signedIn || !isNormalSite);

  // Header chip
  el.userChip.classList.toggle('hidden', !signedIn);
  if (signedIn) el.userEmail.textContent = state.auth.email || 'Signed in';

  if (signedIn) {
    el.domainBadge.textContent = state.injectable ? state.domain : (state.url ? 'Unsupported page' : 'No site');
    renderToggle();
    renderSettingsAccount();
    renderPatches();
  } else {
    el.domainBadge.textContent = state.url ? 'Sign in required' : 'No site';
    if (state.auth.configError) showAuthError(state.auth.configError);
  }
}

function renderToggle() {
  el.patchToggle.checked = state.settings ? state.settings.patchesEnabled !== false : true;
}

function renderSettingsAccount() {
  const signedIn = Boolean(state.auth.signedIn);
  el.accountEmail.textContent = signedIn ? (state.auth.email || 'Signed in') : 'Not signed in';
  el.btnSignOut.disabled = !signedIn;
  el.btnSignOut.textContent = signedIn ? 'Sign out' : 'Sign in in the side panel';
}

function renderPatches() {
  el.patchList.innerHTML = '';
  const patches = state.patches || [];
  el.patchEmpty.classList.toggle('hidden', patches.length > 0);

  patches.forEach((patch) => {
    const aspects = (patch.aspects || []).map((a) => `
      <label class="patch-aspect-row ${a.enabled === false ? 'disabled' : ''}">
        <input type="checkbox" class="patch-aspect-toggle" data-patch-id="${escapeHTML(patch.id)}" data-aspect-id="${escapeHTML(String(a.id))}" ${a.enabled !== false ? 'checked' : ''} />
        <span class="patch-aspect-label">${escapeHTML(a.label)}</span>
      </label>`).join('');

    const enabledCss = (patch.aspects || [])
      .filter((a) => a.enabled !== false)
      .map((a) => a.css)
      .join('\n') || patch.css || '';

    const card = document.createElement('div');
    card.className = 'patch-card';
    card.innerHTML = `
      <div class="patch-card-prompt">${escapeHTML(patch.prompt)}</div>
      <div class="patch-aspects">${aspects}</div>
      <div class="patch-cs-preview" title="${escapeHTML(enabledCss)}">${escapeHTML(enabledCss.slice(0, 120))}${enabledCss.length > 120 ? '…' : ''}</div>
      <div class="patch-card-actions">
        <button type="button" class="patch-delete-btn" data-patch-id="${escapeHTML(patch.id)}">Remove patch</button>
      </div>`;
    el.patchList.appendChild(card);
  });

  el.patchList.querySelectorAll('.patch-aspect-toggle').forEach((input) => {
    input.addEventListener('change', async () => {
      if (!state.injectable) return;
      await sendMessage({
        type: 'set-patch-aspect-enabled',
        patchId: input.dataset.patchId,
        aspectId: input.dataset.aspectId,
        enabled: input.checked,
      });
      await reloadPatches();
    });
  });

  el.patchList.querySelectorAll('.patch-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await sendMessage({ type: 'delete-patch', patchId: btn.dataset.patchId });
      await reloadPatches();
    });
  });
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function reloadPatches() {
  const res = await sendMessage({ type: 'get-patches' });
  if (res && res.ok) {
    state.patches = res.patches || [];
    if (res.domain && !state.domain) state.domain = res.domain;
    renderPatches();
  }
}

async function reloadAuth() {
  const res = await sendMessage({ type: 'get-auth-state' });
  if (res && res.ok) {
    state.auth = {
      signedIn: Boolean(res.signedIn),
      uid: res.uid || '',
      email: res.email || '',
      configError: res.configError || '',
    };
  }
  return state.auth;
}

async function boot() {
  const [info, settingsRes, patchesRes] = await Promise.all([
    sendMessage({ type: 'get-tab-info' }),
    sendMessage({ type: 'get-settings' }),
    sendMessage({ type: 'get-patches' }),
  ]);

  if (info && info.ok) {
    state.url = info.url;
    state.domain = info.domain;
    state.injectable = info.injectable;
  }

  if (settingsRes && settingsRes.ok) {
    state.settings = settingsRes.settings;
    populateModelSelect();
    renderKeyStatus();
  }

  if (patchesRes && patchesRes.ok) {
    state.patches = patchesRes.patches || [];
  }

  await reloadAuth();
  render();
  void ensureContentScript();
}

async function ensureContentScript() {
  if (!state.injectable) return;
  await sendMessage({ type: 'ensure-content-script' });
}

// ── Auth view ───────────────────────────────────────────────────────────────
function setAuthMode(mode) {
  state.authMode = mode === 'signup' ? 'signup' : 'signin';
  el.authTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === state.authMode));
  el.authSubmit.textContent = state.authMode === 'signin' ? 'Sign in' : 'Create account';
  el.authForgot.classList.toggle('hidden', state.authMode !== 'signin');
  el.authPassword.setAttribute('autocomplete', state.authMode === 'signup' ? 'new-password' : 'current-password');
  showAuthError('');
  showAuthNotice('');
}

function showAuthError(msg) {
  el.authError.textContent = msg || '';
  el.authError.classList.toggle('hidden', !msg);
}

function showAuthNotice(msg) {
  el.authNotice.textContent = msg || '';
  el.authNotice.classList.toggle('hidden', !msg);
}

function setAuthBusy(busy) {
  state.authBusy = busy;
  el.authSubmit.disabled = busy;
  el.authEmail.disabled = busy;
  el.authPassword.disabled = busy;
  el.authSubmit.textContent = busy
    ? 'Please wait…'
    : state.authMode === 'signin' ? 'Sign in' : 'Create account';
}

el.authTabs.forEach((tab) => {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
});

el.authTogglePW.addEventListener('click', () => {
  const show = el.authPassword.type === 'password';
  el.authPassword.type = show ? 'text' : 'password';
  el.authTogglePW.textContent = show ? 'Hide' : 'Show';
});

el.authForgot.addEventListener('click', async () => {
  const email = el.authEmail.value.trim();
  if (!email) {
    showAuthError('Enter your email above, then use forgot password.');
    return;
  }
  setAuthBusy(true);
  try {
    const res = await sendMessage({ type: 'auth-send-reset', email });
    if (res && res.ok) {
      showAuthNotice(res.message || `Password reset email sent to ${email}.`);
    } else {
      showAuthError((res && res.error) || 'Could not send a reset email.');
    }
  } finally {
    setAuthBusy(false);
  }
});

el.authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.authBusy) return;
  showAuthError('');
  showAuthNotice('');

  const email = el.authEmail.value.trim();
  const password = el.authPassword.value;
  if (!email) { showAuthError('Enter your email.'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showAuthError('Enter a valid email address.'); return; }
  if (!password) { showAuthError('Enter your password.'); return; }
  if (password.length < 6) { showAuthError('Password must be at least 6 characters.'); return; }

  setAuthBusy(true);
  try {
    const type = state.authMode === 'signin' ? 'auth-sign-in' : 'auth-sign-up';
    const res = await sendMessage({ type, email, password });
    if (res && res.ok) {
      el.authPassword.value = '';
      await reloadAuth();
      render();
      await reloadPatches();
    } else {
      showAuthError((res && res.error) || 'Authentication failed.');
    }
  } catch (err) {
    showAuthError((err && err.message) || 'Authentication failed.');
  } finally {
    setAuthBusy(false);
  }
});

el.authEmail.addEventListener('input', () => showAuthError(''));
el.authPassword.addEventListener('input', () => showAuthError(''));

el.btnSignOut.addEventListener('click', async () => {
  if (!state.auth.signedIn) return;
  const res = await sendMessage({ type: 'auth-sign-out' });
  if (res && res.ok) {
    await reloadAuth();
    render();
  }
});

// ── Generate patch ───────────────────────────────────────────────────────────
async function submitPrompt(text, retryCount = 0) {
  if (!text) return;
  state.isGenerating = true;
  el.promptInput.disabled = true;
  el.btnGenerate.disabled = true;
  el.hintChips.querySelectorAll('.hint').forEach((chip) => { chip.disabled = true; });
  statusLoading('Generating CSS patch…');

  try {
    const result = await sendMessage({ type: 'generate-patch', prompt: text });

    if (result && result.ok) {
      statusSuccess(result.patch);
      await reloadPatches();
      if (result.fallbackUsed && result.usedModel) {
        statusError({
          title: 'Applied with fallback model',
          body: `High demand on your selected model — Patches used ${result.usedModel} instead.`,
        });
        setTimeout(statusHidden, 4000);
      }
      return;
    }

    if (result && result.authRequired) {
      statusError({
        title: 'Sign in required',
        body: result.error,
        actions: [{ label: 'Sign in', run: () => { showSettings(false); render(); el.authEmail.focus(); } }],
      });
      return;
    }

    if (result && result.needsApiKey) {
      statusError({
        title: 'Gemini API key required',
        body: result.error,
        actions: [{ label: 'Open Settings', run: () => showSettings(true) }],
      });
      return;
    }

    if (result && result.geminiQuota && isLikelyHighDemand(result.errorDetail || result.error) && retryCount < 2) {
      const delay = retryCount === 0 ? 1500 : 3000;
      statusLoading(`Model busy — retrying in ${Math.round(delay / 1000)}s… (${retryCount + 1}/3)`);
      await new Promise((r) => setTimeout(r, delay));
      await submitPrompt(text, retryCount + 1);
      return;
    }

    if (result && result.networkProblem) {
      statusError({
        title: 'Network problem',
        body: (result && result.error) || 'Could not reach the Gemini API.',
        actions: [{ label: 'Try again', run: () => submitPrompt(text, 0) }],
      });
      return;
    }

    statusError({
      title: result && result.unsupported ? 'Patches can’t run here' : 'Patch failed',
      body: (result && result.error) || 'Something went wrong.',
      detailsHtml: (result && result.errorDetail) ? JSON.stringify(result.errorDetail).slice(0, 2000) : '',
    });
  } catch (err) {
    statusError({ title: 'Patch failed', body: err.message || 'Unexpected error.' });
  } finally {
    state.isGenerating = false;
    el.promptInput.disabled = false;
    el.btnGenerate.disabled = false;
    el.hintChips.querySelectorAll('.hint').forEach((chip) => { chip.disabled = false; });
    el.promptInput.focus();
  }
}

// ── Settings view ────────────────────────────────────────────────────────────
function showSettings(open) {
  el.settingsView.classList.toggle('hidden', !open);
  const productsVisible = Boolean(state.auth && state.auth.signedIn);
  el.mainContent.classList.toggle('hidden', open || !productsVisible || !state.injectable && !state.url);
  if (open) {
    renderKeyStatus();
    renderSettingsAccount();
    setTimeout(() => el.keyInput.focus(), 30);
  }
}

function renderKeyStatus() {
  const s = state.settings;
  if (!s) { el.keyStatus.textContent = 'Unable to read settings.'; return; }
  el.keyStatus.textContent = s.hasApiKey
    ? `Current key: ${s.maskedKey}`
    : 'No API key saved yet. AI patching needs a (free) Gemini key.';
}

function populateModelSelect() {
  const s = state.settings;
  if (!s) return;
  el.modelSelect.innerHTML = '';
  for (const model of s.supportedModels || []) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    el.modelSelect.appendChild(opt);
  }
  el.modelSelect.value = s.model;
}

// ── Events ───────────────────────────────────────────────────────────────────
el.btnGenerate.addEventListener('click', () => submitPrompt(el.promptInput.value.trim()));

el.promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitPrompt(el.promptInput.value.trim());
  }
  if (e.key === 'Escape') el.promptInput.blur();
});

el.hintChips.querySelectorAll('.hint').forEach((chip) => {
  chip.addEventListener('click', () => {
    el.promptInput.value = chip.textContent.replace(/[""]/g, '');
    el.promptInput.focus();
    submitPrompt(el.promptInput.value.trim());
  });
});

el.patchToggle.addEventListener('change', async () => {
  const res = await sendMessage({ type: 'toggle-patches', enabled: el.patchToggle.checked });
  if (res && res.ok) {
    statusHidden();
  }
});

el.btnSettings.addEventListener('click', () => showSettings(true));
el.btnBack.addEventListener('click', () => showSettings(false));

el.btnResetSite.addEventListener('click', async () => {
  if (!state.domain) return;
  if (!window.confirm(`Remove all saved patches for ${state.domain}?`)) return;
  await sendMessage({ type: 'reset-domain-patches' });
  await reloadPatches();
});

el.btnToggleKey.addEventListener('click', () => {
  const show = el.keyInput.type === 'password';
  el.keyInput.type = show ? 'text' : 'password';
  el.btnToggleKey.textContent = show ? 'Hide' : 'Show';
});

el.keyInput.addEventListener('input', () => {
  el.settingsError.classList.add('hidden');
});

el.btnSaveKey.addEventListener('click', async () => {
  el.settingsError.classList.add('hidden');
  const value = el.keyInput.value.trim();
  if (!value) {
    el.settingsError.textContent = 'Please enter your Gemini API key.';
    el.settingsError.classList.remove('hidden');
    return;
  }
  el.btnSaveKey.disabled = true;
  el.btnSaveKey.textContent = 'Saving…';
  try {
    const res = await sendMessage({ type: 'save-api-key', key: value });
    if (res && res.ok) {
      const settingsRes = await sendMessage({ type: 'get-settings' });
      if (settingsRes && settingsRes.ok) {
        state.settings = settingsRes.settings;
        renderKeyStatus();
        populateModelSelect();
      }
      el.keyInput.value = '';
      el.keyInput.type = 'password';
      el.btnToggleKey.textContent = 'Show';
      el.keyStatus.textContent = 'Key saved.';
    } else {
      el.settingsError.textContent = (res && res.error) || 'Unable to save key.';
      el.settingsError.classList.remove('hidden');
    }
  } finally {
    el.btnSaveKey.disabled = false;
    el.btnSaveKey.textContent = 'Save key';
  }
});

el.modelSelect.addEventListener('change', async () => {
  await sendMessage({ type: 'set-model', model: el.modelSelect.value });
});

setAuthMode('signin');
boot();
