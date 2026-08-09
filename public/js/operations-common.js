// operations-common.js — shared helpers for PlateTimer Operations pages.
// Uses the same server-signed session token as the Service side (ws-auth.js).
// All authorization is enforced server-side; UI filtering is convenience only.

const OpsCommon = (() => {
    const ROLE_LABELS = {
        DIRECTOR: 'Direttore',
        CHEF_CUISINE: 'Chef di Cucina',
        ADJOINT: 'Adjoint',
        SOUS_CHEF: 'Sous Chef',
        CHEF_DE_BRIGADE: 'Chef de Brigade'
    };
    const PRIORITY_LABELS = { LOW: 'Bassa', MEDIUM: 'Media', HIGH: 'Alta', URGENT: 'Urgente' };
    const STATUS_LABELS = { OPEN: 'Aperto', IN_PROGRESS: 'In corso', COMPLETED: 'Completato', OVERDUE: 'In ritardo' };

    function token() {
        const t = WsAuth.getStoredToken();
        if (!t) {
            alert('Sessione scaduta. Effettua nuovamente il login.');
            window.location.href = 'index.html';
        }
        return t;
    }

    async function api(path, opts = {}) {
        const t = token();
        if (!t) return null;
        try {
            const res = await fetch(path, {
                ...opts,
                headers: { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
            });
            if (res.status === 401) {
                WsAuth.clearToken();
                alert('Sessione scaduta. Effettua nuovamente il login.');
                window.location.href = 'index.html';
                return null;
            }
            return await res.json();
        } catch (e) {
            return { success: false, error: 'Errore di rete: ' + e.message };
        }
    }

    // Load current ops profile (bootstraps first Director server-side).
    // Redirects home with a message if the user is not an Operations member.
    async function loadMe() {
        const company = localStorage.getItem('userCompany') || '';
        const el = document.getElementById('hdr-company');
        if (el) el.textContent = company;
        const name = localStorage.getItem('opsDisplayName') || '';
        const data = await api('/api/operations/me' + (name ? `?name=${encodeURIComponent(name)}` : ''));
        if (!data) return null;
        if (!data.success) {
            showError(data.error || 'Accesso a Operations non autorizzato.');
            return null;
        }
        return data;
    }

    function showError(msg) {
        const el = document.getElementById('ops-error');
        if (el) { el.textContent = msg || 'Errore.'; el.style.display = 'block'; }
        else alert(msg || 'Errore.');
    }

    function escHtml(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fmtDue(d) {
        if (!d) return 'Nessuna scadenza';
        const dt = new Date(d);
        if (isNaN(dt)) return d;
        return dt.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function roleLabel(r) { return ROLE_LABELS[r] || r; }

    // Render a list of tasks into `container`. Adds a "Completa" button when the
    // viewer is the assignee (server still enforces).
    function renderTaskList(container, tasks, users, myId, onChange) {
        if (!tasks || tasks.length === 0) {
            container.innerHTML = '<div class="empty-state">Nessun compito.</div>';
            return;
        }
        container.innerHTML = tasks.map(t => {
            const st = t.effectiveStatus || t.status;
            const assignee = users[t.assigneeId];
            const creator = users[t.createdBy];
            return `
            <div class="task-item ${st === 'OVERDUE' ? 'overdue' : ''} ${t.status === 'COMPLETED' ? 'completed' : ''}">
              <div class="task-meta">
                <div class="task-title">${escHtml(t.title)}</div>
                <div class="task-sub">
                  ${assignee ? '👤 ' + escHtml(assignee.name) : ''} · 📅 ${escHtml(fmtDue(t.dueDate))}
                  ${creator ? ' · da ' + escHtml(creator.name) : ''}
                  ${t.department ? ' · ' + escHtml(t.department) : ''}
                </div>
                ${t.description ? `<div class="task-sub">${escHtml(t.description)}</div>` : ''}
              </div>
              <span class="badge badge-${t.priority.toLowerCase()}">${PRIORITY_LABELS[t.priority] || t.priority}</span>
              <span class="badge badge-status-${st.toLowerCase()}">${STATUS_LABELS[st] || st}</span>
              ${t.assigneeId === myId && t.status !== 'COMPLETED'
                ? `<button class="btn btn-sm btn-ok" data-complete="${escHtml(t.id)}">✓ Completa</button>` : ''}
              ${t.assigneeId === myId && t.status === 'OPEN'
                ? `<button class="btn btn-sm btn-neutral" data-start="${escHtml(t.id)}">▶ Inizia</button>` : ''}
            </div>`;
        }).join('');

        container.querySelectorAll('[data-complete]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                const r = await api(`/api/operations/tasks/${btn.dataset.complete}`, { method: 'PUT', body: JSON.stringify({ status: 'COMPLETED' }) });
                if (r && r.success) { if (onChange) onChange(); }
                else { showError(r && r.error); btn.disabled = false; }
            });
        });
        container.querySelectorAll('[data-start]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                const r = await api(`/api/operations/tasks/${btn.dataset.start}`, { method: 'PUT', body: JSON.stringify({ status: 'IN_PROGRESS' }) });
                if (r && r.success) { if (onChange) onChange(); }
                else { showError(r && r.error); btn.disabled = false; }
            });
        });
    }

    function logout() {
        if (typeof WsAuth !== 'undefined' && WsAuth.clearToken) WsAuth.clearToken();
        window.location.href = 'index.html';
    }

    return { api, loadMe, showError, escHtml, fmtDue, roleLabel, renderTaskList, logout, ROLE_LABELS, PRIORITY_LABELS, STATUS_LABELS };
})();
