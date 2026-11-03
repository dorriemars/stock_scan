# Scanner Nilai Saham IDX

Ketik kode emiten (mis. `BBRI` atau `BBRI, TLKM, ASII`), lalu data fundamental diambil langsung dari Yahoo Finance dan dihitung nilai wajar, margin of safety (+/−), serta harga beli idealnya.

11 metode valuasi: nilai buku (BVPS), PBV historis, Justified PBV, Graham Number, Graham Formula, PER wajar, PER historis, Earnings Power Value, Dividend Discount Model, DCF arus kas bebas, dan EV/EBITDA. Nilai wajar = median metode yang bisa dihitung; status baru diberikan bila jumlah metode valid ≥ "Minimal metode valid" (default 5). Semua asumsi bisa diubah di halaman.

## Struktur

- `app/index.html`: halaman scanner
- `app/api/scan.py`: endpoint `GET /api/scan?code=BBRI` (serverless function di Vercel)
- `server.py`: server lokal untuk halaman + API

## Jalankan lokal

```bash
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r app/requirements.txt
.venv\Scripts\python.exe server.py
```

Atau klik dua kali `jalankan.bat`, lalu buka http://localhost:8765.

## Deploy ke Vercel

Import repo ini di dashboard Vercel dengan **Root Directory = `app`** dan Framework Preset **Other**.

> Data Yahoo Finance bisa terlambat atau keliru. Alat bantu screening, bukan rekomendasi investasi.
