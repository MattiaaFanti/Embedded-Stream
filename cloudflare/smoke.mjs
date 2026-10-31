// node smoke.mjs https://htsport-license-api.example.workers.dev
// Basic integration checks after Wrangler deploy, no secrets or passkeys required.
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) {
  console.error('Usage: node smoke.mjs https://your-license-worker.workers.dev');
  process.exit(2);
}
const expectedOrigin = process.argv[3] || 'https://mattiaafanti.github.io';
const tests = [
  ['health', '/api/health', { method: 'GET' }, 200],
  ['admin requires auth', '/api/admin/users', { method: 'GET', headers: { Origin: expectedOrigin } }, 401],
  ['CORS preflight', '/api/login/options', { method: 'OPTIONS', headers: { Origin: expectedOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }, 204],
  ['foreign origin forbidden', '/api/login/options', { method: 'POST', headers: { Origin: 'https://malicious.example', 'Content-Type': 'application/json' }, body: '{}' }, 403]
];
let failed = false;
for (const [label, path, init, expected] of tests) {
  try {
    const response = await fetch(base + path, init);
    if (response.status !== expected) throw Error('Expected ' + expected + ', got ' + response.status);
    if (label === 'CORS preflight' && response.headers.get('access-control-allow-origin') !== expectedOrigin) {
      throw Error('CORS allow-origin mismatch');
    }
    console.log('PASS', label);
  } catch (e) {
    failed = true;
    console.error('FAIL', label, e.message);
  }
}
if (failed) process.exitCode = 1;
