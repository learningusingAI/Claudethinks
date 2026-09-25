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

## Penyimpanan data

Catatan disimpan di `localStorage` browser yang kamu pakai:

- Tidak tersinkron antar perangkat atau browser.
- Tidak terenkripsi — jangan simpan data sensitif (keuangan, data pribadi, dsb.).
- Bisa hilang jika data situs dihapus. Gunakan **Ekspor** untuk cadangan.

## Deploy ke GitHub Pages

Settings → Pages → Source: *Deploy from a branch* → pilih branch dan folder `/ (root)`.
