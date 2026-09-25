// Sync notes to a JSON file in a private GitHub repository via the REST contents API.
// Exposes window.ClaudethinksSync = { mergeData, syncNotes, SyncError }.
(() => {
  'use strict';

  const API = 'https://api.github.com';
  const FILE_VERSION = 1;

  class SyncError extends Error {}

  // --- Merge ---------------------------------------------------------------

  function stamp(note) {
    return note.updatedAt || note.createdAt || 0;
  }

  // Normalizes a file payload (current object format or a bare exported array).
  function normalize(data) {
    if (Array.isArray(data)) return { notes: data, deleted: {} };
    if (data && Array.isArray(data.notes)) {
      return { notes: data.notes, deleted: data.deleted && typeof data.deleted === 'object' ? data.deleted : {} };
    }
    return { notes: [], deleted: {} };
  }

  // Union of both sides: per id the newest version wins; a deletion wins over
  // any version that is not newer than the deletion itself.
  function mergeData(local, remote) {
    const a = normalize(local);
    const b = normalize(remote);

    const deleted = { ...a.deleted };
    Object.entries(b.deleted).forEach(([id, ts]) => {
      if (typeof ts === 'number' && !(deleted[id] >= ts)) deleted[id] = ts;
    });

    const byId = new Map();
    [...a.notes, ...b.notes].forEach((n) => {
      if (!n || typeof n.id !== 'string') return;
      const prev = byId.get(n.id);
      if (!prev || stamp(n) > stamp(prev)) byId.set(n.id, n);
    });

    const notes = [...byId.values()].filter((n) => !(deleted[n.id] >= stamp(n)));
    notes.sort((x, y) => stamp(y) - stamp(x));
    return { notes, deleted };
  }

  // --- Encoding (UTF-8 safe base64) ----------------------------------------

  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  function fromBase64(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // --- GitHub API ----------------------------------------------------------

  async function gh(cfg, path, options = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        ...options,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${cfg.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      });
    } catch {
      throw new SyncError('Tidak bisa menghubungi GitHub. Periksa koneksi internet.');
    }
    if (res.status === 401) throw new SyncError('Token ditolak GitHub (salah atau kedaluwarsa).');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new SyncError('Batas permintaan GitHub habis. Coba lagi nanti.');
    }
    return res;
  }

  function repoPath(cfg) {
    return `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  }

  function filePath(cfg) {
    return `${repoPath(cfg)}/contents/${cfg.path.split('/').map(encodeURIComponent).join('/')}`;
  }

  async function checkRepo(cfg) {
    const res = await gh(cfg, repoPath(cfg));
    if (res.status === 404) {
      throw new SyncError(`Repo ${cfg.owner}/${cfg.repo} tidak ditemukan, atau token tidak punya akses ke repo itu.`);
    }
    if (!res.ok) throw new SyncError(`GitHub mengembalikan status ${res.status} saat memeriksa repo.`);
    const repo = await res.json();
    // Refuse to write notes into a repository anyone can read.
    if (!repo.private) {
      throw new SyncError(`Repo ${cfg.owner}/${cfg.repo} bersifat PUBLIC. Sinkron dibatalkan agar catatanmu tidak terbuka untuk umum.`);
    }
  }

  // Returns { data, sha } — data is null when the file does not exist yet.
  async function readRemote(cfg) {
    const ref = cfg.branch ? `?ref=${encodeURIComponent(cfg.branch)}` : '';
    const res = await gh(cfg, filePath(cfg) + ref);
    if (res.status === 404) return { data: null, sha: null };
    if (!res.ok) throw new SyncError(`Gagal membaca ${cfg.path} (status ${res.status}).`);
    const meta = await res.json();
    if (Array.isArray(meta) || meta.type !== 'file') throw new SyncError(`${cfg.path} di repo bukan file.`);

    let text;
    if (meta.encoding === 'base64' && meta.content) {
      text = fromBase64(meta.content);
    } else {
      // Files over 1 MB come without inline content; fetch the raw body instead.
      const raw = await gh(cfg, filePath(cfg) + ref, { headers: { Accept: 'application/vnd.github.raw' } });
      if (!raw.ok) throw new SyncError(`Gagal membaca ${cfg.path} (status ${raw.status}).`);
      text = await raw.text();
    }
    try {
      return { data: text.trim() ? JSON.parse(text) : null, sha: meta.sha };
    } catch {
      throw new SyncError(`${cfg.path} di repo bukan JSON yang valid. Perbaiki atau hapus file itu dulu.`);
    }
  }

  async function writeRemote(cfg, data, sha) {
    const body = {
      message: `Sinkron catatan ${new Date().toISOString()}`,
      content: toBase64(JSON.stringify({ version: FILE_VERSION, ...data }, null, 2) + '\n'),
    };
    if (sha) body.sha = sha;
    if (cfg.branch) body.branch = cfg.branch;
    const res = await gh(cfg, filePath(cfg), { method: 'PUT', body: JSON.stringify(body) });
    if (res.status === 409 || (res.status === 422 && sha)) return false; // remote changed meanwhile
    if (res.status === 403 || res.status === 404) {
      throw new SyncError('Token tidak punya izin menulis. Pastikan permission "Contents: Read and write".');
    }
    if (!res.ok) throw new SyncError(`Gagal menyimpan ke GitHub (status ${res.status}).`);
    return true;
  }

  function sameData(x, y) {
    return JSON.stringify(normalize(x)) === JSON.stringify(normalize(y));
  }

  // Pulls remote, merges with local, pushes the result if it differs.
  // Returns { data, pushed } where data is the merged { notes, deleted }.
  async function syncNotes(cfg, local) {
    if (!cfg || !cfg.owner || !cfg.repo || !cfg.path || !cfg.token) {
      throw new SyncError('Pengaturan sinkron belum lengkap.');
    }
    await checkRepo(cfg);

    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await readRemote(cfg);
      const merged = mergeData(local, remote.data);
      if (remote.data && sameData(merged, remote.data)) return { data: merged, pushed: false };
      if (await writeRemote(cfg, merged, remote.sha)) return { data: merged, pushed: true };
    }
    throw new SyncError('File di GitHub terus berubah saat disinkron. Coba lagi sebentar lagi.');
  }

  window.ClaudethinksSync = { mergeData, syncNotes, SyncError };
})();
