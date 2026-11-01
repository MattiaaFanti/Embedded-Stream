/* Firefox browser identity. No extensions, prompts or persistent-storage permission.
   One non-exportable ECDSA private key per Firefox profile + site origin, stored
   in IndexedDB. This is NOT a unique physical phone identifier. */
(function () {
  'use strict';
  const DB_NAME = 'htsport-browser-identity-v1';
  const STORE = 'identity';
  const RECORD_ID = 'primary';
  const enc = new TextEncoder();
  const to64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  function supported() {
    return !!window.isSecureContext && !!window.crypto && !!crypto.subtle &&
      !!window.indexedDB && !!crypto.randomUUID;
  }
  function openDb() {
    if (!supported()) return Promise.reject(Error('BROWSER_KEY_NOT_SUPPORTED'));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(Error('BROWSER_STORAGE_UNAVAILABLE'));
      request.onblocked = () => reject(Error('BROWSER_STORAGE_UNAVAILABLE'));
    });
  }
  async function getStored() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(RECORD_ID);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(Error('BROWSER_STORAGE_UNAVAILABLE'));
      });
    } finally { db.close(); }
  }
  function validRecord(value) {
    return !!value && !!value.privateKey &&
      value.privateKey.type === 'private' && value.privateKey.extractable === false &&
      value.privateKey.algorithm && value.privateKey.algorithm.name === 'ECDSA' &&
      value.publicKey && value.publicKey.kty === 'EC' &&
      value.publicKey.crv === 'P-256' &&
      typeof value.publicKey.x === 'string' &&
      typeof value.publicKey.y === 'string';
  }
  async function hasIdentity() {
    if (!supported()) return false;
    try { return validRecord(await getStored()); }
    catch { return false; }
  }
  async function getOrCreate() {
    const existing = await getStored();
    if (validRecord(existing)) return existing;
    // An invalid record is never silently overwritten: this would rotate the
    // identity and bypass the user's expectation of a stable browser key.
    if (existing) throw Error('BROWSER_KEY_CORRUPT');
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const record = {
      id: RECORD_ID, privateKey: pair.privateKey,
      publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
    };
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        // add(), not put(): concurrent first registrations cannot silently
        // replace a key that another tab has already saved.
        tx.objectStore(STORE).add(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || Error('BROWSER_STORAGE_UNAVAILABLE'));
        tx.onabort = () => reject(tx.error || Error('BROWSER_STORAGE_UNAVAILABLE'));
      }).catch(async e => {
        if (e && e.name !== 'ConstraintError') throw e;
      });
    } finally { db.close(); }
    const saved = await getStored();
    if (!validRecord(saved)) throw Error('BROWSER_STORAGE_UNAVAILABLE');
    return saved;
  }
  async function keyId(jwk) {
    const message = enc.encode('htsport-firefox-key-v1:' + jwk.x + ':' + jwk.y);
    return 'bk_' + to64(await crypto.subtle.digest('SHA-256', message));
  }
  async function signed(record, challenge, purpose) {
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      throw Error('INVALID_BROWSER_CHALLENGE');
    const payload = enc.encode('HTSPORT:browser-key:v1:' + purpose + ':' + challenge);
    return to64(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' }, record.privateKey, payload));
  }
  async function requireServer() {
    const health = await window.HTAuth.call('/api/health');
    const parts = String(health.version || '').split('.').map(Number);
    if (parts.length !== 3 || parts.some(p => !Number.isInteger(p) || p < 0) ||
        parts[0] < 1 || (parts[0] === 1 && (parts[1] < 4 ||
        (parts[1] === 4 && parts[2] < 10)))) {
      throw Error('BROWSER_WORKER_UPDATE_REQUIRED');
    }
    if (health.browserKeyReady !== true) throw Error('BROWSER_DB_UPDATE_REQUIRED');
  }
  async function register(username, onProgress) {
    const progress = m => { if (typeof onProgress === 'function') onProgress(m); };
    await requireServer();
    progress('Verifica della chiave Firefox...');
    const record = await getOrCreate();
    const localId = await keyId(record.publicKey);
    progress('Controllo della registrazione sul server...');
    const options = await window.HTAuth.call('/api/browser/register/options', {
      username, publicKey: record.publicKey
    });
    if (options.keyId !== localId) throw Error('BROWSER_KEY_MISMATCH');
    const signature = await signed(record, options.challenge, 'register');
    const saved = await window.HTAuth.call('/api/browser/register/verify', {
      requestId: options.requestId, publicKey: record.publicKey, signature
    });
    if (!saved.token) throw Error('REGISTRATION_FAILED');
    window.HTAuth.setToken(saved.token);
    return saved;
  }
  async function login() {
    const record = await getStored();
    if (!validRecord(record)) {
      if (record) throw Error('BROWSER_KEY_CORRUPT');
      throw Error('BROWSER_KEY_MISSING');
    }
    await requireServer();
    const options = await window.HTAuth.call('/api/browser/login/options', {
      keyId: await keyId(record.publicKey)
    });
    const signature = await signed(record, options.challenge, 'login');
    const saved = await window.HTAuth.call('/api/browser/login/verify', {
      requestId: options.requestId, signature
    });
    if (!saved.token) throw Error('LOGIN_REQUIRED');
    window.HTAuth.setToken(saved.token);
    return saved;
  }
  window.HTBrowserIdentity = Object.freeze({
    supported, hasIdentity, register, login
  });
})();
