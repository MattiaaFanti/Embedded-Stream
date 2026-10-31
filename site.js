(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const views = ['loading','setup','signin','pending','welcome'];
  let account = null, redirectTimer = null;
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
      RATE_LIMIT: 'Troppe richieste. Riprova più tardi.'
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
  function stream() {
    if (redirectTimer) clearTimeout(redirectTimer);
    if (!account || account.status !== 'active') return;
    $('gate').classList.add('hidden');
    $('player').classList.remove('hidden');
    $('userLabel').textContent = 'Benvenuto, ' + account.username;
    $('adminLink').classList.toggle('hidden', account.role !== 'admin');
    $('installLink').href = HTAuth.installUrl;
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
  function afterAuth(u) {
    account = u;
    if (u.status === 'banned') { HTAuth.setToken(''); show('signin'); message(Error('BANNED')); return; }
    if (u.status === 'pending') {
      $('pendingName').textContent = 'Utente: ' + u.username;
      $('pendingSerial').textContent = 'Seriale registrazione: ' + (u.registrationSerial || 'in elaborazione');
      show('pending');
      return;
    }
    if (u.status !== 'active') { show('signin'); return; }
    const key = 'htsport-guide-seen-v1';
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, '1');
      $('welcomeTitle').textContent = 'Benvenuto, ' + u.username;
      $('welcomeSerial').textContent = 'Seriale registrazione: ' + (u.registrationSerial || '—');
      show('welcome');
      redirectTimer = setTimeout(() => location.assign(HTAuth.installUrl), 1500);
    } else stream();
  }
  async function refresh() {
    if (!HTAuth.ready) { show('setup'); return; }
    if (!HTAuth.getToken()) { show('signin'); return; }
    try {
      const u = await HTAuth.call('/api/me');
      afterAuth(u);
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
      $('pendingSerial').textContent = 'Seriale registrazione: ' + (result.registrationSerial || 'in elaborazione');
      show('pending');
    });
  });
  $('pendingCheck').addEventListener('click', function () {
    runButton(this, async () => {
      if (!HTAuth.getToken()) await HTAuth.login();
      await refresh();
    });
  });
  $('pendingLogout').addEventListener('click', async () => {
    try { await HTAuth.logout(); } catch { HTAuth.setToken(''); }
    account = null; show('signin');
  });
  $('logoutBtn').addEventListener('click', async () => {
    try { await HTAuth.logout(); } catch { HTAuth.setToken(''); }
    account = null; $('frameHost').replaceChildren(); show('signin');
  });
  $('skipGuide').addEventListener('click', stream);
  refresh();
})();