/* Mesin bersama versi Pro (index.html) dan versi Lite (lite.html).
 *
 * Isinya semua yang harus sama persis di kedua halaman: daftar konstituen indeks, metode valuasi, penyimpanan data
 * hasil scan, antrean permintaan ke /api/scan, status laporan keuangan, dan tema terang/gelap. Lapisan tampilan
 * (render tabel, rincian, menu) tetap di masing-masing halaman.
 *
 * Dimuat sebagai skrip biasa (bukan module) sebelum skrip halaman, jadi semua nama di sini bisa langsung dipakai.
 * Halaman wajib memanggil loadStore() sekali saat mulai, dan boleh mengganti onScan dengan fungsi render-nya.
 */

const API = "api/scan";

// ===== Daftar konstituen indeks =====
// Perbarui setiap pergantian periode (halaman menampilkan peringatan setelah tanggal `until` lewat):
// - LQ45: dievaluasi BEI tiap 3 bulan, berlaku awal Februari, Mei, Agustus, dan November.
// - JII: evaluasi mayor tiap 6 bulan mengikuti Daftar Efek Syariah OJK, berlaku awal Juni dan Desember.
const INDEXES = {
  lq45: {name:"LQ45", period:"2 Nov 2026 – 29 Jan 2027", until:"2027-01-29",
    source:"Pengumuman BEI Peng-00204 & Peng-00205/BEI.POP/10-2026",
    url:"https://pusatdata.kontan.co.id/news/ini-daftar-lengkap-saham-baru-lq45-untuk-periode-2-november-2026-29-januari-2027",
    codes:["AADI","ADMR","ADRO","AKRA","AMMN","AMRT","ANTM","ASII","BBCA","BBNI","BBRI","BBTN","BMRI","BRPT","BUMI",
           "CPIN","DEWA","ELSA","EMTK","ESSA","EXCL","GOTO","HRTA","ICBP","INCO","INDF","INDY","INKP","ISAT","ITMG",
           "JPFA","KLBF","MAPI","MBMA","MDKA","MEDC","NCKL","PGAS","PGEO","PTBA","SMGR","TLKM","UNTR","UNVR","WIFI"]},
  jii:  {name:"Jakarta Islamic Index (JII)", period:"2 Jun – 30 Nov 2026", until:"2026-11-30",
    source:"Pengumuman BEI Peng-00089/BEI.POP/05-2026",
    url:"https://stockwatch.id/?p=68316",
    codes:["AADI","ADMR","ADRO","ANTM","ARCI","BKSL","BRIS","BRMS","BUMI","CPIN","DEWA","ENRG","EXCL","ICBP","INDF",
           "INKP","JPFA","KLBF","MBMA","MDKA","MEDC","PGAS","PTBA","RAJA","RATU","TLKM","TPIA","UNTR","UNVR","WIFI"]},
};
const indexExpired = idx => new Date() > new Date(INDEXES[idx].until+"T23:59:59+07:00");
const isIndexCode = c => INDEXES.lq45.codes.includes(c) || INDEXES.jii.codes.includes(c);

const LISTS = {
  lq45:    {title:"Top 20 LQ45", index:"lq45", ranks:["mcap","mos"]},
  syariah: {title:"Top 20 Syariah", index:"jii", ranks:["mcap","mos"]},
  mos:     {title:"Top 20 MoS", index:null, ranks:["mos"]},
};
function listCodes(key){
  const idx = LISTS[key].index;
  return idx ? INDEXES[idx].codes : [...new Set([...INDEXES.lq45.codes, ...INDEXES.jii.codes])];
}

const TOP_N = 20;
const STALE_MS = 3*60*60*1000;   // data menu yang lebih tua dari ini dipindai ulang otomatis
const PARTIAL_STALE_MS = 10*60*1000;   // data yang sebagian gagal diambil dipindai ulang lebih cepat
const MAX_PARALLEL = 4;          // permintaan scan bersamaan (ramah rate limit Yahoo)
const MAX_CODES = 30;            // kode per sekali ketik di Home

