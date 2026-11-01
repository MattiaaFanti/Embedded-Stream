(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const views = ['loading','setup','offlineGate','signin','pending','welcome','adminPasswordLogin'];
  let account = null, redirectTimer = null;
  const PENDING_NAME_KEY = 'htsport-pending-username-v2';
  function getPendingName() {
    try { return sessionStorage.getItem(PENDING_NAME_KEY) || ''; }
    catch { return ''; }
  }
  function setPendingName(name) {
    try {
      if (name) sessionStorage.setItem(PENDING_NAME_KEY, name);
      else sessionStorage.removeItem(PENDING_NAME_KEY);
    } catch {}
  }
  // The guide is a prerequisite for NEW registration, not for existing
  // accounts or administrators. A browser cannot verify external installation,
  // so completion is explicitly confirmed by the user.
  const GUIDE_KEY = 'sport-guide-completed-v1';
  const GUIDE_OPENED = 'sport-guide-opened-v1';
  function guideCompleted() {
    try {
      return localStorage.getItem(GUIDE_KEY) === '1' ||
        localStorage.getItem('htsport-guide-seen-v1') === '1';
    } catch { return false; }
  }
  function syncGuideStep() {
    const done = guideCompleted();
    $('installFirst').classList.toggle('hidden', done);
    $('registrationAfterGuide').classList.toggle('hidden', !done);
    $('confirmInstallGuide').disabled = !done &&
      (() => { try { return sessionStorage.getItem(GUIDE_OPENED) !== '1'; }
        catch { return true; } })();
  }
  function show(id) {
    views.forEach(v => $(v).classList.toggle('hidden', v !== id));
    $('gate').classList.remove('hidden');
    $('player').classList.add('hidden');
    $('message').classList.add('hidden');
    if (id === 'signin') syncGuideStep();
    if (id === 'signin' && window.HTBrowserIdentity) {
      // A user without a saved browser key doesn't need a misleading login
      // button. Native Passkey access remains available behind user choice.
      void HTBrowserIdentity.hasIdentity().then(exists => {
        if (!$('signin').classList.contains('hidden'))
          $('browserSignInBtn').classList.toggle('hidden', !exists);
      }).catch(() => {});
    }
  }
  function readableError(error) {
    const m = {
      SERVER_NOT_CONFIGURED: 'Il servizio Cloudflare non è ancora configurato.',
      LOGIN_REQUIRED: 'Sessione scaduta. Accedi usando il metodo con cui hai registrato Firefox.',
      LOGIN_CREDENTIALS_UNAVAILABLE: 'Nessuna Passkey attiva associata al nome indicato. Usa esattamente il nome dell’ultima registrazione approvata.',
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
      DEVICE_REVOKED_OR_UNKNOWN: 'La Passkey selezionata non corrisponde a una credenziale attiva sul server. Per la nuova registrazione, accedi indicando il nome esatto dell’account approvato.',
      ACCESS_REVOKED: 'Accesso revocato o sessione non più valida. Il player è stato chiuso.',
      PASSKEY_INVALID: 'Autenticazione non valida. Riprova.',
      PASSKEY_ALREADY_REGISTERED: 'Questa Passkey è già registrata. Usa Accedi con Passkey anziché creare un altro account.',
      USERNAME_ALREADY_REGISTERED: 'Nome già registrato. Accedi con la credenziale esistente oppure scegli un altro nome.',
      BROWSER_KEY_NOT_SUPPORTED: 'Firefox non supporta la chiave crittografica richiesta in questo contesto HTTPS.',
      BROWSER_STORAGE_UNAVAILABLE: 'Impossibile salvare la chiave Firefox. Verifica che la navigazione privata o il blocco dell’archiviazione non impediscano IndexedDB.',
      BROWSER_KEY_CORRUPT: 'La chiave salvata in Firefox non è più valida. Non viene sostituita automaticamente per evitare di cambiare identificativo.',
      BROWSER_KEY_MISSING: 'Questo Firefox non è stato ancora registrato. Usa il modulo di prima registrazione.',
      BROWSER_KEY_UNKNOWN: 'La chiave di Firefox non è associata a un account attivo nel database. Se l’account è stato eliminato, puoi registrarlo nuovamente.',
      BROWSER_ALREADY_REGISTERED: 'Questo browser è già registrato. Usa Accedi anziché creare un altro account.',
      BROWSER_WORKER_UPDATE_REQUIRED: 'Il Worker Cloudflare deve essere aggiornato alla versione 1.4.10.',
      BROWSER_DB_UPDATE_REQUIRED: 'La nuova tabella browser_credentials non è ancora presente su Cloudflare D1. La registrazione Firefox non può essere completata.',
      INVALID_BROWSER_SIGNATURE: 'La verifica crittografica del browser non è riuscita.',
      WORKER_UPDATE_REQUIRED: 'Il Worker Cloudflare deve essere aggiornato almeno alla versione 1.4.2 per registrazioni e controlli di approvazione corretti.',
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
  const WEB_VERSION = '1.1.0';
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
  // Presence comes from open, approved HTSport pages, not saved sessions.
  // Tabs in the same browser use one random local browser identifier.
  const presenceTabId = crypto.randomUUID();
  const presenceDeviceId = (() => {
    const key = 'htsport-presence-browser-v1';
    try {
      const existing = localStorage.getItem(key);
      if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
      const created = crypto.randomUUID();
      localStorage.setItem(key, created);
      return created;
    } catch { return crypto.randomUUID(); }
  })();
  let presenceTimer = null;
  let presenceBusy = false;
  let presenceUnsupported = false;
  function currentPresenceArea() {
    return $('player').classList.contains('hidden') ? 'home' : 'player';
  }
  function invalidSession(error) {
    return ['LOGIN_REQUIRED', 'BANNED', 'ACCESS_NOT_ACTIVE', 'HTTP_401', 'HTTP_403']
      .includes(error && error.message);
  }
  function revokeVisibleAccess(error) {
    // A deleted/banned account MUST lose the already-loaded iframe. Merely
    // returning to the gate leaves a video running inside the hidden iframe.
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    if (redirectTimer) { clearTimeout(redirectTimer); redirectTimer = null; }
    $('frameHost').replaceChildren();
    HTAuth.setToken('');
    account = null;
    presenceBusy = false;
    setPendingName('');
    markLoggedOut(); // Never re-login silently after an admin revocation.
    syncStatusBar();
    show('signin');
    message(Error(error && error.message === 'BANNED' ? 'BANNED' : 'ACCESS_REVOKED'));
  }
  let accessCheckBusy = false;
  async function checkVisibleAccess() {
    if (accessCheckBusy || !account || account.status !== 'active' || !HTAuth.getToken())
      return;
    accessCheckBusy = true;
    const originalToken = HTAuth.getToken();
    try {
      const user = await HTAuth.call('/api/me');
      if (originalToken !== HTAuth.getToken()) return;
      if (user.status !== 'active' || user.userId !== account?.userId)
        revokeVisibleAccess(Error('ACCESS_REVOKED'));
    } catch (error) {
      if (originalToken === HTAuth.getToken() && invalidSession(error))
        revokeVisibleAccess(error);
      // Temporary connectivity failures must not be mistaken for a ban.
    } finally {
      accessCheckBusy = false;
    }
  }
  async function presenceBeat() {
    if (!presenceTimer || presenceBusy || presenceUnsupported ||
        !account || account.role !== 'user' || account.status !== 'active' ||
        !HTAuth.getToken()) return;
    presenceBusy = true;
    const checkedToken = HTAuth.getToken();
    const sentArea = currentPresenceArea();
    try {
      await HTAuth.call('/api/presence/heartbeat', {
        deviceId: presenceDeviceId, tabId: presenceTabId,
        area: sentArea
      });
    } catch (error) {
      // Never invalidate a freshly signed-in account because an older
      // heartbeat (from a different session) failed later.
      if (checkedToken !== HTAuth.getToken()) return;
      if (invalidSession(error)) {
        revokeVisibleAccess(error);
      } else if (error.message === 'HTTP_404') {
        // An old Worker must not break streaming or its existing Passkey login.
        presenceUnsupported = true;
      }
    } finally {
      presenceBusy = false;
      // Login may open the player while the initial homepage heartbeat
      // is still running; send the new area immediately.
      if (presenceTimer && !presenceUnsupported && sentArea !== currentPresenceArea())
        void presenceBeat();
    }
  }
  function startPresence() {
    if (!account || account.role !== 'user' || account.status !== 'active') return;
    // Every 20 seconds while HTSport stays open, including multi-hour streams.
    // Never tie presence to clicks, page navigation or playback events.
    if (!presenceTimer) presenceTimer = setInterval(() => { void presenceBeat(); }, 20000);
    void presenceBeat();
  }
  async function stopPresence() {
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = null;
    if (presenceUnsupported || !HTAuth.getToken()) return;
    try {
      await HTAuth.call('/api/presence/leave', {
        deviceId: presenceDeviceId, tabId: presenceTabId
      });
    } catch { /* Presence also expires when the browser vanishes. */ }
  }
  window.addEventListener('pagehide', () => {
    if (!presenceTimer || presenceUnsupported || !HTAuth.getToken()) return;
    try {
      void fetch(new URL('/api/presence/leave', String(window.HTSPORT_API_BASE)).href, {
        method: 'POST', cache: 'no-store', keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + HTAuth.getToken()
        },
        body: JSON.stringify({ deviceId: presenceDeviceId, tabId: presenceTabId })
      }).catch(() => {});
    } catch {}
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { void presenceBeat(); void checkVisibleAccess(); }
  });
  window.addEventListener('focus', () => {
    if (!$('player').classList.contains('hidden')) void checkVisibleAccess();
  });
  // Focusing the cross-origin iframe typically blurs the parent document.
  // This adds a check when a person enters the embedded stream site, without
  // attempting to read or intercept inaccessible cross-origin clicks.
  window.addEventListener('blur', () => {
    if (document.activeElement?.id === 'htsport-frame') void checkVisibleAccess();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void presenceBeat();
  });

  function stream() {
    if (redirectTimer) clearTimeout(redirectTimer);
    if (!account || account.status !== 'active') return;
    $('gate').classList.add('hidden');
    $('player').classList.remove('hidden');
    void presenceBeat();
    $('installLink').href = HTAuth.installUrl;
    syncStatusBar();
    watchForOriginalBar();
    void updateStatus();
    if (!statusTimer) statusTimer = setInterval(updateStatus, 60000);
    if (!$('htsport-frame')) {
      const frame = document.createElement('iframe');
      frame.id = 'htsport-frame'; frame.title = 'Sport';
      frame.src = 'https://htsport.info/';
      frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('webkitallowfullscreen', '');
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      // Cross-origin iframe navigation (e.g. homepage -> stream) cannot be
      // intercepted before the click. Check authorization on each frame load,
      // in addition to the 20-second heartbeat revocation check.
      frame.addEventListener('load', () => { void checkVisibleAccess(); });
      $('frameHost').append(frame);
    }
  }
  function afterAuth(u, checked = false) {
    account = u;
    if (u.status === 'active') startPresence();
    else if (presenceTimer) void stopPresence();
    if (u.status !== 'active' || u.role !== 'admin') syncStatusBar();
    if (u.status === 'banned') { HTAuth.setToken(''); show('signin'); message(Error('BANNED')); return; }
    if (u.status === 'pending') {
      setPendingName(u.username);
      $('pendingName').textContent = 'Utente: ' + u.username;
      show('pending');
      $('pendingFeedback').classList.toggle('hidden', !checked);
      if (checked) $('pendingFeedback').textContent = 'L’amministratore non ha ancora approvato la tua registrazione.';
      return;
    }
    if (u.status !== 'active') { show('signin'); return; }
    setPendingName('');
    // The installation guide is now completed before signup, not on the
    // first approved login. Never redirect an approved user away from Sport.
    stream();
  }
  const MANUAL_LOGOUT_KEY = 'htsport-manual-logout-v1';
  const manualLogout = () => { try { return localStorage.getItem(MANUAL_LOGOUT_KEY) === '1'; } catch { return false; } };
  const markLoggedOut = () => { try { localStorage.setItem(MANUAL_LOGOUT_KEY, '1'); } catch {} };
  const markLoggedIn = () => { try { localStorage.removeItem(MANUAL_LOGOUT_KEY); } catch {} };
  let automaticBrowserLoginTried = false;
  async function refresh(checked = false) {
    if (!HTAuth.ready) { show('setup'); return; }
    if (!HTAuth.getToken()) {
      // Only the IndexedDB key can be checked silently. Never trigger a
      // navigator.credentials.get() Passkey prompt automatically.
      if (!automaticBrowserLoginTried && !manualLogout() && window.HTBrowserIdentity) {
        automaticBrowserLoginTried = true;
        if (await HTBrowserIdentity.hasIdentity()) {
          try {
            await HTBrowserIdentity.login();
            markLoggedIn();
            return await refresh(checked);
          } catch (err) {
            if (err.message === 'BANNED') {
              setPendingName('');
              show('signin'); message(err); return;
            }
            // Deleted account: retain the SAME local key for re-enrollment.
            // Unsupported old Worker: keep the legacy Passkey route usable.
            if (!['BROWSER_KEY_UNKNOWN','BROWSER_WORKER_UPDATE_REQUIRED',
                'BROWSER_DB_UPDATE_REQUIRED','HTTP_404'].includes(err.message)) {
              show('signin'); message(err); return;
            }
          }
        }
      }
      const pending = getPendingName();
      if (pending) {
        $('pendingName').textContent = 'Utente: ' + pending;
        show('pending');
        $('pendingFeedback').classList.add('hidden');
      } else show('signin');
      return;
    }
    try {
      const u = await HTAuth.call('/api/me');
      afterAuth(u, checked);
    } catch (e) {
      if (e.message === 'LOGIN_REQUIRED' || e.message === 'BANNED') {
        void stopPresence();
        HTAuth.setToken('');
        if (e.message === 'LOGIN_REQUIRED' && !automaticBrowserLoginTried && !manualLogout())
          return refresh(checked);
        if (e.message === 'LOGIN_REQUIRED' && getPendingName()) {
          $('pendingName').textContent = 'Utente: ' + getPendingName();
          show('pending');
          $('pendingFeedback').textContent = 'Sessione da ripristinare. Premi Controlla autorizzazione per verificare la credenziale associata alla registrazione.';
          $('pendingFeedback').classList.remove('hidden');
        } else {
          if (e.message === 'BANNED') setPendingName('');
          show('signin');
          if (e.message === 'BANNED') message(e);
        }
      } else { show('signin'); message(e); }
    }
  }
  // A browser key is checked without user-facing native authentication.
  // Passkeys remain strictly opt-in through the explicit Passkey button.
  $('browserSignInBtn').addEventListener('click', function () {
    runButton(this, async () => {
      if (!window.HTBrowserIdentity) throw Error('BROWSER_KEY_NOT_SUPPORTED');
      await HTBrowserIdentity.login();
      markLoggedIn();
      await refresh();
    });
  });
  $('signInBtn').addEventListener('click', function () {
    runButton(this, async () => {
      await HTAuth.login();
      markLoggedIn();
      await refresh();
    });
  });
  let registrationInProgress = false;
  async function requestRegistration(method = 'browser') {
    const button = method === 'passkey' ? $('registerPasskeyBtn') : $('registerBtn');
    const status = $('registerStatus');
    const username = $('username').value.trim().replace(/\s+/g, ' ');
    status.classList.remove('hidden', 'registration-error');
    $('message').classList.add('hidden');
    if (!guideCompleted()) {
      syncGuideStep();
      status.textContent = 'Completa prima l’installazione guidata.';
      status.classList.add('registration-error');
      return;
    }
    if (registrationInProgress) {
      status.textContent = 'Registrazione già avviata.';
      return;
    }
    if (username.length < 2 || username.length > 40 || /[<>\\]/.test(username)) {
      status.textContent = 'Inserisci un nome valido da 2 a 40 caratteri.';
      status.classList.add('registration-error');
      $('username').focus();
      return;
    }
    if (!HTAuth.ready) {
      status.textContent = 'Server Cloudflare non configurato.';
      status.classList.add('registration-error');
      return;
    }
    if (method === 'passkey' ? !HTAuth.supported() :
        (!window.HTBrowserIdentity || !HTBrowserIdentity.supported())) {
      status.textContent = method === 'passkey'
        ? 'Questo browser non supporta le Passkey.'
        : 'Questo Firefox non supporta l’archiviazione crittografica richiesta.';
      status.classList.add('registration-error');
      return;
    }
    registrationInProgress = true;
    $('registerBtn').disabled = true;
    $('registerPasskeyBtn').disabled = true;
    button.setAttribute('aria-busy', 'true');
    const defaultLabel = method === 'passkey' ? 'Registra con Passkey' : 'Richiedi registrazione';
    button.textContent = 'Registrazione in corso...';
    status.textContent = 'Avvio della registrazione...';
    try {
      let result;
      if (method === 'passkey') {
        // A native Passkey dialog opens ONLY because this optional button
        // was explicitly selected by the user.
        result = await HTAuth.register(username, undefined, step => {
          status.textContent = step;
        });
      } else {
        // Existing Firefox identity is reused, never rotated or silently
        // regenerated. If it is already enrolled, log in instead.
        if (await HTBrowserIdentity.hasIdentity()) {
          try {
            await HTBrowserIdentity.login();
            markLoggedIn();
            await refresh();
            return;
          } catch (err) {
            if (err.message !== 'BROWSER_KEY_UNKNOWN') throw err;
            // The former account was deleted. Reuse the exact same key.
          }
        }
        result = await HTBrowserIdentity.register(username, step => {
          status.textContent = step;
        });
      }
      markLoggedIn();
      account = result;
      setPendingName(result.username);
      $('pendingName').textContent = 'Utente: ' + result.username;
      show('pending');
      $('pendingFeedback').classList.add('hidden');
    } catch (e) {
      status.textContent = readableError(e);
      status.classList.add('registration-error');
    } finally {
      registrationInProgress = false;
      $('registerBtn').disabled = false;
      $('registerPasskeyBtn').disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = defaultLabel;
    }
  }
  $('startInstallGuide').href = HTAuth.installUrl;
  $('startInstallGuide').addEventListener('click', () => {
    try { sessionStorage.setItem(GUIDE_OPENED, '1'); } catch {}
    $('confirmInstallGuide').disabled = false;
  });
  $('confirmInstallGuide').addEventListener('click', () => {
    if ($('confirmInstallGuide').disabled) return;
    try { localStorage.setItem(GUIDE_KEY, '1'); } catch {}
    syncGuideStep();
  });
  $('registerBtn').addEventListener('click', () => { void requestRegistration(); });
  $('registerPasskeyBtn').addEventListener('click', () => { void requestRegistration('passkey'); });
  $('registerForm').addEventListener('submit', event => {
    event.preventDefault();
    void requestRegistration();
  });
  $('username').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void requestRegistration();
    }
  });
  $('pendingCheck').addEventListener('click', function () {
    const btn = this;
    if (btn.disabled) return;
    runButton(btn, async () => {
      const feedback = $('pendingFeedback');
      feedback.classList.add('hidden');
      try {
        if (!HTAuth.getToken()) {
          if (window.HTBrowserIdentity && await HTBrowserIdentity.hasIdentity()) {
            try {
              await HTBrowserIdentity.login();
            } catch (e) {
              if (e.message !== 'BROWSER_KEY_UNKNOWN') throw e;
            }
          }
          if (!HTAuth.getToken()) {
            const name = (account && account.username) || getPendingName();
            if (!name) throw Error('LOGIN_REQUIRED');
            // Only legacy Passkey registrations need a native prompt.
            await HTAuth.login(name);
          }
        }
        await refresh(true);
      } catch (error) {
        feedback.textContent = readableError(error);
        feedback.classList.remove('hidden');
      }
    });
  });
  $('pendingLogout').addEventListener('click', async () => {
    markLoggedOut();
    await stopPresence();
    try { await HTAuth.logout(); } catch { HTAuth.setToken(''); }
    setPendingName('');
    account = null; syncStatusBar();
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } show('signin');
  });
  $('logoutBtn').addEventListener('click', async () => {
    markLoggedOut();
    await stopPresence();
    try { await HTAuth.logout(); } catch { HTAuth.setToken(''); }
    setPendingName('');
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