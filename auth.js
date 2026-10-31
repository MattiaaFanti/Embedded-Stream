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
  // Prima di creare una nuova Passkey prova ad autenticare una credenziale
  // gia' esistente per questo sito, anche se e' stata registrata con un altro nome.
  async function detectExistingRegistration() {
    const result = await call('/api/login/options', {});
    let credential;
    try {
      credential = await getCredential(result.options);
    } catch (e) {
      // Nessuna Passkey disponibile, oppure selezione annullata.
      // Il server inviera' comunque excludeCredentials nella registrazione.
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError' || e.message === 'PASSKEY_CANCELLED')) return null;
      throw e;
    }
    const saved = await call('/api/login/verify', { requestId: result.requestId, credential });
    setToken(saved.token);
    return { ...saved, existing: true };
  }
  async function register(username, adminSecret) {
    const admin = adminSecret !== undefined;
    if (!admin) {
      const existing = await detectExistingRegistration();
      if (existing) return existing;
    }
    const start = admin ? '/api/admin/bootstrap/options' : '/api/register/options';
    const finish = admin ? '/api/admin/bootstrap/verify' : '/api/register/verify';
    const headers = admin ? { 'X-Bootstrap-Secret': adminSecret } : undefined;
    const result = await call(start, { username }, headers);
    let credential;
    try {
      credential = await makeCredential(result.options);
    } catch (e) {
      if (e && e.name === 'InvalidStateError') throw Error('PASSKEY_ALREADY_REGISTERED');
      throw e;
    }
    const saved = await call(finish, { requestId: result.requestId, credential }, headers);
    if (saved.token) setToken(saved.token);
    return saved;
  }
  async function login() {
    const result = await call('/api/login/options', {});
    const credential = await getCredential(result.options);
    const saved = await call('/api/login/verify', { requestId: result.requestId, credential });
    setToken(saved.token);
    return saved;
  }
  async function logout() {
    try { if (getToken()) await call('/api/logout', {}); }
    finally { setToken(''); }
  }
  window.HTAuth = Object.freeze({
    ready, supported, call, register, login, logout, getToken, setToken,
    installUrl: String(window.HTSPORT_INSTALL_URL || 'https://hattrick-player-control.yaboyo95.workers.dev/')
  });
})();