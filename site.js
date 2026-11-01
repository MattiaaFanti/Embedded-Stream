(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const views = ['loading','setup','signin','pending','welcome','adminPasswordLogin'];
  let account = null, redirectTimer = null;
  function show(id) {
    views.forEach(v => $(v).classList.toggle('hidden', v !== id));
    $('gate').classList.remove('hidden');
    $('player').classList.add('hidden');
    $('message').classList.add('hidden');
  }
  function readableError(error) {
    const m = {
      SERVER_NOT_CONFIGURED: 'Il servizio Cloudflare non è ancora configurato.',
      LOGIN_REQUIRED: 'Sessione scaduta. Accedi con la tua Passkey.',
      BANNED: 'Accesso disabilitato dall’amministratore.',
      PASSKEY_NOT_SUPPORTED: 'Questo browser non supporta le Passkey richieste.',
      PASSKEY_CANCELLED: 'Creazione della Passkey annullata. La registrazione non è stata inviata.',
      NotAllowedError: 'Operazione Passkey annullata, non autorizzata o scaduta. Verifica la richiesta sul dispositivo e riprova.',
      AbortError: 'Richiesta Passkey interrotta. Riprova.',
      SecurityError: 'Il browser ha bloccato la Passkey per motivi di sicurezza. Apri la pagina direttamente tramite HTTPS.',
      NotSupportedError: 'Questo dispositivo non supporta la Passkey richiesta.',
      InvalidStateError: 'Questa Passkey è già registrata. Usa Accedi con Passkey.',
      TypeError: 'La richiesta Passkey non è supportata o non è valida per questo dispositivo.',
      HTTP_404: 'Il Worker Cloudflare non ha ancora le API di registrazione aggiornate.',
      HTTP_503: 'Il server delle registrazioni non è disponibile.',
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
    return m[error.message] || m[error.name] || error.message || String(error);
  }
  function message(error) {
    $('message').textContent = readableError(error);
    $('message').classList.remove('hidden');
  }
  function runButton(button, task, onError = message) {
    if (button.disabled) return;
    button.disabled = true;
    $('message').classList.add('hidden');
    Promise.resolve().then(task).catch(onError).finally(() => button.disabled = false);
  }
  // Barra affidabile: sempre visibile dopo l'autorizzazione.
  // Se lo userscript originale crea davvero la sua barra nello stesso DOM,
  // lasciamo quella originale e vi aggiungiamo soltanto i link admin.
  // Altrimenti e' mostrata la barra nativa della pagina (senza doppioni).
  const WEB_VERSION = '1.0.0';
  const nativeBar = $('htsportNativeStatus');
  const nativeActionsHost = $('htsportStatusRight');
  const adminActions = $('adminActions');
  let webUpdateVersion = null;
  let statusTimer = null;
  let barObserver = null;
  let barSyncScheduled = false;
  function externalScriptBar() {
    const node = document.getElementById('htsport-script-status-v308');
    if (!node || node === nativeBar || nativeBar.contains(node)) return null;
    // Un contenitore presente ma nascosto non deve nascondere la barra nativa.
    if (!node.isConnected || !node.getClientRects().length ||
        getComputedStyle(node).visibility === 'hidden') return null;
    return node;
  }
  function syncStatusBar() {
    const external = externalScriptBar();
    nativeBar.classList.toggle('hidden', !!external);
    const target = external || nativeActionsHost;
    if (adminActions.parentElement !== target) target.append(adminActions);
    const admin = !!account && account.role === 'admin' && account.status === 'active';
    adminActions.classList.toggle('hidden', !admin);
  }
  function watchForOriginalBar() {
    if (barObserver) return;
    barObserver = new MutationObserver(() => {
      if (barSyncScheduled || $('player').classList.contains('hidden')) return;
      barSyncScheduled = true;
      requestAnimationFrame(() => { barSyncScheduled = false; syncStatusBar(); });
    });
    barObserver.observe(document.body, { childList:true, subtree:true });
  }
  function compareVersions(a, b) {
    const parse = v => /^\d+(?:\.\d+){1,3}$/.test(v)
      ? v.split('.').map(Number) : null;
    const x = parse(a), y = parse(b);
    if (!x || !y) return 0;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
    }
    return 0;
  }
  async function updateStatus() {
    if ($('player').classList.contains('hidden')) return;
    const dot = $('htsportOnlineDot');
    const txt = $('htsportOnlineText');
    try {
      const health = await HTAuth.call('/api/health');
      if (!health.online) throw Error('API_OFFLINE');
      dot.className = 'htsport-online-dot online';
      txt.textContent = 'ONLINE';
      dot.title = 'Servizio Cloudflare online' + (health.version ? ' · API ' + health.version : '');
    } catch {
      dot.className = 'htsport-online-dot offline';
      txt.textContent = 'OFFLINE';
      dot.title = 'Servizio Cloudflare non raggiungibile';
    }
    $('htsportWebVersion').textContent = 'Web v' + WEB_VERSION;
    try {
      const response = await fetch('version.json?check=' + Date.now(), { cache:'no-store' });
      if (!response.ok) throw Error('VERSION_CHECK_FAILED');
      const data = await response.json();
      webUpdateVersion = typeof data.webVersion === 'string' &&
        compareVersions(data.webVersion, WEB_VERSION) > 0 ? data.webVersion : null;
      $('htsportWebUpdate').classList.toggle('hidden', !webUpdateVersion);
    } catch {
      // Non mostrare falsi aggiornamenti quando il controllo non riesce.
      $('htsportWebUpdate').classList.add('hidden');
    }
  }
  $('htsportWebUpdate').addEventListener('click', () => {
    if (!webUpdateVersion) return;
    const url = new URL(location.href);
    url.searchParams.set('refresh', webUpdateVersion + '-' + Date.now());
    location.replace(url.href);
  });
  function stream() {
    if (redirectTimer) clearTimeout(redirectTimer);
    if (!account || account.status !== 'active') return;
    $('gate').classList.add('hidden');
    $('player').classList.remove('hidden');
    $('installLink').href = HTAuth.installUrl;
    syncStatusBar();
    watchForOriginalBar();
    void updateStatus();
    if (!statusTimer) statusTimer = setInterval(updateStatus, 60000);
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
    if (u.status !== 'active' || u.role !== 'admin') syncStatusBar();
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
    const b = this.querySelector('button[type="submit"]');
    const status = $('registerStatus');
    status.classList.remove('hidden', 'registration-error');
    status.textContent = 'Avvio della registrazione...';
    runButton(b, async () => {
      const username = $('username').value.trim();
      const result = await HTAuth.register(username, undefined, step => {
        status.textContent = step;
      });
      account = result;
      $('pendingName').textContent = 'Utente: ' + result.username;
      show('pending');
      $('pendingFeedback').classList.add('hidden');
    }, error => {
      status.textContent = readableError(error);
      status.classList.add('registration-error');
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
    account = null; syncStatusBar();
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } show('signin');
  });
  $('logoutBtn').addEventListener('click', async () => {
    try { await HTAuth.logout(); } catch { HTAuth.setToken(''); }
    account = null; syncStatusBar();
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } $('frameHost').replaceChildren(); show('signin');
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