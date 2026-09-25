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

## Penyimpanan data

Catatan disimpan di `localStorage` browser yang kamu pakai:

- Tidak tersinkron antar perangkat atau browser.
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