// group, formula, what (arti), fit (cocok untuk), limit (keterbatasan) dipakai di bagian "Penjelasan metode".
const METHODS = [
  {id:"bv", ab:"BV", group:"Aset", name:"Nilai buku (BVPS)", desc:"Ekuitas per saham. PBV < 1 berarti harga di bawah nilai buku.",
   formula:"Total ekuitas ÷ jumlah saham beredar",
   what:"Nilai aset bersih per saham menurut neraca. Kira-kira inilah bagian tiap saham bila semua aset dijual sesuai nilai bukunya dan seluruh utang dilunasi. Harga di bawah nilai buku (PBV < 1) sering dianggap \"diskon\".",
   fit:"Bank, properti, dan emiten padat aset; mengecek apakah harga sudah di bawah harga buku.",
   limit:"Tidak memperhitungkan kemampuan menghasilkan laba. Nilai aset di neraca bisa berbeda jauh dari nilai pasarnya. Emiten aset ringan (konsumer, teknologi) wajar diperdagangkan jauh di atas nilai buku, jadi metode ini membuatnya selalu terlihat mahal."},
  {id:"pbvh", ab:"PBVh", group:"Aset", name:"PBV historis", desc:"Rata-rata PBV 4 tahun buku terakhir × BVPS sekarang.",
   formula:"Rata-rata PBV 4 tahun buku terakhir × BVPS sekarang",
   what:"Harga saham bila pasar menilainya seperti rata-rata beberapa tahun terakhir (pendekatan \"PBV band\"). PBV tiap tahun = harga rata-rata 12 bulan ÷ nilai buku akhir tahun buku.",
   fit:"Emiten yang bisnisnya stabil, terutama bank dan emiten berbasis aset.",
   limit:"Kalau pasar dulu terlalu optimistis atau pesimistis, hasilnya ikut bias. Kurang relevan bila bisnis sudah berubah (merger, spin-off, perubahan model bisnis). Hanya 4 titik data."},
  {id:"pbv", ab:"JPBV", group:"Aset", name:"Justified PBV", desc:"BVPS × (ROE − g) ÷ (r − g). Cocok untuk bank & emiten aset berat.",
   formula:"BVPS × (ROE − g) ÷ (r − g)",
   what:"PBV yang pantas ditentukan oleh seberapa besar ROE melebihi return yang diminta investor (r). Jika ROE > r, saham layak dihargai di atas nilai buku; jika ROE < r, layak di bawahnya.",
   fit:"Bank dan perusahaan dengan ROE stabil dari tahun ke tahun.",
   limit:"Sangat sensitif terhadap asumsi r dan g. ROE satu tahun bisa tidak mewakili (laba sekali waktu, siklus komoditas)."},
  {id:"gn", ab:"GN", group:"Laba", name:"Graham Number", desc:"√(22,5 × EPS × BVPS): batas atas harga wajar ala Benjamin Graham (PER 15 × PBV 1,5).",
   formula:"√(22,5 × EPS × BVPS)",
   what:"Batas atas harga untuk investor defensif menurut Benjamin Graham: PER tidak lebih dari 15 dan PBV tidak lebih dari 1,5 (15 × 1,5 = 22,5). Menggabungkan laba dan nilai buku dalam satu angka.",
   fit:"Saham dengan laba stabil; gaya value investing konservatif.",
   limit:"Mengabaikan pertumbuhan, sehingga terlalu ketat untuk emiten ROE tinggi. Tidak bisa dihitung untuk emiten yang rugi atau ekuitasnya negatif."},
  {id:"gf", ab:"GF", group:"Laba", name:"Graham Formula", desc:"EPS × (8,5 + 2 × pertumbuhan 5 thn) × 4,4 ÷ yield SBN 10 thn.",
   formula:"EPS × (8,5 + 2 × pertumbuhan 5 thn) × 4,4 ÷ yield SBN 10 thn",
   what:"Rumus revisi Graham: PER 8,5 untuk perusahaan tanpa pertumbuhan, ditambah 2 × tingkat pertumbuhan (dalam %), lalu disesuaikan dengan imbal hasil obligasi (4,4% pada zaman Graham dibanding yield SBN sekarang).",
   fit:"Perusahaan yang labanya tumbuh cukup stabil.",
   limit:"Hasil cenderung tinggi bila asumsi pertumbuhan besar; angka pertumbuhan 5 tahun sangat menentukan. Tidak untuk emiten rugi."},
  {id:"per", ab:"PER", group:"Laba", name:"PER wajar", desc:"EPS × PER wajar.",
   formula:"EPS × PER wajar",
   what:"Harga bila pasar membayar kelipatan laba yang dianggap normal. PER wajar bisa disesuaikan dengan rata-rata sektor atau pasar.",
   fit:"Perusahaan dengan laba stabil; cepat untuk perbandingan antar-emiten satu sektor.",
   limit:"Angka PER wajar bersifat subjektif dan berbeda antar-sektor. Laba satu tahun bisa melonjak atau anjlok karena faktor sekali waktu."},
  {id:"perh", ab:"PERh", group:"Laba", name:"PER historis", desc:"Rata-rata PER 4 tahun buku terakhir × EPS sekarang.",
   formula:"Rata-rata PER 4 tahun buku terakhir × EPS sekarang",
   what:"Harga bila pasar menilai laba saham ini seperti rata-rata beberapa tahun terakhir. PER tiap tahun = harga rata-rata 12 bulan ÷ EPS tahun buku tersebut.",
   fit:"Emiten dengan laba yang tumbuh stabil (konsumer, telko, bank).",
   limit:"Menyesatkan untuk emiten siklikal (batu bara, nikel): saat laba puncak PER rendah, saat laba anjlok PER tinggi. Tahun rugi tidak dihitung. Hanya 4 titik data."},
  {id:"epv", ab:"EPV", group:"Laba", name:"Earnings Power Value", desc:"EPS ÷ r: nilai bila laba tidak tumbuh sama sekali (konservatif).",
   formula:"EPS ÷ r",
   what:"Nilai perusahaan jika laba sekarang bertahan selamanya tanpa tumbuh (konsep Bruce Greenwald). Selisih harga dengan EPV menunjukkan berapa banyak pertumbuhan yang sudah \"dihargai\" pasar.",
   fit:"Patokan konservatif untuk semua emiten yang labanya positif.",
   limit:"Mengabaikan pertumbuhan, jadi cenderung rendah untuk emiten bertumbuh. Memakai laba akuntansi apa adanya, bukan laba rata-rata yang dinormalkan."},
  {id:"ddm", ab:"DDM", group:"Dividen", name:"Dividend Discount", desc:"DPS × (1 + g) ÷ (r − g). Hanya untuk emiten yang membagi dividen.",
   formula:"DPS × (1 + g) ÷ (r − g)",
   what:"Model Gordon Growth: nilai saham sama dengan nilai sekarang dari semua dividen di masa depan yang tumbuh g per tahun dan didiskonto dengan r. DPS = total dividen 12 bulan terakhir.",
   fit:"Emiten dengan dividen rutin dan stabil (bank, telko, konsumer, BUMN).",
   limit:"Tidak bisa untuk emiten tanpa dividen. Dividen spesial atau interim besar membuat hasil terlalu tinggi. Sangat sensitif bila r dan g berdekatan."},
  {id:"dcf", ab:"DCF", group:"Arus kas", name:"DCF arus kas bebas", desc:"Free cash flow per saham tumbuh 5 thn, lalu tumbuh g selamanya, didiskonto r.",
   formula:"Σ FCF₁…₅ ÷ (1 + r)ᵗ + nilai terminal (FCF₅ × (1 + g) ÷ (r − g)) ÷ (1 + r)⁵",
   what:"Nilai sekarang dari kas yang benar-benar tersisa untuk pemegang saham (free cash flow). FCF per saham tumbuh sesuai \"pertumbuhan 5 thn pertama\", setelah itu tumbuh g selamanya, semuanya didiskonto dengan r.",
   fit:"Perusahaan non-keuangan dengan arus kas positif dan stabil.",
   limit:"Tidak berlaku untuk bank. FCF satu tahun bisa sangat rendah saat ekspansi (capex besar) sehingga hasilnya terlalu kecil. Nilai terminal biasanya mendominasi hasil, jadi asumsi g sangat berpengaruh."},
  {id:"ev", ab:"EV", group:"Arus kas", name:"EV/EBITDA wajar", desc:"(EBITDA × EV/EBITDA wajar − utang bersih) ÷ jumlah saham. Tidak berlaku untuk bank.",
   formula:"(EBITDA × EV/EBITDA wajar − utang bersih) ÷ jumlah saham",
   what:"Menilai seluruh perusahaan (ekuitas + utang) dari laba operasi sebelum bunga, pajak, dan penyusutan, lalu dikurangi utang bersih (utang − kas) untuk mendapat nilai bagian pemegang saham.",
   fit:"Perusahaan padat modal atau berutang (tambang, telko, infrastruktur); membandingkan emiten dengan struktur utang berbeda.",
   limit:"Tidak berlaku untuk bank. EBITDA mengabaikan belanja modal dan pajak. Kelipatan wajar bersifat subjektif dan berbeda antar-sektor."},
];
const DEFAULTS = {r:12, g:5, gh:8, y:6.5, pe:12, evm:7, mos:30, minN:5, eps:"ttm", agg:"median",
  on:Object.fromEntries(METHODS.map(m=>[m.id,true]))};
