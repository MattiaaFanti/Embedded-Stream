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
    if (status.version !== '1.3.0') throw Error('WORKER_UPDATE_REQUIRED');
  }
  // If the authenticator holds a credential registered with *any* username,
  // verify it with the Worker and reject a second account instead of
  // silently logging the visitor into the previous account.
  async function detectExistingRegistration() {
    const result = await call('/api/login/options', {});
    let credential;
    try {
      credential = await getCredential(result.options);
    } catch (e) {
      // An authenticator may have no existing credential, or the user may
      // cancel. Existing IDs are also passed as excludeCredentials later.
      if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError' ||
        e.message === 'PASSKEY_CANCELLED')) return false;
      throw e;
    }
    const found = await call('/api/register/probe/verify',
      { requestId: result.requestId, credential });
    return found.alreadyRegistered === true;
  }
  async function register(username, adminSecret) {
    const admin = adminSecret !== undefined;
    const headers = admin ? { 'X-Bootstrap-Secret': adminSecret } : undefined;
    let result;
    if (!admin) {
      await requireCurrentRegistrationWorker();
      // The username is validated FIRST, before any native Passkey dialog.
      // The Worker rechecks it on verification and in the INSERT itself.
      result = await call('/api/register/options', { username });
      if (await detectExistingRegistration()) throw Error('PASSKEY_ALREADY_REGISTERED');
    } else {
      result = await call('/api/admin/bootstrap/options', { username }, headers);
    }
    const finish = admin ? '/api/admin/bootstrap/verify' : '/api/register/verify';
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