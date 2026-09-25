(() => {
  'use strict';

  const STORAGE_KEY = 'claudethinks.notes.v1';
  const DELETED_KEY = 'claudethinks.deleted.v1';
  const SYNC_KEY = 'claudethinks.sync.v1';
  const TOKEN_KEY = 'claudethinks.sync.token';

  const $ = (sel) => document.querySelector(sel);
  const form = $('#note-form');
  const titleInput = $('#note-title');
  const bodyInput = $('#note-body');
  const tagsInput = $('#note-tags');
  const formMode = $('#form-mode');
  const btnCancel = $('#btn-cancel');
  const btnSave = $('#btn-save');
  const searchInput = $('#search');
  const sortSelect = $('#sort');
  const tagBar = $('#tag-bar');
  const list = $('#note-list');
  const countEl = $('#count');
  const emptyEl = $('#empty');

  let notes = load();
  let deleted = loadDeleted(); // id -> deletedAt, so deletions survive a sync merge
  let editingId = null;
  let activeTag = null;

  // --- Storage -------------------------------------------------------------

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(isValidNote) : [];
    } catch {
      return [];
    }
  }

  function loadDeleted() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DELETED_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
      localStorage.setItem(DELETED_KEY, JSON.stringify(deleted));
    } catch {
      alert('Gagal menyimpan ke browser. Ekspor catatanmu agar tidak hilang.');
    }
  }

  function isValidNote(n) {
    return n && typeof n.id === 'string' && typeof n.body === 'string'
      && Array.isArray(n.tags) && typeof n.createdAt === 'number';
  }

  // --- Helpers -------------------------------------------------------------

  function newId() {
    return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  }

  function parseTags(text) {
    const tags = text.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    return [...new Set(tags)];
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  }

  // Appends text to el, wrapping matches of query in <mark>. Uses text nodes only (no innerHTML).
  function appendHighlighted(el, text, query) {
    if (!query) { el.textContent = text; return; }
    const lower = text.toLowerCase();
    let i = 0;
    let hit;
    while ((hit = lower.indexOf(query, i)) !== -1) {
      el.append(text.slice(i, hit));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(hit, hit + query.length);
      el.append(mark);
      i = hit + query.length;
    }
    el.append(text.slice(i));
  }

  // --- Rendering -----------------------------------------------------------

  function visibleNotes() {
    const q = searchInput.value.trim().toLowerCase();
    const filtered = notes.filter((n) => {
      if (activeTag && !n.tags.includes(activeTag)) return false;
      if (!q) return true;
      return (n.title || '').toLowerCase().includes(q)
        || n.body.toLowerCase().includes(q)
        || n.tags.some((t) => t.includes(q));
    });
    const [field, dir] = sortSelect.value.split('-');
    const sign = dir === 'asc' ? 1 : -1;
    return filtered.sort((a, b) => {
      if (field === 'title') return sign * (a.title || a.body).localeCompare(b.title || b.body, 'id');
      const key = field === 'updated' ? 'updatedAt' : 'createdAt';
      return sign * ((a[key] || a.createdAt) - (b[key] || b.createdAt));
    });
  }

  function renderTagBar() {
    const counts = new Map();
    notes.forEach((n) => n.tags.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    if (activeTag && !counts.has(activeTag)) activeTag = null;

    tagBar.replaceChildren();
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).forEach(([tag, n]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag' + (tag === activeTag ? ' active' : '');
      btn.textContent = `#${tag} · ${n}`;
      btn.setAttribute('aria-pressed', String(tag === activeTag));
      btn.addEventListener('click', () => {
        activeTag = activeTag === tag ? null : tag;
        render();
      });
      tagBar.append(btn);
    });
  }

  function renderList() {
    const q = searchInput.value.trim().toLowerCase();
    const shown = visibleNotes();
    list.replaceChildren();

    shown.forEach((n) => {
      const li = document.createElement('li');
      li.className = 'note';

      if (n.title) {
        const h = document.createElement('h2');
        appendHighlighted(h, n.title, q);
        li.append(h);
      }

      const body = document.createElement('p');
      body.className = 'note-body';
      appendHighlighted(body, n.body, q);
      li.append(body);

      const meta = document.createElement('div');
      meta.className = 'note-meta';
      const time = document.createElement('time');
      time.className = 'muted';
      time.dateTime = new Date(n.updatedAt || n.createdAt).toISOString();
      time.textContent = formatDate(n.createdAt) + (n.updatedAt && n.updatedAt !== n.createdAt ? ' (diubah)' : '');
      meta.append(time);

      n.tags.forEach((t) => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = `#${t}`;
        meta.append(span);
      });

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'ghost';
      edit.textContent = 'Ubah';
      edit.addEventListener('click', () => startEdit(n.id));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost danger';
      del.textContent = 'Hapus';
      del.addEventListener('click', () => removeNote(n.id));

      meta.append(edit, del);
      li.append(meta);
      list.append(li);
    });

    emptyEl.hidden = notes.length > 0;
    countEl.textContent = notes.length
      ? `Menampilkan ${shown.length} dari ${notes.length} catatan`
      : '';
  }

  function render() {
    renderTagBar();
    renderList();
  }

  // --- Actions -------------------------------------------------------------

  function resetForm() {
    form.reset();
    editingId = null;
    formMode.textContent = '';
    btnCancel.hidden = true;
    btnSave.textContent = 'Simpan';
  }

  function startEdit(id) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    editingId = id;
    titleInput.value = n.title || '';
    bodyInput.value = n.body;
    tagsInput.value = n.tags.join(', ');
    formMode.textContent = 'Mengubah catatan';
    btnCancel.hidden = false;
    btnSave.textContent = 'Perbarui';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    bodyInput.focus();
  }

  function removeNote(id) {
    if (!confirm('Hapus catatan ini? Tindakan ini tidak bisa dibatalkan.')) return;
    notes = notes.filter((n) => n.id !== id);
    deleted[id] = Date.now();
    if (editingId === id) resetForm();
    save();
    render();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = bodyInput.value.trim();
    if (!body) return;
    const now = Date.now();
    const data = { title: titleInput.value.trim(), body, tags: parseTags(tagsInput.value) };

    if (editingId) {
      notes = notes.map((n) => (n.id === editingId ? { ...n, ...data, updatedAt: now } : n));
    } else {
      notes.unshift({ id: newId(), ...data, createdAt: now, updatedAt: now });
    }
    save();
    resetForm();
    render();
  });

  btnCancel.addEventListener('click', resetForm);
  searchInput.addEventListener('input', renderList);
  sortSelect.addEventListener('change', renderList);

  // Ctrl/Cmd + Enter saves from the textarea.
  bodyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });

  // --- Import / export -----------------------------------------------------

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `claudethinks-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('#input-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      if (!Array.isArray(incoming)) throw new Error('bukan array');
      const valid = incoming.filter(isValidNote);
      const known = new Set([...notes.map((n) => n.id), ...Object.keys(deleted)]);
      const added = valid.filter((n) => !known.has(n.id));
      notes = [...added, ...notes];
      save();
      render();
      alert(`${added.length} catatan diimpor` + (valid.length - added.length ? `, ${valid.length - added.length} dilewati (sudah ada).` : '.'));
    } catch {
      alert('File tidak valid. Gunakan file JSON hasil Ekspor.');
    }
  });

  // --- GitHub sync -------------------------------------------------------

  const syncBar = $('.sync-bar');
  const syncStatus = $('#sync-status');
  const btnSync = $('#btn-sync');
  const syncDialog = $('#sync-dialog');
  const syncForm = $('#sync-form');
  const syncFields = {
    owner: $('#sync-owner'),
    repo: $('#sync-repo'),
    path: $('#sync-path'),
    branch: $('#sync-branch'),
    token: $('#sync-token'),
  };
  const syncRemember = $('#sync-remember');

  function storageGet(store, key) {
    try { return store.getItem(key); } catch { return null; }
  }

  function storageSet(store, key, value) {
    try {
      if (value === null) store.removeItem(key);
      else store.setItem(key, value);
    } catch { /* storage unavailable */ }
  }

  function loadSyncConfig() {
    let cfg = {};
    try { cfg = JSON.parse(storageGet(localStorage, SYNC_KEY) || '{}') || {}; } catch { cfg = {}; }
    cfg.token = storageGet(localStorage, TOKEN_KEY) || storageGet(sessionStorage, TOKEN_KEY) || '';
    cfg.remember = Boolean(storageGet(localStorage, TOKEN_KEY));
    return cfg;
  }

  function isConfigured(cfg) {
    return Boolean(cfg.owner && cfg.repo && cfg.path && cfg.token);
  }

  function setSyncStatus(text, isError = false) {
    syncStatus.textContent = text;
    syncBar.classList.toggle('error', isError);
  }

  function describeSyncState() {
    const cfg = loadSyncConfig();
    if (!cfg.owner || !cfg.repo) return setSyncStatus('Sinkron GitHub belum diatur.');
    if (!cfg.token) return setSyncStatus(`Repo ${cfg.owner}/${cfg.repo} — masukkan token lewat "Atur".`);
    const last = Number(storageGet(localStorage, SYNC_KEY + '.last'));
    setSyncStatus(last
      ? `Terakhir sinkron ${formatDate(last)} · ${cfg.owner}/${cfg.repo}`
      : `Siap sinkron ke ${cfg.owner}/${cfg.repo}`);
  }

  function openSyncDialog() {
    const cfg = loadSyncConfig();
    syncFields.owner.value = cfg.owner || '';
    syncFields.repo.value = cfg.repo || '';
    syncFields.path.value = cfg.path || 'notes.json';
    syncFields.branch.value = cfg.branch || '';
    syncFields.token.value = cfg.token || '';
    syncRemember.checked = cfg.remember;
    syncDialog.showModal();
  }

  syncForm.addEventListener('submit', () => {
    const cfg = {
      owner: syncFields.owner.value.trim(),
      repo: syncFields.repo.value.trim(),
      path: syncFields.path.value.trim().replace(/^\/+/, '') || 'notes.json',
      branch: syncFields.branch.value.trim(),
    };
    const token = syncFields.token.value.trim();
    storageSet(localStorage, SYNC_KEY, JSON.stringify(cfg));
    storageSet(localStorage, TOKEN_KEY, syncRemember.checked && token ? token : null);
    storageSet(sessionStorage, TOKEN_KEY, !syncRemember.checked && token ? token : null);
    describeSyncState();
  });

  $('#btn-sync-close').addEventListener('click', () => syncDialog.close());

  $('#btn-sync-forget').addEventListener('click', () => {
    if (!confirm('Hapus pengaturan sinkron dan token dari perangkat ini? Catatan tidak ikut terhapus.')) return;
    [SYNC_KEY, SYNC_KEY + '.last', TOKEN_KEY].forEach((k) => storageSet(localStorage, k, null));
    storageSet(sessionStorage, TOKEN_KEY, null);
    syncDialog.close();
    describeSyncState();
  });

  $('#btn-sync-settings').addEventListener('click', openSyncDialog);

  btnSync.addEventListener('click', async () => {
    const cfg = loadSyncConfig();
    if (!isConfigured(cfg)) { openSyncDialog(); return; }

    btnSync.disabled = true;
    setSyncStatus('Menyinkronkan…');
    try {
      const { data, pushed } = await window.ClaudethinksSync.syncNotes(cfg, { notes, deleted });
      notes = data.notes.filter(isValidNote);
      deleted = data.deleted;
      if (editingId && !notes.some((n) => n.id === editingId)) resetForm();
      save();
      storageSet(localStorage, SYNC_KEY + '.last', String(Date.now()));
      render();
      describeSyncState();
      if (!pushed) setSyncStatus(syncStatus.textContent + ' · sudah sama');
    } catch (err) {
      const known = err instanceof window.ClaudethinksSync.SyncError;
      setSyncStatus(known ? err.message : 'Sinkron gagal karena kesalahan tak terduga.', true);
      if (!known) console.error(err);
    } finally {
      btnSync.disabled = false;
    }
  });

  describeSyncState();

  render();
})();