// Batas status "Sekitar wajar": harga sampai sekian di atas perkiraan masih disebut wajar, di atasnya "Mahal".
// Dipakai value() dan teks penjelasan di kedua halaman, supaya keterangannya tidak pernah beda dari hitungannya.
const FAIR_BAND = 0.15;
const LS = {asumsi:"idx-scanner-asumsi-v1", data:"idx-scanner-data-v1", hist:"idx-scanner-riwayat-v2",
  pref:"idx-scanner-menu-v1", oldHist:"idx-scanner-riwayat-v1", view:"idx-scanner-view",
  tema:"idx-scanner-tema"};
const SECTORS = {"Financial Services":"Keuangan","Basic Materials":"Bahan baku","Energy":"Energi",
  "Consumer Defensive":"Konsumer primer","Consumer Cyclical":"Konsumer non-primer","Communication Services":"Telekomunikasi & media",
  "Industrials":"Industri","Real Estate":"Properti","Healthcare":"Kesehatan","Technology":"Teknologi","Utilities":"Utilitas"};

// ---------- Penyimpanan (localStorage bisa tidak tersedia; semua dibungkus try/catch) ----------
function readJSON(key, fallback){ try{ const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; }catch(e){ return fallback; } }
function writeJSON(key, value){ try{ localStorage.setItem(key, JSON.stringify(value)); }catch(e){} }
function loadA(){
  const s = readJSON(LS.asumsi, null);
  return s ? {...DEFAULTS, ...s, on:{...DEFAULTS.on, ...(s.on||{})}} : structuredClone(DEFAULTS);
}
function saveA(){ writeJSON(LS.asumsi, A); }

