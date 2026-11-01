(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { users: [], credentials: [], licenses: [], audit: [],
    editingId: null, admin: null, presence: null };
  let presenceTimer = null, presenceBusy = false;
  let registrationsTimer = null, registrationsBusy = false;
  let adminMutationVersion = 0, adminMutationsInProgress = 0;
  const REGISTRATIONS_POLL_MS = 20000;
  function countPresence(devices) {
    const list = Array.isArray(devices) ? devices : [];
    return {
      devices: list, onlineDevices: list.length,
      onlineUsers: new Set(list.map(d => d.userId)).size
    };
  }
  async function refreshPresence() {
    if (!state.admin || presenceBusy) return;
    presenceBusy = true;
    try {
      const response = await HTAuth.call('/api/admin/presence');
      if (!Array.isArray(response.devices)) throw Error('INVALID_PRESENCE_DATA');
      state.presence = { ...response, ...countPresence(response.devices) };
      // The Worker reports last-online timestamps for both online and
      // offline users. Update the existing table rows every fifteen seconds.
      if (Array.isArray(response.lastOnline)) {
        const lastSeen = new Map(response.lastOnline.map(item =>
          [item.userId, Number(item.lastOnlineAt)]));
        state.users.forEach(user => {
          const timestamp = lastSeen.get(user.id);
          if (Number.isFinite(timestamp) && timestamp > Number(user.last_login_at || 0))
            user.last_login_at = timestamp;
        });
      }
      $('presenceInfo').textContent =
        'Pannello aggiornato ogni 15 secondi · Ping ogni 20 secondi · Offline dopo 90 secondi senza segnali (oppure alla chiusura comunicata dal browser).';
    } catch {
      state.presence = null;
      $('presenceInfo').textContent =
        'Presenza non disponibile: occorrono il Worker aggiornato e la migrazione D1 0002_presence.sql.';
    } finally {
      presenceBusy = false;
      renderUsers();
      renderStats({ licenses: state.licenses.length });
    }
  }
  function startPresenceRefresh() {
    if (!presenceTimer) {
      presenceTimer = setInterval(() => {
        if (!$('dashboard').classList.contains('hidden')) void refreshPresence();
      }, 15000);
    }
    void refreshPresence();
  }
  // Check for new applications without reloading the dashboard. Use the
  // existing authenticated admin endpoint; no Worker changes or D1 writes.
  async function refreshRegistrations() {
    if (!state.admin || registrationsBusy || adminMutationsInProgress ||
        $('dashboard').classList.contains('hidden')) return;
    registrationsBusy = true;
    const adminId = state.admin.userId;
    const startedAtVersion = adminMutationVersion;
    try {
      const response = await HTAuth.call('/api/admin/users');
      if (!Array.isArray(response.users)) throw Error('INVALID_USERS_DATA');
      // An in-flight response must never undo an Approva, Banna or Elimina
      // action, a manual refresh or an administrator logout.
      if (!state.admin || state.admin.userId !== adminId ||
          adminMutationsInProgress || startedAtVersion !== adminMutationVersion)
        return;
      const previous = new Map(state.users.map(u => [u.id, u]));
      const changed = response.users.length !== state.users.length ||
        response.users.some((u, i) => {
          const old = previous.get(u.id);
          return !old || state.users[i]?.id !== u.id ||
            u.status !== old.status || u.username !== old.username ||
            u.role !== old.role || u.registrationSerial !== old.registrationSerial ||
            Number(u.credentials) !== Number(old.credentials);
        });
      if (!changed) return;
      state.users = response.users.map(user => ({
        ...user,
        // The presence poll may already know a more recent last-online time.
        last_login_at: Math.max(Number(user.last_login_at) || 0,
          Number(previous.get(user.id)?.last_login_at) || 0) || null
      }));
      renderUsers();
      renderStats({ licenses: state.licenses.length });
      renderAssign();
      // Load credentials and audit only when the user list actually changes,
      // not on every 20-second poll.
      void refreshChangedUserDetails();
    } catch (error) {
      // Keep the existing dashboard visible during transient network errors;
      // the next poll retries. Do not replace data with an empty list.
      if (error.message === 'LOGIN_REQUIRED' || error.message === 'ADMIN_REQUIRED') {
        if (registrationsTimer) clearInterval(registrationsTimer);
        registrationsTimer = null;
      }
    } finally {
      registrationsBusy = false;
    }
  }
  async function refreshChangedUserDetails() {
    const adminId = state.admin?.userId;
    const version = adminMutationVersion;
    try {
      const [credentials, audit] = await Promise.all([
        HTAuth.call('/api/admin/credentials'),
        HTAuth.call('/api/admin/audit')
      ]);
      if (!state.admin || state.admin.userId !== adminId ||
          adminMutationsInProgress || version !== adminMutationVersion) return;
      if (Array.isArray(credentials.credentials)) {
        state.credentials = credentials.credentials;
        renderDevices();
      }
      if (Array.isArray(audit.entries)) {
        state.audit = audit.entries;
        renderAudit();
      }
    } catch { /* The next normal refresh can retry nonessential details. */ }
  }
  function startRegistrationRefresh() {
    if (!registrationsTimer) {
      registrationsTimer = setInterval(() => { void refreshRegistrations(); },
        REGISTRATIONS_POLL_MS);
    }
  }
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
      RATE_LIMIT: 'Troppi tentativi. Riprova più tardi.',
      INVALID_ADMIN_CREDENTIALS: 'Password amministratore errata.',
      ADMIN_PASSWORD_NOT_CONFIGURED: 'Password amministratore non configurata su Cloudflare.',
      ADMIN_UNAVAILABLE: 'Amministratore non disponibile.'
    };
    el.textContent = names[e.message] || e.message || String(e);
    el.classList.remove('hidden');
  }
  function clearErrors() { $('adminError').classList.add('hidden'); $('dashboardMessage').classList.add('hidden'); }
  async function work(button, fn, inDashboard = false) {
    if (button.disabled) return;
    button.disabled = true;
    if (inDashboard) { adminMutationVersion++; adminMutationsInProgress++; }
    clearErrors();
    try { await fn(); } catch (e) { error(e, inDashboard); }
    finally {
      if (inDashboard) { adminMutationsInProgress--; adminMutationVersion++; }
      button.disabled = false;
    }
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
  function date(timestamp, includeSeconds = false) {
    if (!timestamp) return '—';
    const dateValue = new Date(Number(timestamp) * 1000);
    if (Number.isNaN(dateValue.getTime())) return '—';
    return includeSeconds
      ? dateValue.toLocaleString('it-IT', {
          day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
        })
      : dateValue.toLocaleString('it-IT');
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
    const pendingCount = state.users.filter(u => u.role === 'user' && u.status === 'pending').length;
    const usersTab = document.querySelector('.tab[data-tab="users"]');
    if (usersTab) usersTab.textContent = pendingCount
      ? 'Utenti (' + pendingCount + ' in attesa)' : 'Utenti';
    const stats = [
      ['Utenti totali', state.users.filter(u => u.role === 'user').length],
      ['In attesa', state.users.filter(u => u.status === 'pending').length],
      ['Attivi', state.users.filter(u => u.status === 'active' && u.role === 'user').length],
      ['Bannati', state.users.filter(u => u.status === 'banned').length],
      ['Licenze', summary.licenses],
      ['Dispositivi online', state.presence ? state.presence.onlineDevices : '—']
    ];
    $('stats').replaceChildren();
    stats.forEach(([label, value]) => {
      const el = document.createElement('div'); el.className = 'stat';
      const strong = document.createElement('strong'); strong.textContent = String(value);
      const span = document.createElement('span'); span.textContent = label;
      el.append(strong, span); $('stats').append(el);
    });
  }
  // Aggiorna immediatamente i componenti dopo la conferma del Worker.
  // Non dipende dalle altre chiamate di load(), che potrebbero fallire.
  function refreshLocalTables() {
    renderUsers();
    renderDevices();
    renderLicenses();
    renderAssign();
    renderStats({ licenses: state.licenses.length });
    renderAudit();
  }
  function addAudit(action, target) {
    state.audit.unshift({
      action, target,
      actor_user_id: state.admin && state.admin.userId,
      created_at: Math.floor(Date.now() / 1000)
    });
    if (state.audit.length > 100) state.audit.length = 100;
  }
  async function changeUser(userId, status) {
    const response = await HTAuth.call('/api/admin/users/' + encodeURIComponent(userId) + '/status', { status });
    if (!response.updated) throw Error('Aggiornamento non confermato dal server.');
    const user = state.users.find(u => u.id === userId);
    if (!user) { await load(); return; }
    user.status = status;
    addAudit('user_' + status, userId);
    refreshLocalTables();
  }
  function renderUsers() {
    const body = $('usersBody'); body.replaceChildren();
    const present = new Map();
    if (state.presence) {
      state.presence.devices.forEach(d => {
        if (!present.has(d.userId)) present.set(d.userId, []);
        present.get(d.userId).push(d);
      });
    }
    state.users.forEach(u => {
      const row = document.createElement('tr');
      td(row, u.username + (u.role === 'admin' ? ' (admin)' : ''));
      td(row, u.registrationSerial || u.id, true); statusCell(row, u.status);
      const activeDevices = present.get(u.id) || [];
      const presenceLabel = !state.presence ? '—' :
        activeDevices.length ? 'Online' : 'Offline';
      const presenceCell = td(row, presenceLabel);
      presenceCell.classList.add('presence-cell');
      if (state.presence) presenceCell.classList.add(activeDevices.length ? 'presence-online' : 'presence-offline');
      td(row, date(u.last_login_at, true));
      const actions = document.createElement('td'); row.append(actions);
      if (u.role !== 'admin') {
        // "pending" is reserved for first-time registration only.
        // Admin actions are just Approva and Banna (plus the separate X delete).
        if (u.status !== 'active') button(actions, 'Approva', () => changeUser(u.id, 'active'));
        if (u.status !== 'banned') button(actions, 'Banna', () => changeUser(u.id, 'banned'), true);
      }
      const deleteCell = document.createElement('td');
      deleteCell.className = 'user-delete-cell';
      row.append(deleteCell);
      if (u.role !== 'admin') {
        const remove = button(deleteCell, '×', async () => {
          if (!confirm('Eliminare definitivamente l’utente "' + u.username +
            '"? Verranno eliminate anche le sue Passkey e sessioni. Le licenze rimarranno non assegnate.')) return;
          // Nascondi subito la riga e aggiorna tutti i contatori senza
          // attendere alcun reload. Mantieni uno snapshot per il rollback.
          const oldUsers = state.users;
          const oldCredentials = state.credentials;
          const oldAssigned = new Map(state.licenses.map(lic => [lic.id, lic.assignedUserId]));
          const oldPresence = state.presence;
          state.users = state.users.filter(user => user.id !== u.id);
          state.credentials = state.credentials.filter(cred => cred.user_id !== u.id);
          if (state.presence) {
            state.presence = { ...state.presence,
              ...countPresence(state.presence.devices.filter(device => device.userId !== u.id)) };
          }
          state.licenses.forEach(lic => {
            if (lic.assignedUserId === u.id) lic.assignedUserId = null;
          });
          refreshLocalTables();
          try {
            const url = '/api/admin/users/' + encodeURIComponent(u.id) + '/delete';
            let deleted = false;
            try {
              const response = await HTAuth.call(url, {});
              deleted = response.deleted === true;
            } catch (err) {
              // Compatibilità con i Worker precedenti: potevano restituire
              // USER_NOT_FOUND dopo aver già eliminato realmente l'utente.
              // Verifica il database invece di mostrare un falso errore.
              const remote = await HTAuth.call('/api/admin/users').catch(() => null);
              if (remote && Array.isArray(remote.users) &&
                  !remote.users.some(user => user.id === u.id)) deleted = true;
              else throw err;
            }
            if (!deleted) throw Error('Eliminazione non confermata dal server.');
            addAudit('user_deleted', u.id);
            renderAudit();
          } catch (err) {
            // Il server non ha confermato la cancellazione: ripristina la
            // riga, le credenziali e le assegnazioni senza reload della pagina.
            state.users = oldUsers;
            state.credentials = oldCredentials;
            state.presence = oldPresence;
            state.licenses.forEach(lic => {
              if (oldAssigned.has(lic.id)) lic.assignedUserId = oldAssigned.get(lic.id);
            });
            refreshLocalTables();
            throw err;
          }
        }, true);
        remove.classList.add('delete-user-btn');
        remove.setAttribute('aria-label', 'Elimina definitivamente ' + u.username);
        remove.title = 'Elimina definitivamente ' + u.username;
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
          if (!confirm('Revocare questa credenziale? Le sessioni dell’utente verranno chiuse.')) return;
          const response = await HTAuth.call('/api/admin/credentials/' + encodeURIComponent(c.id) + '/revoke', {});
          if (!response.revoked) throw Error('Revoca non confermata dal server.');
          c.revoked_at = Math.floor(Date.now() / 1000);
          const owner = state.users.find(u => u.id === c.user_id);
          if (owner) owner.credentials = Math.max(0, Number(owner.credentials || 0) - 1);
          addAudit('credential_revoked', c.id);
          refreshLocalTables();
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
          const response = await HTAuth.call('/api/admin/licenses/' + lic.id, { status: 'revoked' });
          if (!response.updated) throw Error('Revoca non confermata dal server.');
          lic.status = 'revoked';
          addAudit('license_updated', lic.id);
          refreshLocalTables();
        }, true);
      }
      button(actions, 'Elimina', async () => {
        if (!confirm('Eliminare definitivamente il seriale e le note? Operazione irreversibile.')) return;
        const response = await HTAuth.call('/api/admin/licenses/' + lic.id + '/delete', {});
        if (!response.deleted) throw Error('Eliminazione licenza non confermata dal server.');
        state.licenses = state.licenses.filter(item => item.id !== lic.id);
        if (state.editingId === lic.id) resetLicense();
        addAudit('license_deleted', lic.id);
        refreshLocalTables();
      }, true);
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
    startPresenceRefresh();
    startRegistrationRefresh();
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
  $('adminPasswordForm').addEventListener('submit', function (event) {
    event.preventDefault();
    work(this.querySelector('button[type=submit]'), async () => {
      const input = $('adminPassword');
      try {
        await HTAuth.loginAdminWithPassword(input.value);
        await dashboard();
      } finally {
        input.value = '';
      }
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
    if (presenceTimer) clearInterval(presenceTimer);
    if (registrationsTimer) clearInterval(registrationsTimer);
    presenceTimer = null;
    registrationsTimer = null;
    adminMutationVersion++;
    try { await HTAuth.logout(); } catch { HTAuth.setToken(''); }
    state.admin = null; state.presence = null; showAuth('adminLogin');
  });
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => activateTab(btn.dataset.tab)));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshRegistrations();
  });
  window.addEventListener('focus', () => { void refreshRegistrations(); });
  $('clearLicenseBtn').addEventListener('click', resetLicense);
  $('licenseForm').addEventListener('submit', function (event) {
    event.preventDefault();
    work($('saveLicenseBtn'), async () => {
      const payload = {
        product: $('product').value.trim(), serial: $('serial').value.trim(),
        notes: $('licenseNotes').value, assignedUserId: $('assignedUser').value || null,
        expiresOn: $('expiresOn').value || null, status: $('licenseStatus').value
      };
      if (state.editingId) {
        const result = await HTAuth.call('/api/admin/licenses/' + state.editingId, payload);
        if (!result.updated) throw Error('Modifica licenza non confermata dal server.');
        const lic = state.licenses.find(item => item.id === state.editingId);
        if (lic) Object.assign(lic, {
          product: payload.product, serial: payload.serial, notes: payload.notes,
          assignedUserId: payload.assignedUserId, expiresOn: payload.expiresOn,
          status: payload.status
        });
        addAudit('license_updated', state.editingId);
      } else {
        const result = await HTAuth.call('/api/admin/licenses', payload);
        if (!result.id) throw Error('Creazione licenza non confermata dal server.');
        state.licenses.unshift({
          ...payload, id: result.id, status: 'active',
          createdAt: Math.floor(Date.now() / 1000)
        });
        addAudit('license_created', result.id);
      }
      resetLicense();
      refreshLocalTables();
    }, true);
  });
  start();
})();