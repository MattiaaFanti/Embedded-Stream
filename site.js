(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const views = ['loading','setup','signin','pending','welcome','adminPasswordLogin'];
  let account = null, redirectTimer = null, adminBarObserver = null;
  function show(id) {
    views.forEach(v => $(v).classList.toggle('hidden', v !== id));
    $('gate').classList.remove('hidden');
    $('player').classList.add('hidden');
    $('message').classList.add('hidden');
  }
  function message(error) {
    const m = {
      SERVER_NOT_CONFIGURED: 'Il servizio Cloudflare non è ancora configurato.',
      LOGIN_REQUIRED: 'Sessione scaduta. Accedi con la tua Passkey.',
      BANNED: 'Accesso disabilitato dall’amministratore.',
      PASSKEY_NOT_SUPPORTED: 'Questo browser non supporta le Passkey richieste.',
      DEVICE_REVOKED_OR_UNKNOWN: 'Passkey revocata oppure non registrata.',
      PASSKEY_INVALID: 'Autenticazione non valida. Riprova.',
      PASSKEY_ALREADY_REGISTERED: 'Questa Passkey è già registrata. Usa Accedi con Passkey anziché creare un altro account.',
      USERNAME_ALREADY_REGISTERED: 'Nome utente già registrato. Scegli un altro nome oppure accedi con la tua Passkey.',
      WORKER_UPDATE_REQUIRED: 'Registrazioni temporaneamente bloccate: il Worker Cloudflare non ha ancora la versione 1.3.0. Aggiorna il Worker prima di riprovare.',
      REGISTRATION_FAILED: 'Registrazione non riuscita. Non è stato creato alcun nuovo account.',
      REGISTRATION_CAPACITY_REACHED: 'Il numero massimo di registrazioni è stato raggiunto. Contatta l’amministratore.',
      RATE_LIMIT: 'Troppi tentativi. Riprova più tardi.',
      INVALID_ADMIN_CREDENTIALS: 'Password amministratore errata.',
      ADMIN_PASSWORD_NOT_CONFIGURED: 'Password amministratore non configurata su Cloudflare.',
      ADMIN_UNAVAILABLE: 'Amministratore non disponibile: contatta il proprietario del sito.'
    };
    $('message').textContent = m[error.message] || error.message || String(error);
    $('message').classList.remove('hidden');
  }
  function runButton(button, task) {
    if (button.disabled) return;
    button.disabled = true;
    $('message').classList.add('hidden');
    Promise.resolve().then(task).catch(message).finally(() => button.disabled = false);
  }
  // La barra di versione/online/aggiornamento appartiene allo userscript
  // originale. Non viene nascosta, sostituita o ricostruita qui.
  // Per l'admin inseriamo i soli link nello spazio previsto dalla barra.
  const adminActions = $('adminActions');
  let adminBarCheckPending = false;
  function findOriginalStatusBarSlot() {
    const bar = document.getElementById('htsport-script-status-v308');
    if (!bar) return null;
    // Lo userscript riserva una sezione per i comandi, a fianco dello
    // stato versione e dell'eventuale pulsante Aggiorna script.
    return bar.querySelector('#htsport-status-action-v312') ||
      document.getElementById('htsport-status-action-v312') || bar;
  }
  function attachAdminLinks() {
    const isAdmin = account && account.role === 'admin' && account.status === 'active';
    if (!isAdmin) {
      adminActions.classList.add('hidden');
      if (adminBarObserver) {
        adminBarObserver.disconnect();
        adminBarObserver = null;
      }
      return;
    }
    // La barra originale può essere montata in un secondo momento o
    // ricreata dopo un aggiornamento. Aspettiamo il suo vero contenitore.
    if (!adminBarObserver) {
      adminBarObserver = new MutationObserver(() => {
        if (adminBarCheckPending) return;
        adminBarCheckPending = true;
        queueMicrotask(() => {
          adminBarCheckPending = false;
          if (!adminActions.isConnected ||
              !adminActions.closest('#htsport-script-status-v308')) {
            attachAdminLinks();
          }
        });
      });
      adminBarObserver.observe(document.body, { childList: true, subtree: true });
    }
    const slot = findOriginalStatusBarSlot();
    if (!slot) {
      adminActions.classList.add('hidden');
      return;
    }
    if (adminActions.parentElement !== slot) slot.append(adminActions);
    adminActions.classList.remove('hidden');
  }
  function stream() {
    if (redirectTimer) clearTimeout(redirectTimer);
    if (!account || account.status !== 'active') return;
    $('gate').classList.add('hidden');
    $('player').classList.remove('hidden');
    $('installLink').href = HTAuth.installUrl;
    attachAdminLinks();
    if (!$('htsport-frame')) {
      const frame = document.createElement('iframe');
      frame.id = 'htsport-frame'; frame.title = 'HTSport';
      frame.src = 'https://htsport.info/';
      frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('webkitallowfullscreen', '');
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      $('frameHost').append(frame);
    }
  }
  function afterAuth(u, checked = false) {
    account = u;
    if (u.status !== 'active' || u.role !== 'admin') attachAdminLinks();
    if (u.status === 'banned') { HTAuth.setToken(''); show('signin'); message(Error('BANNED')); return; }
    if (u.status === 'pending') {
      $('pendingName').textContent = 'Utente: ' + u.username;
      show('pending');
      $('pendingFeedback').classList.toggle('hidden', !checked);
      if (checked) $('pendingFeedback').textContent = 'L’amministratore non ha ancora approvato la tua registrazione.';
      return;
    }
    if (u.status !== 'active') { show('signin'); return; }
    const key = 'htsport-guide-seen-v1';
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, '1');
      $('welcomeTitle').textContent = 'Benvenuto, ' + u.username;
      show('welcome');
      redirectTimer = setTimeout(() => location.assign(HTAuth.installUrl), 1500);
    } else stream();
  }
  async function refresh(checked = false) {
    if (!HTAuth.ready) { show('setup'); return; }
    if (!HTAuth.getToken()) { show('signin'); return; }
    try {
      const u = await HTAuth.call('/api/me');
      afterAuth(u, checked);
    } catch (e) {
      if (e.message === 'LOGIN_REQUIRED' || e.message === 'BANNED') {
        HTAuth.setToken('');
        show('signin');
        if (e.message === 'BANNED') message(e);
      } else { show('signin'); message(e); }
    }
  }
  $('signInBtn').addEventListener('click', function () {
    runButton(this, async () => { await HTAuth.login(); await refresh(); });
  });
  $('registerForm').addEventListener('submit', function (event) {
    event.preventDefault();
    const b = this.querySelector('button');
    runButton(b, async () => {
      const username = $('username').value.trim();
      const result = await HTAuth.register(username);
      account = result;
      $('pendingName').textContent = 'Utente: ' + result.username;
      show('pending');
      $('pendingFeedback').classList.add('hidden');
    });
  });
  $('pendingCheck').addEventListener('click', function () {
    runButton(this, async () => {
      if (!HTAuth.getToken()) await HTAuth.login();
      await refresh(true);
    });
  });
  $('pendingLogout').addEventListener('click', async () => {
    try { await HTAuth.logout(); } catch { HTAuth.setToken(''); }
    account = null; attachAdminLinks(); show('signin');
  });
  $('logoutBtn').addEventListener('click', async () => {
    try { await HTAuth.logout(); } catch { HTAuth.setToken(''); }
    account = null; attachAdminLinks(); $('frameHost').replaceChildren(); show('signin');
  });
  $('openAdminLoginBtn').addEventListener('click', () => {
    if (redirectTimer) { clearTimeout(redirectTimer); redirectTimer = null; }
    show('adminPasswordLogin');
  });
  $('backToSiteBtn').addEventListener('click', () => { refresh(); });
  $('siteAdminPasswordForm').addEventListener('submit', function (event) {
    event.preventDefault();
    const submit = this.querySelector('button[type=submit]');
    runButton(submit, async () => {
      const input = $('siteAdminPassword');
      const password = input.value;
      try {
        await HTAuth.loginAdminWithPassword(password);
        location.assign('admin.html');
      } finally {
        input.value = '';
      }
    });
  });
  $('skipGuide').addEventListener('click', stream);
  refresh();
})();