let A = loadA();
let DATA = {};   // kode -> data emiten terakhir (dipakai semua menu); at = waktu data diambil
let HIST = [];   // kode yang discan manual di Home, terbaru di depan

function loadStore(){
  DATA = readJSON(LS.data, {});
  const hist = readJSON(LS.hist, null);
  if(Array.isArray(hist)){ HIST = hist; return; }
  // Migrasi dari versi lama: riwayat dulu menyimpan data lengkap per kode.
  const old = readJSON(LS.oldHist, {});
  Object.values(old).forEach(s => { if(s?.code && (!DATA[s.code] || DATA[s.code].at < s.at)) DATA[s.code] = s; });
  HIST = Object.values(old).filter(s=>s?.code).sort((a,b)=>b.at-a.at).map(s=>s.code);
  saveStore(); writeJSON(LS.hist, HIST);
  try{ localStorage.removeItem(LS.oldHist); }catch(e){}
}
// Tab lain bisa menulis penyimpanan yang sama: gabungkan per kode (data yang paling baru menang) sebelum menulis.
function mergeData(disk){
  let changed = false;
  Object.entries(disk||{}).forEach(([c,s])=>{ if(s?.at && !(DATA[c]?.at >= s.at)){ DATA[c] = s; changed = true; } });
  return changed;
}
function saveStore(){ mergeData(readJSON(LS.data, {})); writeJSON(LS.data, DATA); }
// Riwayat hanya diubah lewat daftar tersimpan terbaru, agar tidak menimpa scan / hapus dari tab lain.
function saveHist(f){ const d = readJSON(LS.hist, null); HIST = f(Array.isArray(d) ? d : HIST); writeJSON(LS.hist, HIST); }
// Data tanpa field `partial` diambil sebelum perbaikan nilai buku & jumlah saham: anggap basi agar menu memindai ulang.
const isStale = s => !s || s.partial===undefined || Date.now() - s.at > (s.partial.length ? PARTIAL_STALE_MS : STALE_MS);
function storeStock(stock){
  const s = {...stock, at: Date.parse(stock.fetchedAt) || Date.now()};
  DATA[s.code] = s;
  saveStore();
  return s;
}

