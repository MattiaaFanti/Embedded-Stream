(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { users: [], credentials: [], licenses: [], audit: [], editingId: null, admin: null };
  function showAuth(section) {
    $('adminAuth').classList.remove('hidden');
    $('dashboard').classList.add('hidden');
    ['adminLoading','adminLogin','bootstrap','adminSetup'].forEach(id => $(id).classList.toggle('hidden', id !== section));
  }
  function error(e, inDashboard = false) {
    const el = inDashboard ? $('dashboardMessage') : $('adminError');
    const names = {
      ADMIN_REQUIRED: 'Questa Passkey non appartiene a un amministratore.',
      LOGIN_REQUIRED: 'Sessione scaduta. Accedi nuovamente.',
      SERVER_NOT_CONFIGURED: 'Il Worker non è ancora configurato.',
      RATE_LIMIT: 'Troppe richieste. Riprova più tardi.'
    };
    el.textContent = names[e.message] || e.message || String(e);
    el.classList.remove('hidden');
  }
  function clearErrors() { $('adminError').classList.add('hidden'); $('dashboardMessage').classList.add('hidden'); }
  async function work(button, fn, inDashboard = false) {
    if (button.disabled) return;
    button.disabled = true;
    clearErrors();
    try { await fn(); } catch (e) { error(e, inDashboard); }
    finally { button.disabled = false; }
  }
  function td(row, value, asCode = false) {
    const cell = document.createElement('td');
    const el = document.createElement(asCode ? 'code' : 'span');
    el.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
    cell.append(el); row.append(cell);
    return cell;
  }
  function button(parent, label, onClick, danger = false) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'smallbtn' + (danger ? ' warn' : '');
    b.textContent = label; b.addEventListener('click', () => work(b, onClick, true));
    parent.append(b); return b;
  }
  function date(timestamp) {
    if (!timestamp) return '—';
    return new Date(Number(timestamp) * 1000).toLocaleString('it-IT');
  }
  function tag(status) {
    const span = document.createElement('span');
    span.className = 'tag ' + status; span.textContent = status;
    return span;
  }
  function statusCell(row, status) {
    const cell = document.createElement('td'); cell.append(tag(status)); row.append(cell);
  }
  async function load() {
    const [users, credentials, licenses, audit, summary] = await Promise.all([
      HTAuth.call('/api/admin/users'), HTAuth.call('/api/admin/credentials'),
      HTAuth.call('/api/admin/licenses'), HTAuth.call('/api/admin/audit'),
      HTAuth.call('/api/admin/summary')
    ]);
    state.users = users.users; state.credentials = credentials.credentials;
    state.licenses = licenses.licenses; state.audit = audit.entries;
    renderStats(summary); renderUsers(); renderDevices(); renderLicenses(); renderAudit(); renderAssign();
  }
  function renderStats(summary) {
    const stats = [
      ['Utenti totali', state.users.filter(u => u.role === 'user').length],
      ['In attesa', state.users.filter(u => u.status === 'pending').length],
      ['Attivi', state.users.filter(u => u.status === 'active' && u.role === 'user').length],
      ['Bannati', state.users.filter(u => u.status === 'banned').length],
      ['Licenze', summary.licenses]
    ];
    $('stats').replaceChildren();
    stats.forEach(([label, value]) => {
      const el = document.createElement('div'); el.className = 'stat';
      const strong = document.createElement('strong'); strong.textContent = String(value);
      const span = document.createElement('span'); span.textContent = label;
      el.append(strong, span); $('stats').append(el);
    });
  }
  async function changeUser(userId, status) {
    if (!confirm('Confermare il cambio dello stato in "' + status + '"?')) return;
    await HTAuth.call('/api/admin/users/' + encodeURIComponent(userId) + '/status', { status });
    await load();
  }
  function renderUsers() {
    const body = $('usersBody'); body.replaceChildren();
    state.users.forEach(u => {
      const row = document.createElement('tr');
      td(row, u.username + (u.role === 'admin' ? ' (admin)' : ''));
      td(row, u.id, true); statusCell(row, u.status);
      td(row, u.credentials); td(row, date(u.last_login_at));
      const actions = document.createElement('td'); row.append(actions);
      if (u.role !== 'admin') {
        if (u.status !== 'active') button(actions, 'Approva', () => changeUser(u.id, 'active'));
        if (u.status !== 'banned') button(actions, 'Banna', () => changeUser(u.id, 'banned'), true);
        if (u.status === 'active') button(actions, 'Sospendi', () => changeUser(u.id, 'pending'));
      }
      body.append(row);
    });
  }
  function renderDevices() {
    const body = $('devicesBody'); body.replaceChildren();
    state.credentials.forEach(c => {
      const row = document.createElement('tr');
      td(row, c.username); td(row, c.id, true);
      td(row, (c.device_type || 'Passkey') + (c.backed_up ? ' · sincronizzata' : ''));
      td(row, date(c.last_used_at)); statusCell(row, c.revoked_at ? 'revoked' : 'active');
      const actions = document.createElement('td'); row.append(actions);
      if (!c.revoked_at && c.user_id !== state.admin.userId) {
        button(actions, 'Revoca', async () => {
          if (!confirm('Revocare questa Passkey? Le sessioni dell’utente verranno chiuse.')) return;
          await HTAuth.call('/api/admin/credentials/' + encodeURIComponent(c.id) + '/revoke', {});
          await load();
        }, true);
      }
      body.append(row);
    });
  }
  function renderAssign() {
    const select = $('assignedUser'), previous = select.value;
    select.replaceChildren(new Option('Non assegnata', ''));
    state.users.forEach(u => select.add(new Option(u.username + ' (' + u.status + ')', u.id)));
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
  }
  function resetLicense() {
    state.editingId = null; $('licenseForm').reset();
    $('saveLicenseBtn').textContent = 'Salva nuova licenza';
  }
  function editLicense(lic) {
    state.editingId = lic.id;
    $('product').value = lic.product; $('serial').value = lic.serial;
    $('licenseNotes').value = lic.notes; $('assignedUser').value = lic.assignedUserId || '';
    $('expiresOn').value = lic.expiresOn || ''; $('licenseStatus').value = lic.status;
    $('saveLicenseBtn').textContent = 'Salva modifiche';
    $('licenseForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderLicenses() {
    const body = $('licensesBody'); body.replaceChildren();
    const username = id => (state.users.find(u => u.id === id) || {}).username || '—';
    state.licenses.forEach(lic => {
      const row = document.createElement('tr');
      td(row, lic.product);
      const serialCell = td(row, '•••• ••••');
      serialCell.className = 'monotext';
      td(row, username(lic.assignedUserId)); td(row, lic.expiresOn);
      statusCell(row, lic.status);
      const actions = document.createElement('td'); row.append(actions);
      let visible = false;
      button(actions, 'Mostra', async () => {
        visible = !visible;
        serialCell.firstChild.textContent = visible ? lic.serial : '•••• ••••';
      });
      button(actions, 'Copia', async () => {
        await navigator.clipboard.writeText(lic.serial);
      });
      button(actions, 'Modifica', async () => editLicense(lic));
      if (lic.status === 'active') {
        button(actions, 'Revoca', async () => {
          if (!confirm('Revocare questa licenza?')) return;
          await HTAuth.call('/api/admin/licenses/' + lic.id, { status: 'revoked' });
          await load();
        }, true);
      }
      body.append(row);
    });
  }
  function renderAudit() {
    const body = $('auditBody'); body.replaceChildren();
    state.audit.forEach(a => {
      const row = document.createElement('tr');
      td(row, date(a.created_at)); td(row, a.action); td(row, a.target, true);
      body.append(row);
    });
  }
  function activateTab(which) {
    ['users','devices','licenses','audit'].forEach(id => $('tab-' + id).classList.toggle('hidden', id !== which));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === which));
  }
  async function dashboard() {
    const me = await HTAuth.call('/api/me');
    if (me.role !== 'admin' || me.status !== 'active') throw Error('ADMIN_REQUIRED');
    state.admin = me;
    $('adminName').textContent = 'Amministratore: ' + me.username;
    await load();
    $('adminAuth').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
  }
  async function start() {
    if (!HTAuth.ready) { showAuth('adminSetup'); return; }
    if (HTAuth.getToken()) {
      try { await dashboard(); return; }
      catch (e) {
        if (e.message !== 'LOGIN_REQUIRED' && e.message !== 'ADMIN_REQUIRED') error(e);
        HTAuth.setToken('');
      }
    }
    try {
      const res = await HTAuth.call('/api/admin/bootstrap/status');
      showAuth(res.needed ? 'bootstrap' : 'adminLogin');
    } catch (e) { showAuth('adminLogin'); error(e); }
  }
  $('adminLoginBtn').addEventListener('click', function () {
    work(this, async () => {
      await HTAuth.login();
      await dashboard();
    });
  });
  $('bootstrapForm').addEventListener('submit', function (event) {
    event.preventDefault();
    work(this.querySelector('button'), async () => {
      const name = $('bootstrapName').value.trim();
      const secret = $('bootstrapSecret').value;
      await HTAuth.register(name, secret);
      $('bootstrapSecret').value = '';
      await dashboard();
    });
  });
  $('refreshBtn').addEventListener('click', function () { work(this, load, true); });
  $('adminLogoutBtn').addEventListener('click', async () => {
    try { await HTAuth.logout(); } catch { HTAuth.setToken(''); }
    state.admin = null; showAuth('adminLogin');
  });
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
  $('clearLicenseBtn').addEventListener('click', resetLicense);
  $('licenseForm').addEventListener('submit', function (event) {
    event.preventDefault();
    work($('saveLicenseBtn'), async () => {
      const payload = {
        product: $('product').value.trim(), serial: $('serial').value.trim(),
        notes: $('licenseNotes').value, assignedUserId: $('assignedUser').value || null,
        expiresOn: $('expiresOn').value || null, status: $('licenseStatus').value
      };
      if (state.editingId) await HTAuth.call('/api/admin/licenses/' + state.editingId, payload);
      else await HTAuth.call('/api/admin/licenses', payload);
      resetLicense(); await load();
    }, true);
  });
  start();
})();