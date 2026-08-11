// operations-common.js — shared helpers for PlateTimer Operations pages.
// Uses the same server-signed session token as the Service side (ws-auth.js).
// All authorization is enforced server-side; UI filtering is convenience only.
//
// I18n support: uses I18n.t() when the I18n global is available (loaded before
// this file via <script src="js/i18n.js">). Falls back to Italian constants.

const OpsCommon = (() => {
    // Legacy constant maps — kept for backward compatibility and as Italian fallbacks.
    const ROLE_LABELS = {
        DIRECTOR: 'Direttore',
        CHEF_CUISINE: 'Chef di Cucina',
        ADJOINT: 'Adjoint',
        SOUS_CHEF: 'Sous Chef',
        CHEF_DE_BRIGADE: 'Chef de Brigade'
    };
    const PRIORITY_LABELS = { LOW: 'Bassa', MEDIUM: 'Media', HIGH: 'Alta', URGENT: 'Urgente' };
    const STATUS_LABELS = {
        OPEN: 'Aperto', IN_PROGRESS: 'In corso', COMPLETED: 'Completato',
        OVERDUE: 'In ritardo', CANCELLED: 'Cancellato'
    };

    const HISTORY_LABELS = {
        TASK_CREATED:    '📝 Compito creato',
        TASK_STARTED:    '▶ Avviato',
        TASK_COMPLETED:  '✅ Completato',
        PROGRESS_CHANGED:'📊 Progresso aggiornato',
        STATUS_CHANGED:  '🔄 Stato cambiato',
        TASK_EDITED:     '✏️ Modificato',
        ASSIGNEE_CHANGED:'👤 Riassegnato',
        PRIORITY_CHANGED:'⚡ Priorità cambiata',
        DUE_DATE_CHANGED:'📅 Scadenza cambiata',
        COMMENT_ADDED:   '💬 Commento aggiunto',
        ATTACHMENT_ADDED:  '📎 Allegato aggiunto',
        ATTACHMENT_DELETED:'🗑 Allegato eliminato'
    };

    // Safe i18n helper — calls I18n.t() when available, otherwise falls back to the
    // Italian constant maps above. Never throws.
    function _t(key, fallback) {
        try {
            if (typeof I18n !== 'undefined' && I18n.t) {
                const v = I18n.t(key);
                if (v !== key) return v;   // translated successfully
            }
        } catch (e) { /* ignore */ }
        return fallback !== undefined ? fallback : key;
    }

    // Return the locale string for date formatting based on the active language.
    function _locale() {
        try {
            if (typeof I18n !== 'undefined' && I18n.getLanguage) {
                const l = I18n.getLanguage();
                if (l === 'fr') return 'fr-FR';
                if (l === 'en') return 'en-GB';
            }
        } catch (e) { /* ignore */ }
        return 'it-IT';
    }

    // Return the current lang for appending to intelligence API calls.
    function langParam() {
        try {
            if (typeof I18n !== 'undefined' && I18n.getLanguage) {
                return '?lang=' + I18n.getLanguage();
            }
        } catch (e) { /* ignore */ }
        return '?lang=it';
    }

    // Build the intelligence endpoint URL, merging extra query params.
    // Usage: intelligenceUrl()           → /api/operations/intelligence?lang=fr
    //        intelligenceUrl('isRealtime=1') → ...&isRealtime=1
    function intelligenceUrl(extra) {
        const base = '/api/operations/intelligence' + langParam();
        return extra ? base + '&' + extra : base;
    }

    function token() {
        const t = WsAuth.getStoredToken();
        if (!t) {
            alert(_t('ops.ui.sessionExpired', 'Sessione scaduta. Effettua nuovamente il login.'));
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
                alert(_t('ops.ui.sessionExpired', 'Sessione scaduta. Effettua nuovamente il login.'));
                window.location.href = 'index.html';
                return null;
            }
            return await res.json();
        } catch (e) {
            return { success: false, error: _t('ops.ui.networkError', 'Errore di rete: ') + e.message };
        }
    }

    async function loadMe() {
        const company = localStorage.getItem('userCompany') || '';
        const el = document.getElementById('hdr-company');
        if (el) el.textContent = company;
        const name = localStorage.getItem('opsDisplayName') || '';
        const data = await api('/api/operations/me' + (name ? `?name=${encodeURIComponent(name)}` : ''));
        if (!data) return null;
        if (!data.success) {
            showError(data.error || _t('ops.ui.accessDenied', 'Accesso a Operations non autorizzato.'));
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
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fmtDue(d) {
        if (!d) return _t('ops.ui.noDeadline', 'Nessuna scadenza');
        const dt = new Date(d);
        if (isNaN(dt)) return d;
        return dt.toLocaleString(_locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function fmtDatetime(ts) {
        if (!ts) return '—';
        const dt = new Date(ts);
        if (isNaN(dt)) return '—';
        return dt.toLocaleString(_locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function fmtDateShort(ts) {
        if (!ts) return '—';
        const dt = new Date(ts);
        if (isNaN(dt)) return '—';
        return dt.toLocaleDateString(_locale(), { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function roleLabel(r) {
        return _t('ops.role.' + r, ROLE_LABELS[r] || r);
    }

    function priorityLabel(p) {
        return _t('ops.priority.' + p, PRIORITY_LABELS[p] || p);
    }

    function statusLabel(s) {
        return _t('ops.status.' + s, STATUS_LABELS[s] || s);
    }

    function historyLabel(type) {
        return _t('ops.history.' + type, HISTORY_LABELS[type] || type);
    }

    // Build assignee <select> options from an array of { id, name, role } user objects.
    function buildAssigneeSelect(selectEl, users, myId) {
        selectEl.innerHTML = '';
        (users || []).forEach(u => {
            const o = document.createElement('option');
            o.value = u.id;
            o.textContent = `${u.name} (${roleLabel(u.role)})${u.id === myId ? _t('ops.ui.myself', ' — io') : ''}`;
            selectEl.appendChild(o);
        });
    }

    // Render history event as readable text
    function historyLine(h) {
        const label = historyLabel(h.type);
        let detail = '';
        if (h.type === 'ASSIGNEE_CHANGED') detail = ` → ${escHtml(h.toName || h.to)}`;
        else if (h.type === 'STATUS_CHANGED') detail = ` → ${escHtml(statusLabel(h.to) || h.to)}`;
        else if (h.type === 'PROGRESS_CHANGED') detail = ` ${h.from}% → ${h.to}%`;
        else if (h.type === 'TASK_EDITED') {
            const parts = [];
            if (h.priorityFrom) parts.push(`${_t('ops.ui.editedPriority','priorità')}: ${escHtml(priorityLabel(h.priorityFrom))} → ${escHtml(priorityLabel(h.priorityTo))}`);
            if (h.dueDateFrom !== undefined) parts.push(_t('ops.ui.editedDeadline','scadenza modificata'));
            if (h.titleChanged) parts.push(_t('ops.ui.editedTitle','titolo'));
            if (h.descriptionChanged) parts.push(_t('ops.ui.editedDescription','descrizione'));
            if (h.notesChanged) parts.push(_t('ops.ui.editedNotes','note'));
            if (h.departmentFrom !== undefined) parts.push(_t('ops.ui.editedDept','reparto'));
            if (parts.length) detail = ': ' + parts.join(', ');
        } else if (h.type === 'COMMENT_ADDED') detail = h.preview ? `: "${escHtml(h.preview)}…"` : '';
        return `${label}${detail}`;
    }

    // Render a list of tasks into `container`.
    // opts.onTaskClick(taskId) — optional callback when a task card is clicked.
    // opts.showComplete — show Complete button (default: true)
    // opts.showStart   — show Start button (default: true)
    function renderTaskList(container, tasks, users, myId, onChange, opts = {}) {
        if (!tasks || tasks.length === 0) {
            container.innerHTML = `<div class="empty-state">${escHtml(_t('ops.ui.noTasks', 'Nessun compito.'))}</div>`;
            return;
        }
        const showComplete = opts.showComplete !== false;
        const showStart = opts.showStart !== false;
        const clickable = !!opts.onTaskClick;
        const completeLabel = _t('ops.ui.completeBtn', '✓ Completa');
        const startLabel    = _t('ops.ui.startBtn',    '▶ Inizia');

        container.innerHTML = tasks.map(t => {
            const st = t.effectiveStatus || t.status;
            const assignee = users[t.assigneeId];
            const pct = t.completionPercent || 0;
            const isOverdue = st === 'OVERDUE';
            const isCompleted = t.status === 'COMPLETED';
            const isCancelled = t.status === 'CANCELLED';
            const isInProgress = t.status === 'IN_PROGRESS';
            const commentCount = Array.isArray(t.comments) ? t.comments.length : 0;

            return `<div class="task-item${isOverdue ? ' overdue' : ''}${isCompleted ? ' completed' : ''}${isCancelled ? ' cancelled' : ''}${isInProgress && !isOverdue ? ' in-progress' : ''}"
                    ${clickable ? `data-taskid="${escHtml(t.id)}" style="cursor:pointer"` : ''}>
              <div class="task-meta">
                <div class="task-title">${escHtml(t.title)}</div>
                <div class="task-sub">
                  ${assignee ? '👤 ' + escHtml(assignee.name) : ''} · 📅 ${escHtml(fmtDue(t.dueDate))}
                  ${t.department ? ' · 🏠 ' + escHtml(t.department) : ''}
                  ${commentCount ? ` · 💬 ${commentCount}` : ''}
                </div>
                ${pct > 0 ? `<div class="task-progress" style="margin-top:6px"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
              </div>
              <span class="badge badge-${t.priority.toLowerCase()}">${escHtml(priorityLabel(t.priority))}</span>
              <span class="badge badge-status-${st.toLowerCase()}">${escHtml(statusLabel(st))}</span>
              ${showComplete && t.assigneeId === myId && t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
                ? `<button class="btn btn-sm btn-ok" data-complete="${escHtml(t.id)}">${escHtml(completeLabel)}</button>` : ''}
              ${showStart && t.assigneeId === myId && t.status === 'OPEN'
                ? `<button class="btn btn-sm btn-neutral" data-start="${escHtml(t.id)}">${escHtml(startLabel)}</button>` : ''}
            </div>`;
        }).join('');

        if (clickable) {
            container.querySelectorAll('[data-taskid]').forEach(el => {
                el.addEventListener('click', e => {
                    if (e.target.closest('[data-complete],[data-start]')) return;
                    opts.onTaskClick(el.dataset.taskid);
                });
            });
        }

        container.querySelectorAll('[data-complete]').forEach(btn => {
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                btn.disabled = true;
                const r = await api(`/api/operations/tasks/${btn.dataset.complete}/complete`, { method: 'POST' });
                if (r && r.success) { if (onChange) onChange(); }
                else { showError(r && r.error); btn.disabled = false; }
            });
        });

        container.querySelectorAll('[data-start]').forEach(btn => {
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                btn.disabled = true;
                const r = await api(`/api/operations/tasks/${btn.dataset.start}/start`, { method: 'POST' });
                if (r && r.success) { if (onChange) onChange(); }
                else { showError(r && r.error); btn.disabled = false; }
            });
        });
    }

    function logout() {
        if (typeof WsAuth !== 'undefined' && WsAuth.clearToken) WsAuth.clearToken();
        window.location.href = 'index.html';
    }

    // Sprint 4: deterministic "next task" selection
    // Priority: URGENT → OVERDUE/effectiveStatus=OVERDUE → due today → oldest OPEN
    function nextTask(tasks, myId) {
        const today = new Date(); today.setHours(23,59,59,999);
        const todayStart = new Date(); todayStart.setHours(0,0,0,0);
        const mine = tasks.filter(t =>
            t.assigneeId === myId &&
            t.status !== 'COMPLETED' && t.status !== 'CANCELLED'
        );
        if (!mine.length) return null;
        function score(t) {
            const eff = t.effectiveStatus || t.status;
            if (t.priority === 'URGENT') return 0;
            if (eff === 'OVERDUE' || (t.dueDate && new Date(t.dueDate) < new Date())) return 1;
            if (t.dueDate) {
                const d = new Date(t.dueDate);
                if (d >= todayStart && d <= today) return 2;
            }
            return 3;
        }
        return mine.sort((a,b) => {
            const sa = score(a), sb = score(b);
            if (sa !== sb) return sa - sb;
            return new Date(a.createdAt) - new Date(b.createdAt);
        })[0];
    }

    // Sprint 4: is a task due today?
    function isToday(dateStr) {
        if (!dateStr) return false;
        const d = new Date(dateStr);
        const now = new Date();
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    }

    // Sprint 4: is task completed today?
    function isCompletedToday(t) {
        return t.status === 'COMPLETED' && (isToday(t.updatedAt) || isToday(t.completedAt));
    }

    // Sprint 4: hour-of-day greeting (translated)
    function greeting() {
        const h = new Date().getHours();
        if (h < 12) return _t('ops.greeting.morning', 'Buongiorno');
        if (h < 18) return _t('ops.greeting.afternoon', 'Buon pomeriggio');
        return _t('ops.greeting.evening', 'Buonasera');
    }

    // Sprint 4: render a compact task card (clickable → operations-tasks.html)
    function taskCard(t, users, opts = {}) {
        const eff = t.effectiveStatus || t.status;
        const isOverdue = eff === 'OVERDUE';
        const isUrgent  = t.priority === 'URGENT';
        const isCompleted = t.status === 'COMPLETED';
        const assignee = users[t.assigneeId];
        const extraClass = isOverdue ? ' overdue-card' : isUrgent ? ' urgent-card' : isCompleted ? ' completed-card' : '';
        const dotColor = isOverdue ? 'var(--danger)' : isUrgent ? 'var(--warn)' : isCompleted ? 'var(--ok)' : 'var(--border-l)';
        return `<div class="task-card${extraClass}" style="cursor:pointer;border-left:3px solid ${dotColor}"
                     onclick="location.href='operations-tasks.html#${escHtml(t.id)}'">
          <div class="task-card-header">
            <div style="flex:1;min-width:0">
              <div class="task-title" style="margin-bottom:3px">${escHtml(t.title)}</div>
              <div style="font-size:12px;color:var(--muted)">
                ${assignee ? '👤 '+escHtml(assignee.name)+' · ' : ''}📅 ${escHtml(fmtDue(t.dueDate))}
                ${t.department ? ' · '+escHtml(t.department) : ''}
                ${t.templateId ? ' · 🔁' : ''}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
              <span class="badge badge-${(t.priority||'medium').toLowerCase()}">${escHtml(priorityLabel(t.priority || 'MEDIUM'))}</span>
              <span class="badge badge-status-${eff.toLowerCase()}">${escHtml(statusLabel(eff))}</span>
            </div>
          </div>
          ${opts.showProgress && t.completionPercent > 0 ? `<div class="task-progress" style="margin-top:8px;height:5px"><div class="progress-fill" style="width:${t.completionPercent}%"></div></div>` : ''}
        </div>`;
    }

    // Sprint 4: render a task list section with title and optional empty state
    function renderSection(container, title, tasks, users, emptyMsg) {
        if (!tasks.length) {
            container.innerHTML += `<p class="section-title-sm">${escHtml(title)}</p><div class="empty-state" style="padding:18px 0;text-align:left;font-size:13px;color:var(--ok)">✅ ${escHtml(emptyMsg)}</div>`;
        } else {
            container.innerHTML += `<p class="section-title-sm">${escHtml(title)}</p>` + tasks.map(t => taskCard(t, users)).join('');
        }
    }

    // Sprint 6.3.1: render "Nuovo dalla tua ultima visita" compact section.
    // sectionId — element to show/hide;  contentId — element to fill.
    // Called from every role dashboard that has an intelligence block.
    function renderNewSinceLastVisit(nsv, sectionId, contentId) {
        const section = sectionId ? document.getElementById(sectionId) : null;
        const content = document.getElementById(contentId);
        if (!content) return;
        if (section && !nsv) { section.style.display = 'none'; return; }
        if (!nsv) { section.style.display = 'none'; return; }

        // Format previous visit timestamp
        function fmtVisit(ts) {
            if (!ts) return _t('ops.ui.firstVisit', 'Prima visita');
            const d = new Date(ts);
            const now = new Date();
            const isToday2 = d.toDateString() === now.toDateString();
            const hhmm = d.toLocaleTimeString(_locale(), { hour: '2-digit', minute: '2-digit' });
            if (isToday2) return `${_t('ops.ui.todayAt', 'oggi alle')} ${hhmm}`;
            const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
            if (d.toDateString() === yesterday.toDateString()) return `${_t('ops.ui.yesterdayAt', 'ieri alle')} ${hhmm}`;
            return d.toLocaleDateString(_locale(), { day: '2-digit', month: '2-digit' }) + ` ${_t('ops.ui.todayAt','alle')} ${hhmm}`;
        }

        const visitLabel = nsv.previousVisitAt
            ? `${_t('ops.ui.lastCheck', 'Ultimo controllo:')} ${fmtVisit(nsv.previousVisitAt)}`
            : _t('ops.ui.firstVisit', 'Prima visita');

        if (section) section.style.display = '';

        if (nsv.newCount === 0) {
            content.innerHTML = `
              <div class="nsv-empty">
                <span class="nsv-visit-label">${escHtml(visitLabel)}</span>
                <span class="nsv-no-new">${escHtml(_t('ops.ui.noNewItems', 'Nessuna nuova criticità dalla tua ultima visita.'))}</span>
              </div>`;
            return;
        }

        const SEV_CLS = { CRITICAL: 'nsv-badge-critical', HIGH: 'nsv-badge-high' };
        const itemsHtml = (nsv.items || []).slice(0, 6).map(it => `
          <div class="nsv-item">
            <span class="nsv-badge ${SEV_CLS[it.severity] || ''}">${escHtml(it.severity)}</span>
            <span class="nsv-item-title">${escHtml(it.title)}</span>
          </div>`).join('');

        content.innerHTML = `
          <div class="nsv-header">
            <span class="nsv-visit-label">${escHtml(visitLabel)}</span>
            <span class="nsv-counts">
              ${nsv.newCritical > 0 ? `<span class="nsv-count-critical">${nsv.newCritical} CRITICAL</span>` : ''}
              ${nsv.newHigh > 0 ? `<span class="nsv-count-high">${nsv.newHigh} HIGH</span>` : ''}
            </span>
          </div>
          <div class="nsv-items">${itemsHtml}</div>`;
    }

    // briefFmt(key, n, cls) — translate an ops.brief.* sentence key and replace
    // {n} with a styled <span class="brief-num {cls}">{n}</span>.
    // Used by director, cc, and adjoint dashboards to render localised narrative.
    function briefFmt(key, n, cls) {
        const span = '<span class="brief-num' + (cls ? ' ' + cls : '') + '">' + n + '</span>';
        return _t(key).replace('{n}', span);
    }

    return {
        api, loadMe, showError, escHtml,
        fmtDue, fmtDatetime, fmtDateShort,
        roleLabel, priorityLabel, statusLabel, historyLabel,
        buildAssigneeSelect, renderTaskList, historyLine,
        logout, ROLE_LABELS, PRIORITY_LABELS, STATUS_LABELS, HISTORY_LABELS,
        nextTask, isToday, isCompletedToday, greeting, taskCard, renderSection,
        renderNewSinceLastVisit,
        langParam, intelligenceUrl,
        briefFmt,
    };
})();