// ---------- Format ----------
const fmtN = (v,d=0) => v==null||!isFinite(v) ? "–" : v.toLocaleString("id-ID",{maximumFractionDigits:d,minimumFractionDigits:d});
const fmtP = (v,d=1,sign=false) => v==null||!isFinite(v) ? "–" : (sign&&v>0?"+":"") + (v*100).toLocaleString("id-ID",{maximumFractionDigits:d,minimumFractionDigits:d}) + "%";
const fmtX = v => v==null||!isFinite(v) ? "–" : fmtN(v,2)+"x";
// MoS tidak punya batas bawah (harga bisa berkali-kali nilai wajar): tampilan ringkas dibatasi "< −100%".
const fmtMos = (v,d=1) => v!=null && v < -1 ? "< −100%" : fmtP(v,d,true);
const mosTitle = s => s.mos!=null && s.mos < -1 ? ` title="MoS ${fmtP(s.mos,1,true)}: harga ${fmtN(s.price/s.fair,1)}× nilai wajar"` : "";
const fmtCap = v => v==null ? "–" : v>=1e12 ? fmtN(v/1e12,1)+" T" : fmtN(v/1e9,0)+" M";
const fmtT = t => new Date(t).toLocaleString("id-ID",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});
const fmtD = iso => new Date(iso+"T00:00:00Z").toLocaleDateString("id-ID",{day:"numeric",month:"short",year:"numeric",timeZone:"UTC"});
const sectorName = s => SECTORS[s] || s || "Lainnya";
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s??"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

// ---------- Status laporan keuangan ----------
// Batas tercepat publikasi (Peraturan Bursa I-E untuk kuartal I & III, POJK 14/2022 untuk tengah tahunan &
// tahunan): laporan kuartalan tanpa reviu akuntan paling lambat akhir bulan berikutnya, laporan tahunan paling lambat
// akhir bulan ke-3 setelah tahun buku berakhir. Batas yang jatuh pada hari libur bergeser ke hari kerja berikutnya;
// di sini hanya Sabtu/Minggu -> Senin. Laporan "terbaru" = kuartal paling akhir yang batas tercepatnya sudah lewat.
// Kuartal dihitung dari bulan akhir tahun buku tiap emiten (umumnya Desember).
function reportDeadline(y, m, annual){   // akhir periode tahun y bulan m (1–12) -> pukul 23:59:59 WIB hari batas
  const d = new Date(Date.UTC(y, m + (annual ? 3 : 1), 0, 16, 59, 59));
  const wd = new Date(d.getTime() + 7*3600000).getUTCDay();
  if(wd===6 || wd===0) d.setUTCDate(d.getUTCDate() + (wd===6 ? 2 : 1));
  return d;
}
const expCache = new Map();
function expectedReport(fyMonth = 12){
  const now = new Date(), key = `${fyMonth}|${now.toISOString().slice(0,13)}`;   // dihitung ulang tiap jam
  if(expCache.has(key)) return expCache.get(key);
  let y = now.getUTCFullYear(), m = now.getUTCMonth()+1, res = null;
  for(let k=0; k<15 && !res; k++){
    if((m - fyMonth + 12) % 3 === 0){
      const annual = m === fyMonth, dl = reportDeadline(y, m, annual);
      if(now > dl) res = {iso: new Date(Date.UTC(y, m, 0)).toISOString().slice(0,10), annual,
        dueIso: new Date(dl.getTime() + 7*3600000).toISOString().slice(0,10)};
    }
    if(--m === 0){ m = 12; y--; }
  }
  expCache.set(key, res);
  return res;
}
const fyMonthOf = s => s.lastFiscalYearEnd ? +s.lastFiscalYearEnd.slice(5,7) : 12;
function periodLabel(iso, fyMonth = 12){
  const m = +iso.slice(5,7), y = +iso.slice(0,4);
  if(m === fyMonth) return `FY ${y}`;
  return fyMonth===12 && m%3===0 ? `Q${m/3} ${y}` : fmtD(iso);
}
function lkInfo(s){
  if(s.lastReport===undefined) return {key:"na", cls:"lk-na", short:"Perlu scan ulang", sub:"", state:"Perlu scan ulang",
    tip:"Data ini diambil sebelum status laporan keuangan tersedia. Klik Scan ulang untuk melihatnya."};
  const fy = fyMonthOf(s), exp = expectedReport(fy);
  if(!s.lastReport || !exp) return {key:"na", cls:"lk-na", short:"–", sub:"", state:"Tidak diketahui",
    tip:"Periode laporan keuangan tidak tersedia di data Yahoo Finance."};
  const last = s.lastReport, q = periodLabel(last, fy), want = periodLabel(exp.iso, fy);
  // Jumlah akhir kuartal emiten sesudah lastReport s.d. periode yang diharapkan (ceil: periode di luar kalender
  // kuartalnya, mis. 31 Agu, tetap dihitung tertinggal dari 30 Sep).
  const behind = Math.ceil(((+exp.iso.slice(0,4) - +last.slice(0,4))*12 + (+exp.iso.slice(5,7) - +last.slice(5,7)))/3);
  const due = exp.annual
    ? `batas publikasi laporan keuangan tahunannya ${fmtD(exp.dueIso)}`
    : `batas tercepatnya ${fmtD(exp.dueIso)} untuk laporan tanpa reviu akuntan; laporan yang direviu atau diaudit boleh terbit hingga akhir bulan ke-2 atau ke-3`;
  if(behind <= 0) return {key:"ok", cls:"lk-ok", short:"✓ Sudah update", sub:q, state:"Sudah update", q, want,
    tip:`Data memakai laporan ${q} (per ${fmtD(last)}). Laporan terbaru per hari ini: ${want} (batas tercepat publikasinya ${fmtD(exp.dueIso)} sudah lewat).`};
  if(behind === 1) return {key:"late", cls:"lk-late", short:"Belum update", sub:`data ${q}`, state:"Belum update", q, want,
    tip:`Data masih memakai laporan ${q} (per ${fmtD(last)}); laporan ${want} belum ada di Yahoo Finance. Bisa karena emiten belum merilis (${due}) atau Yahoo belum memperbarui datanya.`};
  return {key:"old", cls:"lk-old", short:"Tertinggal", sub:`data ${q}`, state:"Tertinggal", q, want,
    tip:`Data memakai laporan ${q} (per ${fmtD(last)}), tertinggal ${behind} kuartal dari laporan ${want}.`};
}
// Tabel: lencana + periode di baris kedua; inline (rincian): lencana + periode di sebelahnya.
const lkBadge = (s, inline=false) => {
  const k = lkInfo(s), b = `<span class="lk ${k.cls}" title="${esc(k.tip)}">${k.short}</span>`;
  return !k.sub ? b : inline ? `${b} <span class="mut">${esc(k.sub)}</span>` : `${b}<div class="nm">${esc(k.sub)}</div>`;
};

