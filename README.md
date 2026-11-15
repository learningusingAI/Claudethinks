# Claudethinks

Jurnal pikiran sederhana berbasis web: tulis catatan, beri tag, cari, lalu ekspor/impor sebagai JSON.
Dibuat dengan HTML, CSS, dan JavaScript murni — tanpa build step dan tanpa dependensi.

## Menjalankan

Pilih salah satu:

- Buka `index.html` langsung di browser, atau
- Jalankan server lokal dari folder repo:

  ```sh
  python3 -m http.server 8000
  # lalu buka http://localhost:8000
  ```

## Fitur

- Tambah, ubah, dan hapus catatan (judul opsional, isi, tag)
- Pencarian teks penuh dengan sorotan hasil
- Filter berdasarkan tag dan beberapa pilihan urutan
- Ekspor/impor semua catatan sebagai file JSON (impor melewati catatan yang sudah ada)
- Tema terang/gelap (mengikuti sistem, bisa diganti manual)
- `Ctrl`/`Cmd` + `Enter` untuk menyimpan
- Sinkron manual ke file JSON di repo GitHub **private** (lihat di bawah)
- Tab **Trading**: asisten proses trading saham (bukan sinyal beli/jual)
- Tab **Game Retro** dengan tiga game: Ular, Bata, dan Balok

## Asisten Trading

Tab **Trading** (`trading.html`) mengadaptasi alur kerja dari
[tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills) (MIT)
menjadi alat di browser, tanpa API berbayar dan tanpa server. Tujuannya menstrukturkan proses,
bukan memberi sinyal beli/jual — keputusan tetap di tanganmu.

| Langkah | Diadaptasi dari | Isi |
|---|---|---|
| **1 · Pasar** | exposure-coach | Isi pengamatan indeks (rezim, distribution day, breadth, uptrend). Keluar: plafon eksposur dan postur `Entri baru diizinkan` / `Hanya kurangi` / `Prioritaskan kas`, plus tingkat keyakinan. |
| **2 · Analisis** | vcp-screener, canslim-screener | Unggah CSV harga harian → grafik candlestick + MA50/150/200, Trend Template Minervini (7 kriteria), deteksi kontraksi VCP, pivot, stop, volume dry-up, status eksekusi. RS dihitung bila CSV indeks acuan diunggah. Cek CANSLIM diisi manual. |
| **3 · Ukuran** | position-sizer | Risiko tetap, ATR, atau setengah Kelly dari statistik jurnal. Dibulatkan ke lot (default 100 lembar), dibatasi ukuran posisi maksimum, termasuk perkiraan biaya. |
| **4 · Gerbang** | pre-trade-discipline-gate, drawdown-circuit-breaker | GO / NO GO / PERLU DITINJAU berdasarkan checklist rencana, risiko aktual vs rencana, postur pasar hari ini, batas rugi harian/mingguan/bulanan, rugi beruntun, dan trade rugi hari ini. |
| **5 · Jurnal** | trader-memory-core | Catat trade, P&L bersih biaya, R-multiple, win rate, ekspektansi, profit factor, kepatuhan rencana, dan risiko terbuka. Ekspor/impor JSON. |

Penyederhanaan yang perlu diketahui:

- Skor risiko puncak dari jumlah distribution day adalah pemetaan sederhana, bukan rumus asli market-top-detector.
- Deteksi swing VCP otomatis bisa berbeda dari penilaian mata; selalu cocokkan dengan grafik.
- Tanggal keluar tanpa jam, jadi jeda 24 jam setelah rugi beruntun berlaku sampai akhir hari berikutnya.
- Biaya default (beli 0,15%, jual 0,25%) adalah perkiraan umum broker BEI; sesuaikan di Setelan.

Data trading hanya ada di `localStorage` browser ini dan **tidak ikut** fitur Sinkron GitHub.

## Game Retro

Tab **Game Retro** (`games.html`) berisi tiga game bergaya retro yang dibuat khusus untuk situs ini
(bukan emulator dan tanpa ROM):

| Game | Kontrol keyboard |
|---|---|
| **Ular** — makan kotak merah, jangan tabrak dinding atau badan sendiri | Panah / WASD |
| **Bata** — pecahkan semua bata dengan bola | ←/→ atau geser mouse, Spasi untuk melepas bola |
| **Balok** — susun balok jatuh sampai satu baris penuh | ←/→ geser, ↑ putar, ↓ turun cepat, Spasi jatuhkan |

Enter memulai/menjeda, P atau Esc menjeda. Di layar sentuh muncul tombol arah dan tombol aksi (●);
ketuk layar game untuk mulai. Game otomatis dijeda saat tab disembunyikan. Skor tertinggi per game
disimpan di `localStorage` browser ini dan tidak ikut disinkron.

## Penyimpanan data

Catatan disimpan di `localStorage` browser yang kamu pakai:

- Tidak tersinkron antar perangkat atau browser, kecuali kamu memakai fitur Sinkron di bawah.
- Tidak terenkripsi — jangan simpan data sensitif (keuangan, data pribadi, dsb.).
- Bisa hilang jika data situs dihapus. Gunakan **Ekspor** untuk cadangan.

## Sinkron ke GitHub

Catatan bisa disinkronkan antar perangkat lewat file `notes.json` di repo private milikmu.
Browser langsung memanggil GitHub API; tidak ada server perantara.

1. Buat repo **private** baru yang kosong, mis. `claudethinks-data`.
2. Buat [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   - *Repository access*: **Only select repositories** → pilih repo data tadi saja.
   - *Permissions* → *Repository permissions* → **Contents: Read and write**.
   - Beri masa berlaku (mis. 90 hari).
3. Di aplikasi, klik **Atur**, isi pemilik repo, nama repo, dan token, lalu **Simpan**.
4. Klik **Sinkron** setiap kali ingin menarik dan mengirim perubahan.

Cara kerja dan batasannya:

- Sinkron menggabungkan catatan per ID; versi yang paling baru diubah yang menang.
  Catatan yang dihapus dicatat sebagai *tombstone* agar tidak muncul lagi dari perangkat lain.
- Setiap sinkron yang mengubah data membuat satu commit. **Riwayat git menyimpan semua versi**,
  termasuk catatan yang sudah dihapus.
- Aplikasi menolak sinkron jika repo tujuan ternyata public.
- Token tanpa centang "Ingat token" hanya ada selama tab terbuka (sessionStorage).
  Dengan centang, token tersimpan tanpa enkripsi di localStorage — jangan lakukan di perangkat bersama.
- Token tidak pernah masuk ke repo atau ke kode; ia hanya dikirim ke `api.github.com`.

## Deploy ke GitHub Pages

Settings → Pages → Source: *Deploy from a branch* → branch `main`, folder `/ (root)`.
