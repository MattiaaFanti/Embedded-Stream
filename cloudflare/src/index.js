import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const from64 = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), (c) => c.charCodeAt(0));
const sha = async (value) => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))));
const ok = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const fail = (code, status = 400) => ok({ error: code }, status);

function checkConfig(env) {
  if (!env.DB || !env.SITE_ORIGIN || !env.RP_ID || !env.TOKEN_PEPPER || !env.ENCRYPTION_KEY || !env.BOOTSTRAP_SECRET) {
    throw new Error('Cloudflare configuration incomplete');
  }
  if (from64(env.ENCRYPTION_KEY).byteLength !== 32) throw new Error('ENCRYPTION_KEY must contain 32 random bytes');
}
function cors(response, env) {
  const h = new Headers(response.headers);
  h.set('Access-Control-Allow-Origin', env.SITE_ORIGIN);
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Bootstrap-Secret');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers: h });
}
async function readJSON(request) {
  if (Number(request.headers.get('content-length') || 0) > 16384) throw new Error('Payload too large');
  const text = await request.text();
  if (text.length > 16384) throw new Error('Payload too large');
  return JSON.parse(text || '{}');
}
async function rate(env, request, action, limit, windowSeconds) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const key = await sha(env.TOKEN_PEPPER + ':' + action + ':' + ip);
  const windowAt = Math.floor(now() / windowSeconds) * windowSeconds;
  await env.DB.prepare(
    'INSERT INTO rate_limits (key,count,window_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_at=excluded.window_at THEN count+1 ELSE 1 END, window_at=excluded.window_at'
  ).bind(key, windowAt).run();
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key=?').bind(key).first();
  if (row.count > limit) throw new Error('RATE_LIMIT');
}
async function encrypt(env, value) {
  if (value === null || value === undefined || value === '') return null;
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey('raw', from64(env.ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(String(value))));
  return b64u(iv) + '.' + b64u(cipher);
}
async function decrypt(env, value) {
  if (!value) return '';
  const [v, c] = value.split('.');
  const key = await crypto.subtle.importKey('raw', from64(env.ENCRYPTION_KEY), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(v) }, key, from64(c));
  return new TextDecoder().decode(plain);
}
async function challenge(env, purpose, value, payload) {
  const requestId = uuid();
  await env.DB.prepare('INSERT INTO challenges (id,challenge,purpose,payload,expires_at) VALUES (?,?,?,?,?)')
    .bind(requestId, value, purpose, JSON.stringify(payload || {}), now() + 300).run();
  return requestId;
}
async function consume(env, requestId, purpose) {
  if (!requestId || typeof requestId !== 'string') throw new Error('CHALLENGE_MISSING');
  const row = await env.DB.prepare('SELECT * FROM challenges WHERE id=? AND purpose=? AND used_at IS NULL AND expires_at>?')
    .bind(requestId, purpose, now()).first();
  if (!row) throw new Error('CHALLENGE_EXPIRED');
  const result = await env.DB.prepare('UPDATE challenges SET used_at=? WHERE id=? AND used_at IS NULL')
    .bind(now(), requestId).run();
  if (result.meta.changes !== 1) throw new Error('CHALLENGE_USED');
  return { expectedChallenge: row.challenge, ...JSON.parse(row.payload) };
}
async function issueSession(env, userId) {
  const token = b64u(randomBytes(32));
  const expiresAt = now() + 7 * 86400;
  const hash = await sha(env.TOKEN_PEPPER + ':' + token);
  await env.DB.prepare('INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES (?,?,?,?,?)')
    .bind(uuid(), userId, hash, now(), expiresAt).run();
  return { token, expiresAt };
}
async function auth(env, request, admin = false) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) throw new Error('LOGIN_REQUIRED');
  const token = header.slice(7);
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) throw new Error('LOGIN_REQUIRED');
  const hash = await sha(env.TOKEN_PEPPER + ':' + token);
  const row = await env.DB.prepare(
    'SELECT s.id AS session_id, u.id, u.username, u.role, u.status, u.created_at, u.last_login_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL'
  ).bind(hash, now()).first();
  if (!row) throw new Error('LOGIN_REQUIRED');
  if (row.status === 'banned') throw new Error('BANNED');
  if (admin && (row.role !== 'admin' || row.status !== 'active')) throw new Error('ADMIN_REQUIRED');
  return row;
}
async function audit(env, actor, action, target) {
  await env.DB.prepare('INSERT INTO audit (id,actor_user_id,action,target,created_at) VALUES (?,?,?,?,?)')
    .bind(uuid(), actor || null, action, target || null, now()).run();
}
function validateName(v) {
  const name = String(v || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40 || /[<>\\]/.test(name)) throw new Error('INVALID_USERNAME');
  return name;
}
const rp = (env) => ({ rpName: 'HTSport Access', rpID: env.RP_ID });
async function registrationOptions(env, username, purpose) {
  const userId = uuid();
  const options = await generateRegistrationOptions({
    ...rp(env), userName: username, userDisplayName: username,
    userID: enc.encode(userId),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257],
    timeout: 120000
  });
  const requestId = await challenge(env, purpose, options.challenge, { userId, username });
  return { requestId, options };
}
async function verifyRegistration(env, body, purpose) {
  if (!body || !body.credential || !body.requestId) throw new Error('INVALID_RESPONSE');
  const ctx = await consume(env, body.requestId, purpose);
  const verification = await verifyRegistrationResponse({
    response: body.credential,
    expectedChallenge: ctx.expectedChallenge,
    expectedOrigin: env.SITE_ORIGIN,
    expectedRPID: env.RP_ID,
    requireUserVerification: true
  });
  if (!verification.verified || !verification.registrationInfo) throw new Error('PASSKEY_INVALID');
  return { ctx, info: verification.registrationInfo };
}
async function insertRegistration(env, username, role, status, info, userId) {
  const cred = info.credential;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id,username,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .bind(userId, username, role, status, now(), now()),
    env.DB.prepare('INSERT INTO credentials (id,user_id,public_key,counter,transports,device_type,backed_up,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(cred.id, userId, b64u(cred.publicKey), cred.counter, JSON.stringify(cred.transports || []),
        info.credentialDeviceType || '', info.credentialBackedUp ? 1 : 0, now())
  ]);
}
async function adminExists(env) {
  const row = await env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
  return !!row;
}
async function loginOptions(env) {
  const options = await generateAuthenticationOptions({
    rpID: env.RP_ID, userVerification: 'required',
    allowCredentials: [], timeout: 120000
  });
  return { requestId: await challenge(env, 'login', options.challenge, {}), options };
}
async function verifyLogin(env, body) {
  const ctx = await consume(env, body.requestId, 'login');
  const credentialId = body.credential && body.credential.id;
  const row = await env.DB.prepare(
    'SELECT c.*,u.status,u.username,u.role FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.id=? AND c.revoked_at IS NULL'
  ).bind(credentialId).first();
  if (!row) throw new Error('DEVICE_REVOKED_OR_UNKNOWN');
  if (row.status === 'banned') throw new Error('BANNED');
  const checked = await verifyAuthenticationResponse({
    response: body.credential,
    expectedChallenge: ctx.expectedChallenge,
    expectedOrigin: env.SITE_ORIGIN,
    expectedRPID: env.RP_ID,
    requireUserVerification: true,
    credential: { id: row.id, publicKey: from64(row.public_key), counter: row.counter, transports: JSON.parse(row.transports) }
  });
  if (!checked.verified) throw new Error('PASSKEY_INVALID');
  await env.DB.batch([
    env.DB.prepare('UPDATE credentials SET counter=?,last_used_at=? WHERE id=?')
      .bind(checked.authenticationInfo.newCounter, now(), row.id),
    env.DB.prepare('UPDATE users SET last_login_at=? WHERE id=?')
      .bind(now(), row.user_id)
  ]);
  return { userId: row.user_id, username: row.username, role: row.role, status: row.status };
}
async function licenses(env) {
  const rows = await env.DB.prepare('SELECT * FROM licenses ORDER BY created_at DESC LIMIT 500').all();
  return Promise.all(rows.results.map(async (r) => ({
    id: r.id, product: r.product, serial: await decrypt(env, r.encrypted_serial),
    notes: await decrypt(env, r.encrypted_notes), assignedUserId: r.assigned_user_id,
    expiresOn: r.expires_on, status: r.status, createdAt: r.created_at
  })));
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === '/api/health' && method === 'GET') return ok({ online: true, version: '1.0.0' });
  if (method === 'POST' && path === '/api/register/options') {
    await rate(env, request, 'register', 12, 3600);
    const b = await readJSON(request);
    return ok(await registrationOptions(env, validateName(b.username), 'register'));
  }
  if (method === 'POST' && path === '/api/register/verify') {
    const { ctx, info } = await verifyRegistration(env, await readJSON(request), 'register');
    await insertRegistration(env, ctx.username, 'user', 'pending', info, ctx.userId);
    await audit(env, ctx.userId, 'register', ctx.userId);
    return ok({ username: ctx.username, status: 'pending', deviceId: ctx.userId }, 201);
  }
  if (method === 'POST' && path === '/api/login/options') {
    await rate(env, request, 'login', 90, 3600);
    return ok(await loginOptions(env));
  }
  if (method === 'POST' && path === '/api/login/verify') {
    const user = await verifyLogin(env, await readJSON(request));
    return ok({ ...user, ...(await issueSession(env, user.userId)) });
  }
  if (method === 'GET' && path === '/api/admin/bootstrap/status') return ok({ needed: !(await adminExists(env)) });
  if (method === 'POST' && path === '/api/admin/bootstrap/options') {
    await rate(env, request, 'bootstrap', 12, 3600);
    if (await adminExists(env)) return fail('ALREADY_INITIALIZED', 403);
    if (request.headers.get('X-Bootstrap-Secret') !== env.BOOTSTRAP_SECRET) return fail('FORBIDDEN', 403);
    const b = await readJSON(request);
    return ok(await registrationOptions(env, validateName(b.username), 'bootstrap'));
  }
  if (method === 'POST' && path === '/api/admin/bootstrap/verify') {
    if (await adminExists(env)) return fail('ALREADY_INITIALIZED', 403);
    if (request.headers.get('X-Bootstrap-Secret') !== env.BOOTSTRAP_SECRET) return fail('FORBIDDEN', 403);
    const { ctx, info } = await verifyRegistration(env, await readJSON(request), 'bootstrap');
    if (await adminExists(env)) return fail('ALREADY_INITIALIZED', 403);
    await insertRegistration(env, ctx.username, 'admin', 'active', info, ctx.userId);
    await audit(env, ctx.userId, 'admin_bootstrap', ctx.userId);
    return ok({ created: true, ...(await issueSession(env, ctx.userId)) }, 201);
  }

  if (method === 'GET' && path === '/api/me') {
    const user = await auth(env, request);
    return ok({ userId: user.id, username: user.username, role: user.role, status: user.status, deviceId: user.id });
  }
  if (method === 'POST' && path === '/api/logout') {
    const user = await auth(env, request);
    await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').bind(now(), user.session_id).run();
    return ok({ loggedOut: true });
  }

  if (!path.startsWith('/api/admin/')) return fail('NOT_FOUND', 404);
  const admin = await auth(env, request, true);
  if (method === 'GET' && path === '/api/admin/summary') {
    const rows = await env.DB.prepare('SELECT status,COUNT(*) AS total FROM users WHERE role=? GROUP BY status').bind('user').all();
    const lic = await env.DB.prepare('SELECT COUNT(*) AS total FROM licenses').first();
    return ok({ users: rows.results, licenses: lic.total });
  }
  if (method === 'GET' && path === '/api/admin/users') {
    const users = await env.DB.prepare(
      "SELECT u.id,u.username,u.role,u.status,u.created_at,u.last_login_at,COUNT(c.id) AS credentials FROM users u LEFT JOIN credentials c ON c.user_id=u.id AND c.revoked_at IS NULL GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500"
    ).all();
    return ok({ users: users.results });
  }
  if (method === 'GET' && path === '/api/admin/credentials') {
    const items = await env.DB.prepare(
      'SELECT c.id,c.user_id,c.created_at,c.last_used_at,c.device_type,c.backed_up,c.revoked_at,u.username FROM credentials c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 500'
    ).all();
    return ok({ credentials: items.results });
  }
  const statusRoute = path.match(/^\/api\/admin\/users\/([a-f0-9-]+)\/status$/i);
  if (method === 'POST' && statusRoute) {
    const target = statusRoute[1], b = await readJSON(request);
    if (!['pending','active','banned'].includes(b.status)) return fail('INVALID_STATUS');
    if (target === admin.id) return fail('CANNOT_MODIFY_SELF', 403);
    const user = await env.DB.prepare('SELECT id,role FROM users WHERE id=?').bind(target).first();
    if (!user || user.role === 'admin') return fail('USER_NOT_FOUND', 404);
    await env.DB.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?').bind(b.status, now(), target).run();
    if (b.status !== 'active') await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=?').bind(now(), target).run();
    await audit(env, admin.id, 'user_' + b.status, target);
    return ok({ updated: true });
  }
  const revokeRoute = path.match(/^\/api\/admin\/credentials\/([A-Za-z0-9_-]+)\/revoke$/);
  if (method === 'POST' && revokeRoute) {
    const cred = await env.DB.prepare('SELECT user_id FROM credentials WHERE id=?').bind(revokeRoute[1]).first();
    if (!cred || cred.user_id === admin.id) return fail('CREDENTIAL_NOT_FOUND', 404);
    await env.DB.prepare('UPDATE credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL').bind(now(), revokeRoute[1]).run();
    await env.DB.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=?').bind(now(), cred.user_id).run();
    await audit(env, admin.id, 'credential_revoked', revokeRoute[1]);
    return ok({ revoked: true });
  }
  if (method === 'GET' && path === '/api/admin/licenses') return ok({ licenses: await licenses(env) });
  if (method === 'POST' && path === '/api/admin/licenses') {
    const b = await readJSON(request);
    const product = String(b.product || '').trim(), serial = String(b.serial || '').trim();
    if (!product || product.length > 120 || !serial || serial.length > 4000 || String(b.notes || '').length > 4000) return fail('INVALID_LICENSE');
    const assignedUserId = b.assignedUserId || null;
    if (assignedUserId && !(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(assignedUserId).first())) return fail('USER_NOT_FOUND');
    if (b.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(b.expiresOn)) return fail('INVALID_DATE');
    const id = uuid();
    await env.DB.prepare(
      'INSERT INTO licenses(id,product,encrypted_serial,encrypted_notes,assigned_user_id,expires_on,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).bind(id, product, await encrypt(env, serial), await encrypt(env, b.notes), assignedUserId, b.expiresOn || null, 'active', now(), now()).run();
    await audit(env, admin.id, 'license_created', id);
    return ok({ id }, 201);
  }
  const deleteLicense = path.match(/^\/api\/admin\/licenses\/([a-f0-9-]+)\/delete$/i);
  if (method === 'POST' && deleteLicense) {
    const id = deleteLicense[1];
    const result = await env.DB.prepare('DELETE FROM licenses WHERE id=?').bind(id).run();
    if (result.meta.changes !== 1) return fail('LICENSE_NOT_FOUND', 404);
    await audit(env, admin.id, 'license_deleted', id);
    return ok({ deleted: true });
  }
  const licenseRoute = path.match(/^\/api\/admin\/licenses\/([a-f0-9-]+)$/i);
  if (method === 'POST' && licenseRoute) {
    const b = await readJSON(request), id = licenseRoute[1];
    const old = await env.DB.prepare('SELECT * FROM licenses WHERE id=?').bind(id).first();
    if (!old) return fail('LICENSE_NOT_FOUND', 404);
    const product = String(b.product === undefined ? old.product : b.product).trim();
    const serial = b.serial === undefined ? await decrypt(env, old.encrypted_serial) : String(b.serial).trim();
    const notes = b.notes === undefined ? await decrypt(env, old.encrypted_notes) : String(b.notes);
    const uid = b.assignedUserId === undefined ? old.assigned_user_id : (b.assignedUserId || null);
    const date = b.expiresOn === undefined ? old.expires_on : (b.expiresOn || null);
    const status = b.status === undefined ? old.status : b.status;
    if (!product || product.length > 120 || !serial || serial.length > 4000 || notes.length > 4000 ||
      !['active','revoked'].includes(status) || (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))) return fail('INVALID_LICENSE');
    if (uid && !(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(uid).first())) return fail('USER_NOT_FOUND');
    await env.DB.prepare('UPDATE licenses SET product=?,encrypted_serial=?,encrypted_notes=?,assigned_user_id=?,expires_on=?,status=?,updated_at=? WHERE id=?')
      .bind(product, await encrypt(env, serial), await encrypt(env, notes), uid, date, status, now(), id).run();
    await audit(env, admin.id, 'license_updated', id);
    return ok({ updated: true });
  }
  if (method === 'GET' && path === '/api/admin/audit') {
    const rows = await env.DB.prepare('SELECT action,target,created_at,actor_user_id FROM audit ORDER BY created_at DESC LIMIT 100').all();
    return ok({ entries: rows.results });
  }
  return fail('NOT_FOUND', 404);
}
export default {
  async fetch(request, env) {
    let res;
    try {
      checkConfig(env);
      const origin = request.headers.get('Origin');
      if (origin && origin !== env.SITE_ORIGIN) return fail('ORIGIN_NOT_ALLOWED', 403);
      if (request.method === 'OPTIONS') {
        if (origin !== env.SITE_ORIGIN) return fail('ORIGIN_NOT_ALLOWED', 403);
        res = new Response(null, { status: 204 });
      } else if (request.method !== 'GET' && origin !== env.SITE_ORIGIN) {
        res = fail('ORIGIN_REQUIRED', 403);
      } else {
        res = await route(request, env);
      }
    } catch (err) {
      const message = err && err.message || 'SERVER_ERROR';
      const recognized = /^(LOGIN_REQUIRED|ADMIN_REQUIRED|BANNED|CHALLENGE_|PASSKEY_INVALID|DEVICE_REVOKED_OR_UNKNOWN|RATE_LIMIT|INVALID_|Payload too large)/.test(message);
      const status = message === 'RATE_LIMIT' ? 429 :
        message === 'LOGIN_REQUIRED' ? 401 :
        ['BANNED','ADMIN_REQUIRED','DEVICE_REVOKED_OR_UNKNOWN'].includes(message) ? 403 :
        recognized ? 400 : 500;
      if (status === 500) console.error('Worker error', err);
      res = fail(recognized ? message : 'SERVER_ERROR', status);
    }
    return cors(res, env);
  }
};