// ---------- Scan (antrean bersama semua menu & halaman) ----------
// Permintaan pengguna (Scan, Scan ulang) didahulukan dari pemindaian menu. Rate limit (429) atau server tak
// terjangkau menjeda SEMUA permintaan bersama-sama; bila terulang tiga gelombang, sisa antrean dihentikan.
let active = 0, pauseUntil = 0, pauseSetAt = 0, strikes = 0, pumpTimer = 0, pauseNet = false;
const waiting = [];              // job {code, urgent, run, fail, startedAt}
const inflight = new Map();      // kode -> {promise, job}
const running = new Set();       // kode yang permintaannya sedang dikirim (bukan sekadar antre)
const paused = () => pauseUntil > Date.now();
// Diganti halaman dengan fungsi render-nya: dipanggil tiap antrean berubah.
let onScan = ()=>{};

function pump(){
  clearTimeout(pumpTimer);
  while(active < MAX_PARALLEL && waiting.length){
    if(paused()){ pumpTimer = setTimeout(pump, pauseUntil - Date.now()); return; }
    const job = waiting.shift();
    active++;
    job.run().finally(()=>{ active--; pump(); });
  }
}
// Permintaan pengguna antre di depan sesuai urutan masuk; percobaan ulang kembali ke depan kelompoknya.
function enqueue(job, retry){
  const n = waiting.findIndex(j=>!j.urgent), end = n < 0 ? waiting.length : n;
  if(retry && job.urgent) waiting.unshift(job);
  else if(retry || job.urgent) waiting.splice(end, 0, job);
  else waiting.push(job);
  pump();
}

// Satu permintaan ke API; tidak pernah melempar exception.
async function requestStock(code){
  try{
    const r = await fetch(`${API}?code=${encodeURIComponent(code)}`);
    const body = await r.json().catch(()=>({error:`Server tidak merespons dengan benar (HTTP ${r.status})`, retryable: r.status>=500}));
    return {status: r.status, ...body};
  }catch(e){
    return {status:0, network:true, retryable:true,
      error:"Tidak bisa menghubungi server scan. Periksa koneksi internet (versi lokal: pastikan jalankan.bat masih berjalan)."};
  }
}

// Gelombang 429 / gangguan jaringan berikutnya menggandakan jeda (10, 20, 40, 60 detik). Mulai gelombang ke-3,
// sisa antrean dihentikan agar tidak terus membebani Yahoo. Kembalikan true bila antrean dihentikan.
function throttled(job, message, net){
  // Permintaan yang dikirim sebelum jeda terakhir (juga pada milidetik yang sama) = gelombang yang sama. Selama jeda
  // tidak ada permintaan baru, jadi gelombang berikutnya selalu dimulai sesudah pauseSetAt.
  if(job.startedAt > pauseSetAt){
    strikes++;
    pauseSetAt = Date.now();
    pauseUntil = pauseSetAt + Math.min(60000, 10000 * 2**(strikes-1)) + Math.random()*2000;
    pauseNet = !!net;
  }
  onScan();
  if(strikes < 3) return false;
  waiting.splice(0).forEach(j => j.fail(`${message} Pemindaian dihentikan sementara.`));
  return true;
}

