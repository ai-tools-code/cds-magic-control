"use strict";

const loginView = document.getElementById('loginView');
const appView = document.getElementById('appView');
const usersElement = document.getElementById('users');
const keyDialog = document.getElementById('keyDialog');
const newKey = document.getElementById('newKey');
const letterLibraryElement = document.getElementById('letterLibrary');
const libraryCountElement = document.getElementById('libraryCount');

let users = [];
let letterLibrary = {};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {})
    }
  });

  let data = {};
  try { data = await response.json(); } catch {}

  if (!response.ok) {
    const error = new Error(data.error || 'Request failed');
    error.status = response.status;
    throw error;
  }

  return data;
}

document.getElementById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: document.getElementById('password').value })
    });
    await load();
  } catch (error) {
    toast(error.message);
  }
});

document.getElementById('logoutButton').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  loginView.classList.remove('hidden');
  appView.classList.add('hidden');
});

document.getElementById('createUser').addEventListener('click', async () => {
  const input = document.getElementById('newUserName');
  const name = input.value.trim();
  if (!name) return toast('Enter a user name');

  try {
    const result = await api('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    input.value = '';
    showKey(result.shortcutKey);
    await loadUsers();
  } catch (error) {
    toast(error.message);
  }
});

async function load() {
  try {
    const me = await api('/api/admin/me');
    document.getElementById('versionLabel').textContent = 'Worker v' + (me.version || '');
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    await Promise.all([loadUsers(), loadLetterLibrary()]);
  } catch (error) {
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    if (error.status !== 401) toast(error.message || 'Dashboard failed to load');
  }
}

async function loadUsers() {
  const data = await api('/api/admin/users');
  users = data.users || [];
  renderUsers();
}

async function loadLetterLibrary() {
  const data = await api('/api/admin/letter-library');
  letterLibrary = data.letters || {};
  renderLetterLibrary();
}

function renderLetterLibrary() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const configuredCount = letters.filter(letter => letterLibrary[letter]?.configured).length;

  libraryCountElement.textContent = configuredCount + ' / 26';
  libraryCountElement.className = 'status ' + (configuredCount === 26 ? 'on' : 'off');
  letterLibraryElement.innerHTML = '';

  for (const letter of letters) {
    const info = letterLibrary[letter] || { configured: false, url: '' };
    const box = document.createElement('div');
    box.className = 'letter-box';
    box.innerHTML = `
      <div class="letter-symbol">${letter}</div>
      ${info.url ? `<img class="asset-thumb" src="${escapeHTML(info.url)}" alt="${letter}">` : '<div class="asset-placeholder">No image</div>'}
      <div class="${info.configured ? 'asset-ok' : 'asset-missing'}">${info.configured ? '✓ Set' : 'Missing'}</div>
      <input type="file" accept="image/png,image/jpeg,image/webp" data-global-letter="${letter}">
      ${info.configured ? `<button class="secondary tiny delete-letter" data-delete-letter="${letter}">Remove</button>` : ''}
    `;
    letterLibraryElement.appendChild(box);
  }

  letterLibraryElement.querySelectorAll('[data-global-letter]').forEach(input => {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      await uploadGlobalLetter(input.dataset.globalLetter, file, input);
    });
  });

  letterLibraryElement.querySelectorAll('[data-delete-letter]').forEach(button => {
    button.addEventListener('click', async () => {
      const letter = button.dataset.deleteLetter;
      if (!confirm('Remove the global ' + letter + ' image?')) return;
      try {
        await api('/api/admin/letter-library/' + letter, { method: 'DELETE' });
        await loadLetterLibrary();
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

document.getElementById('bulkLetterUpload').addEventListener('change', async event => {
  const files = Array.from(event.target.files || []);
  const valid = files.map(file => {
    const base = file.name.replace(/\.[^.]+$/, '').trim().toUpperCase();
    return { file, letter: /^[A-Z]$/.test(base) ? base : '' };
  }).filter(item => item.letter);

  if (!valid.length) {
    event.target.value = '';
    return toast('Name files A.png, B.png … Z.png');
  }

  event.target.disabled = true;
  let uploaded = 0;

  try {
    for (const item of valid) {
      await uploadGlobalLetter(item.letter, item.file, null, false);
      uploaded++;
    }
    toast(uploaded + ' letter image' + (uploaded === 1 ? '' : 's') + ' uploaded');
    await loadLetterLibrary();
  } catch (error) {
    toast(error.message);
  } finally {
    event.target.disabled = false;
    event.target.value = '';
  }
});

async function uploadGlobalLetter(letter, file, input, reload = true) {
  try {
    if (input) input.disabled = true;
    const form = new FormData();
    form.append('file', file);
    await api('/api/admin/letter-library/upload?letter=' + encodeURIComponent(letter), {
      method: 'POST',
      body: form
    });
    if (reload) {
      toast(letter + ' image uploaded');
      await loadLetterLibrary();
    }
  } catch (error) {
    if (input) input.disabled = false;
    throw error;
  }
}

function renderUsers() {
  usersElement.innerHTML = '';
  if (!users.length) {
    usersElement.innerHTML = '<div class="user-card"><p class="muted">No users yet.</p></div>';
    return;
  }
  for (const user of users) usersElement.appendChild(createUserCard(user));
}

function effectOptions(active) {
  return [
    ['scratch', 'Scratch Playing Card'],
    ['card_phone', 'Card in Phone'],
    ['google_single', 'Google Images → Single Image'],
    ['peek', 'Google Search Live Peek'],
    ['product_letters', 'Sponsored Products → Name']
  ].map(([value, label]) => `<option value="${value}" ${value === active ? 'selected' : ''}>${label}</option>`).join('');
}

function createUserCard(user) {
  const card = document.createElement('article');
  card.className = 'user-card';
  card.innerHTML = `
    <div class="user-header">
      <div>
        <div class="user-name">${escapeHTML(user.name)}</div>
        <div class="muted small-text">${escapeHTML(user.id)}</div>
      </div>
      <span class="status ${user.enabled ? 'on' : 'off'}">${user.enabled ? 'Enabled' : 'Disabled'}</span>
    </div>
    <div class="grid">
      <div>
        <label>Active effect</label>
        <select class="effect-select">${effectOptions(user.activeEffect)}</select>
      </div>
      <div>
        <label>User enabled</label>
        <select class="enabled-select">
          <option value="1" ${user.enabled ? 'selected' : ''}>Enabled</option>
          <option value="0" ${!user.enabled ? 'selected' : ''}>Disabled</option>
        </select>
      </div>
    </div>
    <div class="effect-panel"></div>
    <div class="actions">
      <button class="primary save-user">Save settings</button>
      <button class="secondary rotate-key">Rotate API key</button>
      <button class="danger delete-user">Delete user</button>
    </div>
  `;

  const effectSelect = card.querySelector('.effect-select');
  const panel = card.querySelector('.effect-panel');

  function redraw() {
    user.activeEffect = effectSelect.value;
    panel.innerHTML = effectPanelHTML(user);
    bindFileUploads(card, user);
  }

  effectSelect.addEventListener('change', redraw);
  redraw();

  card.querySelector('.save-user').addEventListener('click', async () => {
    try {
      await api('/api/admin/users/' + encodeURIComponent(user.id), {
        method: 'PATCH',
        body: JSON.stringify(settingsFromCard(card, user))
      });
      toast('Settings saved');
      await loadUsers();
    } catch (error) {
      toast(error.message);
    }
  });

  card.querySelector('.rotate-key').addEventListener('click', async () => {
    if (!confirm("Rotate this user's API key? The old key stops working immediately.")) return;
    try {
      const result = await api('/api/admin/users/' + encodeURIComponent(user.id) + '/rotate-key', { method: 'POST' });
      showKey(result.shortcutKey);
    } catch (error) {
      toast(error.message);
    }
  });

  card.querySelector('.delete-user').addEventListener('click', async () => {
    if (!confirm('Delete this user and their uploaded user-specific images?')) return;
    try {
      await api('/api/admin/users/' + encodeURIComponent(user.id), { method: 'DELETE' });
      await loadUsers();
    } catch (error) {
      toast(error.message);
    }
  });

  return card;
}

function effectPanelHTML(user) {
  const settings = user.settings || {};

  switch (user.activeEffect) {
    case 'scratch':
      return `
        <h2>Scratch prediction</h2>
        <p class="muted">Examples: AH, 10S, QD, KC.</p>
        <label>Forced card</label>
        <input class="scratch-card" maxlength="3" value="${escapeHTML(settings.scratch?.card || 'AH')}">
      `;

    case 'card_phone': {
      const url = user.assets?.card_phone || '';
      return `
        <h2>Card in Phone</h2>
        <p class="muted">Upload once here. The Shortcut does not need a Photos action.</p>
        <div class="asset-status-row">
          <div class="${url ? 'asset-ok' : 'asset-missing'}">${url ? '✓ Image configured' : 'No image configured'}</div>
          ${url ? `<img class="effect-preview" src="${escapeHTML(url)}" alt="Card in Phone asset">` : ''}
        </div>
        <div class="file-row">
          <input type="file" accept="image/png,image/jpeg,image/webp" data-upload-slot="card_phone">
        </div>
      `;
    }

    case 'google_single': {
      const url = user.assets?.google_single || '';
      return `
        <h2>Google Images prediction</h2>
        <p class="muted">This server image is used by the Google image replacement effect.</p>
        <div class="asset-status-row">
          <div class="${url ? 'asset-ok' : 'asset-missing'}">${url ? '✓ Image configured' : 'No image configured'}</div>
          ${url ? `<img class="effect-preview" src="${escapeHTML(url)}" alt="Google image asset">` : ''}
        </div>
        <div class="file-row">
          <input type="file" accept="image/png,image/jpeg,image/webp" data-upload-slot="google_single">
        </div>
      `;
    }

    case 'peek':
      return `
        <h2>Live Google Search Peek</h2>
        <p class="muted">The Google page is not modified with a status badge. This dashboard shows connection state and the current Google search text.</p>
        <div class="peek-connection" data-peek-status="${escapeHTML(user.id)}">Not connected</div>
        <div class="peek" data-peek-user="${escapeHTML(user.id)}">Waiting…</div>
      `;

    case 'product_letters':
      return `
        <h2>Sponsored Products → Name</h2>
        <p class="muted">Uses the shared A–Z library above. Once A–Z is uploaded, only enter the name here.</p>
        <label>Predicted name</label>
        <input class="product-name" maxlength="20" value="${escapeHTML(settings.product_letters?.name || 'MARK')}">
        <div class="library-readiness">Required letters: ${requiredLetterStatus(settings.product_letters?.name || 'MARK')}</div>
      `;

    default:
      return '';
  }
}

function requiredLetterStatus(name) {
  const required = [...new Set(String(name || '').toUpperCase().replace(/[^A-Z]/g, ''))];
  if (!required.length) return '<span class="asset-missing">None</span>';
  return required.map(letter => `<span class="letter-chip ${letterLibrary[letter]?.configured ? 'ready' : 'missing'}">${letter}</span>`).join(' ');
}

function settingsFromCard(card) {
  const activeEffect = card.querySelector('.effect-select').value;
  const enabled = card.querySelector('.enabled-select').value === '1';
  const settings = {};

  if (activeEffect === 'scratch') {
    settings.scratch = { card: card.querySelector('.scratch-card').value };
  }

  if (activeEffect === 'product_letters') {
    settings.product_letters = { name: card.querySelector('.product-name').value };
  }

  return { activeEffect, enabled, settings };
}

function bindFileUploads(card, user) {
  card.querySelectorAll('[data-upload-slot]').forEach(input => {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        input.disabled = true;
        const form = new FormData();
        form.append('file', file);

        const result = await api(
          '/api/admin/users/' + encodeURIComponent(user.id) + '/upload?slot=' + encodeURIComponent(input.dataset.uploadSlot),
          { method: 'POST', body: form }
        );

        if (!result.configured) throw new Error('Upload finished but asset was not configured');
        toast('Image uploaded and configured');
        await loadUsers();
      } catch (error) {
        toast(error.message);
        input.disabled = false;
      }
    });
  });
}

setInterval(async () => {
  for (const element of document.querySelectorAll('[data-peek-user]')) {
    const userId = element.dataset.peekUser;
    const status = document.querySelector('[data-peek-status="' + CSS.escape(userId) + '"]');

    try {
      const data = await api('/api/admin/peek?userId=' + encodeURIComponent(userId));

      if (status) {
        status.textContent = data.done ? 'Search submitted' : (data.connected ? '● Connected' : 'Not connected');
        status.className = 'peek-connection ' + (data.connected ? 'connected' : (data.done ? 'done' : ''));
      }

      if (!data.connected && !data.done && Date.now() - (data.updatedAt || 0) > 30000) {
        element.textContent = 'Waiting…';
        element.classList.remove('done');
        continue;
      }

      element.textContent = data.value || (data.connected ? 'Connected — waiting for typing…' : '…');
      element.classList.toggle('done', !!data.done);
    } catch {}
  }
}, 900);

function showKey(key) {
  newKey.value = key;
  keyDialog.showModal();
}

document.getElementById('copyKey').addEventListener('click', async () => {
  await navigator.clipboard.writeText(newKey.value);
  toast('API key copied');
});

document.getElementById('closeKey').addEventListener('click', () => keyDialog.close());

function escapeHTML(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), 2600);
}

async function checkSetupStatus() {
  const box = document.getElementById('setupStatus');
  if (!box) return;

  try {
    const status = await api('/api/admin/status');
    const errors = [];
    const warnings = [];

    if (!status.adminPasswordConfigured) errors.push('ADMIN_PASSWORD is not configured.');
    if (!status.databaseBound) errors.push('D1 binding DB is missing.');
    if (!status.mediaBound) warnings.push('R2 binding MEDIA is missing; images will not work.');
    if (!status.signingSecretConfigured) warnings.push('SIGNING_SECRET is not set; ADMIN_PASSWORD will be used as fallback.');

    if (errors.length) {
      box.textContent = errors.join(' ');
      box.className = 'setup-status error';
      return;
    }

    if (warnings.length) {
      box.textContent = warnings.join(' ');
      box.className = 'setup-status warning';
      return;
    }

    box.className = 'setup-status hidden';
  } catch {
    box.textContent = 'Unable to check Worker configuration.';
    box.className = 'setup-status warning';
  }
}

checkSetupStatus();
load();
