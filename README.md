# Scanner Nilai Saham IDX

Ketik kode emiten (mis. `BBRI` atau `BBRI, TLKM, ASII`), lalu data fundamental diambil langsung dari Yahoo Finance dan dihitung nilai wajar, margin of safety (+/−), serta harga beli idealnya.

11 metode valuasi: nilai buku (BVPS), PBV historis, Justified PBV, Graham Number, Graham Formula, PER wajar, PER historis, Earnings Power Value, Dividend Discount Model, DCF arus kas bebas, dan EV/EBITDA. Nilai wajar = median metode yang bisa dihitung; status baru diberikan bila jumlah metode valid ≥ "Minimal metode valid" (default 5). Semua asumsi bisa diubah di halaman.

## Dua versi tampilan

Tombol **Lite / Pro** di pojok kanan atas berpindah antara keduanya, di sebelah tombol tema (ikut perangkat → terang → gelap, tersimpan dan berlaku di kedua versi).

- **Pro** (`index.html`): semua menu, tabel lengkap, 11 metode, dan asumsi yang bisa diubah.
- **Lite** (`lite.html`): untuk orang awam. Satu kotak cari dengan hasil satu kartu (murah / agak murah / wajar / mahal, harga sekarang, perkiraan harga wajar, posisi harga di antara perkiraan terendah–tertinggi, tiga rasio dalam bahasa sehari-hari, catatan peringatan, dan penjelasan "Apa artinya angka-angka ini?"), plus daftar **Lagi murah** berisi 10 saham dengan selisih terbesar di bawah perkiraan wajar dari gabungan LQ45 + JII.

Keduanya memakai `app/public/engine.js` yang sama, jadi angkanya tidak bisa berbeda, dan hasil scan di satu versi langsung tersedia di versi lain.

## Menu (versi Pro)

- **Home**: scan kode emiten, kartu ringkasan menu, dan riwayat scan.
- **Top 20 LQ45** / **Top 20 Syariah (JII)**: 20 konstituen teratas menurut kapitalisasi pasar (bisa diganti ke MoS terbesar).
- **Top 20 MoS**: 20 saham dengan margin of safety terbesar dari gabungan LQ45 + JII; emiten rugi dan yang metodenya kurang dikecualikan secara bawaan.
- Kolom **Lap. keuangan** menandai periode laporan keuangan terakhir di data Yahoo (`mostRecentQuarter`) dan apakah sudah sesuai laporan terbaru yang batas tercepat publikasinya (Peraturan Bursa I-E dan POJK 14/2022) sudah lewat, dihitung dari bulan akhir tahun buku tiap emiten.

## Kualitas data

Data Yahoo kadang keliru, jadi API memeriksanya dulu:

- **Nilai buku (BVPS)**: `bookValue` dicocokkan dengan ekuitas per kuartal terakhir menurut Yahoo sendiri (total utang ÷ DER, dikurangi kepentingan nonpengendali) dibagi jumlah saham sekarang. Bila tidak cocok (salah satuan, keliru, terbulatkan ke 0,001 USD, atau masih memakai jumlah saham sebelum IPO / pemecahan saham), BVPS diambil dari neraca kuartal yang sama atau dihitung dari ekuitas itu (`bvSource` = tanggal neraca). Tanpa DER (bank, emiten tanpa utang) pembandingnya neraca tahunan / kuartal.
- **Pemecahan saham**: harga Yahoo sudah disesuaikan, tetapi jumlah saham & EPS di laporan kadang belum; PBV/PER historis dan BVPS menyesuaikannya.
- **Jumlah saham**: dari `impliedSharesOutstanding` / kapitalisasi pasar, bukan `sharesOutstanding` yang kadang salah.
- **EPS**: bila PER kosong, dari laba bersih 12 bulan ÷ jumlah saham.
- **Gangguan Yahoo**: rate limit → HTTP 429, gangguan sementara → 502 (keduanya dicoba ulang halaman); data yang sebagian gagal diambil ditandai `partial`, tidak di-cache, dan dipindai ulang setelah 10 menit. Emiten yang memang belum punya laporan keuangan di Yahoo (mis. baru IPO) tidak dianggap gagal. Kode dinyatakan tidak ditemukan (404) hanya bila Yahoo memastikannya.

Daftar konstituen ada di konstanta `INDEXES` di `app/public/engine.js` (beserta periode, sumber, dan tanggal berakhir `until`; setelah tanggal itu halaman menampilkan peringatan). Perbarui tiap pergantian periode: LQ45 dievaluasi tiap 3 bulan (berlaku awal Februari, Mei, Agustus, November); JII tiap 6 bulan mengikuti Daftar Efek Syariah OJK (berlaku awal Juni & Desember).

## Struktur

- `app/public/engine.js`: mesin bersama kedua halaman — `INDEXES`, metode valuasi, `value()`, penyimpanan hasil scan di localStorage, antrean permintaan ke API, status laporan keuangan, dan tema. **Semua perubahan perhitungan dilakukan di sini**, supaya versi Lite dan Pro tidak pernah berbeda angkanya.
- `app/public/ui.css`: **sistem desain bersama** — token warna tema terang/gelap, token sudut/jarak/huruf, dan
  komponen dasar yang dipakai kedua halaman (reset, panel, tombol, kolom isian, kotak cari, chip, pil status,
  bilah atas dengan tombol Lite/Pro + tombol tema, pita informasi, bar progres, cincin fokus). **Perubahan
  tampilan yang berlaku di kedua versi dilakukan di sini**; `<style>` di tiap halaman hanya untuk yang khas
  halaman itu. Dua pasang token yang mudah tertukar: `--line` garis rambut dekoratif vs `--line-2` batas yang
  wajib terlihat (≥ 3:1) untuk setiap kontrol, dan `--accent` hanya untuk yang bisa ditekan vs `--good` untuk
  angka dan label yang dibaca.
- `app/public/index.html`: halaman versi Pro
- `app/public/lite.html`: halaman versi Lite
- `app/api/scan.py`: endpoint `GET /api/scan?code=BBRI`; di Vercel menjadi entrypoint Python (`app/pyproject.toml`)
- `server.py`: server lokal untuk halaman + API

## Jalankan lokal

```bash
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r app/requirements.txt
.venv\Scripts\python.exe server.py
```

Atau klik dua kali `jalankan.bat`, lalu buka http://localhost:8765.

## Deploy ke Vercel

Import repo ini di dashboard Vercel dengan **Root Directory = `app`** dan Framework Preset **Other**. Push ke `main` memicu deploy.

Keempat berkas di `app/public/` (`engine.js`, `ui.css`, `index.html`, `lite.html`) saling bergantung dan harus ikut
ter-commit bersama: tanpa `engine.js` kedua halaman tetap tergambar tapi semua tombolnya mati. Jadi pakai `git add` /
`git status --short` sebelum commit, bukan `git commit -am` yang melewatkan berkas baru.

> Data Yahoo Finance bisa terlambat atau keliru. Alat bantu screening, bukan rekomendasi investasi.