// Ambil satu emiten; permintaan ganda untuk kode yang sama digabung. Gagal sementara dicoba ulang 2x.
function fetchStock(code, {urgent=false}={}){
  const cur = inflight.get(code);
  if(cur){
    // Sudah antre di pemindaian menu: pindahkan ke antrean permintaan pengguna bila pengguna memintanya langsung.
    if(urgent && !cur.job.urgent){
      cur.job.urgent = true;
      const i = waiting.indexOf(cur.job);
      if(i >= 0){ waiting.splice(i, 1); enqueue(cur.job); }
    }
    return cur.promise;
  }
  const entry = {};
  entry.promise = new Promise((resolve, reject)=>{
    let attempt = 0;
    const job = entry.job = {code, urgent, fail: msg => reject(new Error(msg)), run: async ()=>{
      job.startedAt = Date.now();
      running.add(code); onScan();
      const res = await requestStock(code);
      running.delete(code);
      if(res.status===200 && res.stock){ strikes = 0; resolve(storeStock(res.stock)); return; }
      const limitedNow = res.status===429 || res.network;
      if(limitedNow && throttled(job, res.error, res.network)){ job.fail(`${res.error} Pemindaian dihentikan sementara.`); return; }
      // Kode indeks pasti ada: 404 karena gangguan sesaat Yahoo dicoba sekali lagi.
      const retry = limitedNow || res.retryable || (res.status===404 && attempt===0 && isIndexCode(code));
      if(!retry || attempt >= 2){ job.fail(res.error || `HTTP ${res.status}`); return; }
      attempt++;
      // Slot dilepas selama menunggu: 429 menunggu jeda bersama, gangguan lain menunggu 2,5 / 7 detik.
      if(limitedNow) enqueue(job, true);
      else setTimeout(()=>enqueue(job, true), attempt===1 ? 2500 : 7000);
    }};
    enqueue(job);
  }).finally(()=>inflight.delete(code));
  inflight.set(code, entry);
  return entry.promise;
}

function parseCodes(text){
  return [...new Set(text.toUpperCase().split(/[\s,;]+/).map(c=>c.replace(/\.JK$/,"")).filter(Boolean))];
}
const pauseWhy = () => pauseNet ? "server scan tidak terjangkau (periksa koneksi; versi lokal: jalankan.bat)" : "Yahoo Finance membatasi permintaan";
// Sisa jeda dalam milidetik, agar halaman bisa menampilkan hitungan mundurnya alih-alih bilah progres yang diam.
const pausedUntil = () => Math.max(0, pauseUntil - Date.now());
// Tombol "coba lagi" pengguna. Tanpa ini, `strikes` tidak pernah turun kecuali ada respons 200, jadi percobaan ulang
// setelah antrean dihentikan akan langsung dihentikan lagi oleh kegagalan pertama.
function resetScanPause(){
  strikes = 0; pauseUntil = 0; pauseSetAt = Date.now(); pauseNet = false;
  pump();
}

