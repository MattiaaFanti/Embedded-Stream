/* Shared browser-side Passkey client. No external dependencies. */
(function () {
  'use strict';
  const KEY = 'htsport-license-session-v1';
  const apiBase = String(window.HTSPORT_API_BASE || '').replace(/\/+$/, '');
  const ready = /^https:\/\/[a-zA-Z0-9.-]+$/.test(apiBase) && !apiBase.includes('REPLACE-WITH');
  const from64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  const to64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function getToken() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
  function setToken(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch {} }
  async function call(path, body, extraHeaders) {
    if (!ready) throw Error('SERVER_NOT_CONFIGURED');
    const response = await fetch(apiBase + path, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
        ...(extraHeaders || {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(json.error || 'HTTP_' + response.status);
    return json;
  }
  function supported() { return !!window.PublicKeyCredential && !!navigator.credentials && !!window.isSecureContext; }
  async function makeCredential(options) {
    if (!supported()) throw Error('PASSKEY_NOT_SUPPORTED');
    const p = structuredClone(options);
    p.challenge = from64(p.challenge);
    p.user.id = from64(p.user.id);
    p.excludeCredentials = (p.excludeCredentials || []).map(c => ({ ...c, id: from64(c.id) }));
    const cred = await navigator.credentials.create({ publicKey: p });
    if (!cred) throw Error('PASSKEY_CANCELLED');
    return {
      id: cred.id, rawId: to64(cred.rawId), type: cred.type,
      response: {
        attestationObject: to64(cred.response.attestationObject),
        clientDataJSON: to64(cred.response.clientDataJSON),
        transports: typeof cred.response.getTransports === 'function' ? cred.response.getTransports() : []
      },
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults()
    };
  }
  async function getCredential(options) {
    if (!supported()) throw Error('PASSKEY_NOT_SUPPORTED');
    const p = structuredClone(options);
    p.challenge = from64(p.challenge);
    p.allowCredentials = (p.allowCredentials || []).map(c => ({ ...c, id: from64(c.id) }));
    const cred = await navigator.credentials.get({ publicKey: p });
    if (!cred) throw Error('PASSKEY_CANCELLED');
    return {
      id: cred.id, rawId: to64(cred.rawId), type: cred.type,
      response: {
        authenticatorData: to64(cred.response.authenticatorData),
        clientDataJSON: to64(cred.response.clientDataJSON),
        signature: to64(cred.response.signature),
        userHandle: cred.response.userHandle ? to64(cred.response.userHandle) : undefined
      },
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults()
    };
  }
  // A registration is never started against an older Worker, even when the
  // browser has a cached frontend version. This fails closed until deployment.
  async function requireCurrentRegistrationWorker() {
    const status = await call('/api/health');
    const parts = String(status.version || '').split('.');
    if (parts.length !== 3 || parts[0] !== '1' || !Number.isInteger(Number(parts[1])) ||
        Number(parts[1]) < 3) throw Error('WORKER_UPDATE_REQUIRED');
  }
  // No preliminary navigator.credentials.get(): on an unregistered device
  // this prompts for an unrelated login and can stall the signup for minutes.
  // The server supplies excludeCredentials in registration options and
  // verifies duplicate names and credential IDs before storing a new user.
  async function register(username, adminSecret, onProgress) {
    const progress = message => { if (typeof onProgress === 'function') onProgress(message); };
    const admin = adminSecret !== undefined;
    const headers = admin ? { 'X-Bootstrap-Secret': adminSecret } : undefined;
    let result;
    if (!admin) {
      progress('Verifica connessione e versione del server...');
      await requireCurrentRegistrationWorker();
      // The username is validated BEFORE the native Passkey dialog.
      // The Worker checks it again in verification and at insertion.
      progress('Controllo del nome utente...');
      result = await call('/api/register/options', { username });
    } else {
      result = await call('/api/admin/bootstrap/options', { username }, headers);
    }
    const finish = admin ? '/api/admin/bootstrap/verify' : '/api/register/verify';
    progress('Crea la Passkey nel messaggio del dispositivo o del browser.');
    let credential;
    try {
      credential = await makeCredential(result.options);
    } catch (e) {
      if (e && e.name === 'InvalidStateError') throw Error('PASSKEY_ALREADY_REGISTERED');
      throw e;
    }
    progress('Passkey creata. Salvataggio della registrazione...');
    const saved = await call(finish, { requestId: result.requestId, credential }, headers);
    if (saved.token) setToken(saved.token);
    progress('Registrazione inviata.');
    return saved;
  }
  async function login() {
    const result = await call('/api/login/options', {});
    const credential = await getCredential(result.options);
    let saved;
    try {
      saved = await call('/api/login/verify', { requestId: result.requestId, credential });
    } catch (error) {
      if (error.message === 'DEVICE_REVOKED_OR_UNKNOWN') {
        // The admin may have deleted this account. The passkey still lives
        // in the browser/phone; where supported, tell the authenticator
        // that the server no longer accepts it (WebAuthn Signal API).
        try {
          if (typeof PublicKeyCredential.signalUnknownCredential === 'function') {
            await PublicKeyCredential.signalUnknownCredential({
              rpId: result.options.rpId || location.hostname,
              credentialId: credential.id
            });
          }
        } catch (_) {
          // Browser/provider support is optional; a new registration remains possible.
        }
      }
      throw error;
    }
    setToken(saved.token);
    return saved;
  }
  async function loginAdminWithPassword(password) {
    const result = await call('/api/admin/password/login', { password });
    if (!result.token || result.role !== 'admin') throw Error('INVALID_ADMIN_CREDENTIALS');
    setToken(result.token);
    return result;
  }
  async function logout() {
    try { if (getToken()) await call('/api/logout', {}); }
    finally { setToken(''); }
  }
  window.HTAuth = Object.freeze({
    ready, supported, call, register, login, loginAdminWithPassword, logout, getToken, setToken,
    installUrl: String(window.HTSPORT_INSTALL_URL || 'https://hattrick-player-control.yaboyo95.workers.dev/')
  });
})();