// ---------- Valuasi ----------
function value(s){
  const r = A.r/100, g = A.g/100, gh = A.gh/100;
  const eps = A.eps==="fwd" && s.fwdEps ? s.fwdEps : s.eps;
  const v = {};
  if(s.bvps>0) v.bv = s.bvps;
  if(s.bvps>0 && s.histPbv) v.pbvh = s.histPbv.avg*s.bvps;
  if(s.bvps>0 && s.roe!=null && r>g){ const x = s.bvps*(s.roe-g)/(r-g); if(x>0) v.pbv = x; }
  if(eps>0 && s.bvps>0) v.gn = Math.sqrt(22.5*eps*s.bvps);
  if(eps>0 && A.y>0) v.gf = eps*(8.5+2*A.gh)*4.4/A.y;
  if(eps>0) v.per = eps*A.pe;
  if(eps>0 && s.histPe) v.perh = s.histPe.avg*eps;
  if(eps>0 && r>0) v.epv = eps/r;
  if(s.dps>0 && r>g) v.ddm = s.dps*(1+g)/(r-g);
  if(s.fcfps>0 && r>g){
    let pv = 0, f = s.fcfps;
    for(let t=1; t<=5; t++){ f *= 1+gh; pv += f/(1+r)**t; }
    v.dcf = pv + f*(1+g)/(r-g)/(1+r)**5;
  }
  if(s.ebitda>0 && s.shares>0){ const x = (s.ebitda*A.evm - (s.netDebt||0))/s.shares; if(x>0) v.ev = x; }
  const used = METHODS.filter(m => A.on[m.id] && v[m.id]!=null).map(m => v[m.id]);
  let fair = null;
  if(used.length){
    const sorted = [...used].sort((a,b)=>a-b);
    if(A.agg==="min") fair = sorted[0];
    else if(A.agg==="mean") fair = used.reduce((a,b)=>a+b,0)/used.length;
    else { const m = sorted.length>>1; fair = sorted.length%2 ? sorted[m] : (sorted[m-1]+sorted[m])/2; }
  }
  const mos = fair ? (fair - s.price)/fair : null;
  const target = A.mos/100;
  let status = "na";
  if(mos!=null) status = mos>=target ? "buy" : mos>0 ? "under" : mos>-FAIR_BAND ? "fair" : "over";
  // Emiten rugi hanya dinilai dari nilai buku: jangan dilabeli "murah".
  if(status==="buy" && !(eps>0)) status = "under";
  // Belum cukup metode yang bisa dihitung: nilai wajar belum layak dijadikan patokan.
  if(mos!=null && used.length < A.minN) status = "few";
  return {
    ...s, epsUsed:eps, vals:v, n:used.length, fair,
    lo: used.length ? Math.min(...used) : null, hi: used.length ? Math.max(...used) : null,
    mos, upside: fair ? fair/s.price-1 : null, buyAt: fair ? fair*(1-target) : null,
    pbv: s.bvps>0 ? s.price/s.bvps : null, per: eps>0 ? s.price/eps : null,
    dy: s.dps ? s.dps/s.price : null, status,
    weak: !(eps>0) ? "Rugi" : (s.roe!=null && s.roe<0.08 ? "ROE↓" : null),
  };
}

const STATUS = {
  buy:  ["b-buy","Murah (MoS cukup)"],
  under:["b-under","Di bawah wajar"],
  fair: ["b-fair","Sekitar wajar"],
  over: ["b-over","Mahal"],
  na:   ["b-na","Data kurang"],
  few:  ["b-na","Metode kurang"],
};
const STATUS_ORDER = {buy:5,under:4,fair:3,over:2,few:1,na:0};
const statusBadge = s => {
  const [cls,lab] = STATUS[s.status];
  return `<span class="badge ${cls}">${s.status==="few" ? `${lab} (${s.n}/${A.minN})` : lab}</span>`;
};

// ---------- Tema terang / gelap ----------
// Tiga pilihan: ikut perangkat (bawaan), terang, gelap. Disimpan bersama agar versi Lite dan Pro tidak berbeda.
const THEMES = [
  {key:"auto",  icon:"🌗", label:"Tema: ikut perangkat", next:"terang"},
  {key:"light", icon:"☀️", label:"Tema: terang", next:"gelap"},
  {key:"dark",  icon:"🌙", label:"Tema: gelap", next:"ikut perangkat"},
];
// Pilihan tema juga disimpan di memori: bila localStorage diblokir (cookie/site data dimatikan, webview, iframe tanpa
// izin penyimpanan) tulisannya ditelan try/catch dan bacaannya tetap null, jadi tombolnya akan terlihat rusak.
let temaDipilih = null;
function themeNow(){
  let v = temaDipilih;
  if(v===null){ try{ v = localStorage.getItem(LS.tema); }catch(e){} }
  return THEMES.find(t=>t.key===v) || THEMES[0];
}
function applyTheme(){
  const t = themeNow(), b = $("theme");
  if(t.key==="auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t.key);
  if(b){
    b.textContent = t.icon;
    b.title = `${t.label} (klik untuk ganti ke ${t.next})`;
    b.setAttribute("aria-label", b.title);
  }
}
function cycleTheme(){
  const i = THEMES.indexOf(themeNow());
  temaDipilih = THEMES[(i+1) % THEMES.length].key;
  try{ localStorage.setItem(LS.tema, temaDipilih); }catch(e){}
  applyTheme();
}
// Tema diganti di tab lain: buang pilihan di memori dulu, supaya nilai dari penyimpanan yang dipakai.
function syncTheme(){ temaDipilih = null; applyTheme(); }
// Dipasang sebelum halaman selesai dimuat agar tidak ada kedipan warna.
applyTheme();
