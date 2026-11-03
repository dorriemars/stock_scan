"""GET /api/scan?code=BBRI -> data fundamental satu emiten IDX dari Yahoo Finance.

Dipakai dua cara:
- Vercel: file ini otomatis jadi serverless function (class `handler`).
- Lokal: server.py mengimpor `scan()` dari sini.
"""

import functools
import json
import math
import os
import re
import tempfile
import time
import warnings
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import yfinance as yf

try:
    from yfinance.exceptions import YFRateLimitError
except ImportError:  # versi yfinance lama
    YFRateLimitError = ()

warnings.filterwarnings("ignore")
# Di Vercel hanya /tmp yang bisa ditulis.
yf.set_tz_cache_location(os.path.join(tempfile.gettempdir(), "yf-cache"))

CACHE_TTL = 600  # detik
FX_FALLBACK_AGE = 24 * 3600  # kurs terakhir yang berhasil masih dipakai selama ini bila Yahoo sedang gagal
V7_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
TS_URL = "https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/"
EQUITY_ROWS = ["Common Stock Equity", "Stockholders Equity"]
SHARE_ROWS = ["Ordinary Shares Number", "Share Issued"]
AVG_SHARE_ROWS = ["Diluted Average Shares", "Basic Average Shares"]  # dasar EPS laporan laba rugi
_cache: dict[str, tuple[float, dict]] = {}
_fx_cache: dict[str, tuple[float, float]] = {}  # hanya kurs yang berhasil diambil
_fx_hist_cache: dict[str, tuple[float, object]] = {}


class NotFound(Exception):
    pass


class Retryable(Exception):
    """Gangguan sementara dari Yahoo: dikembalikan sebagai 502 yang boleh dicoba ulang."""


class Degraded(Exception):
    """Sebagian data gagal diambil: hasil tetap dikirim, ditandai `partial`, dan tidak di-cache."""


def is_rate_limit(e: Exception) -> bool:
    return isinstance(e, YFRateLimitError) or "Too Many Requests" in str(e) or "Rate limit" in str(e)


def utc_dt(ts, scale: int = 1) -> datetime | None:
    """Epoch (detik; milidetik dengan scale=1000) -> datetime UTC tanpa zona, sebanding dengan tanggal kolom laporan."""
    try:
        return datetime.fromtimestamp(int(ts) / scale, timezone.utc).replace(tzinfo=None)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def iso_date(ts) -> str | None:
    d = utc_dt(ts)
    return d.date().isoformat() if d else None


def num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) != float("inf") else None


def fx_to_idr(currency: str) -> float:
    """Kurs mata uang laporan -> IDR. Bila gagal diambil, pakai kurs terakhir yang berhasil; tanpa itu lempar error
    yang bisa diulang, agar nilai buku, FCF & EBITDA emiten berlaporan USD tidak hilang diam-diam."""
    if currency in ("IDR", None, ""):
        return 1.0
    hit = _fx_cache.get(currency)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]
    err = None
    try:
        rate = num(yf.Ticker(f"{currency}IDR=X").fast_info["lastPrice"])
    except Exception as e:
        rate, err = None, e
    if rate:
        _fx_cache[currency] = (time.time(), rate)
        return rate
    if hit and time.time() - hit[0] < FX_FALLBACK_AGE:
        return hit[1]
    if err is not None and is_rate_limit(err):
        raise err
    raise Retryable(f"kurs {currency}/IDR tidak tersedia")


def quote_exists(t) -> bool:
    """Info kosong bisa berarti kode salah atau Yahoo sedang gagal. Tanya ulang daftar kutipan Yahoo: hasil kosong =
    kode memang tidak ada; rate limit / gangguan jaringan dilempar (jadi 429 / 502 yang bisa diulang)."""
    data = t._data.get_raw_json(V7_QUOTE_URL, params={"symbols": t.ticker, "formatted": "false"})
    return bool((data.get("quoteResponse") or {}).get("result"))


def yahoo_has_series(t, types: str) -> bool:
    """Apakah Yahoo punya angka untuk salah satu seri laporan `types` (dipisah koma). yfinance mengembalikan tabel
    kosong baik saat permintaannya gagal maupun saat laporannya memang tidak ada (emiten baru); permintaan langsung ini
    tidak memakai memo dan melempar rate limit / error HTTP."""
    data = t._data.get_raw_json(TS_URL + t.ticker, params={"symbol": t.ticker, "type": types, "period1": 1483142400,
                                                           "period2": int(time.time()) + 86400})
    ts = data.get("timeseries") or {}
    if ts.get("error") is not None or ts.get("result") is None:
        raise Retryable("laporan keuangan tidak terbaca")
    return any(set(x) - {"meta", "timestamp"} for x in ts["result"])


def clear_request_memo():
    """yfinance menyimpan respons laporan keuangan per hari (lru_cache). Buang setelah ada yang gagal, agar scan
    berikutnya mengambil ulang alih-alih mengulang respons yang gagal."""
    try:
        from yfinance.data import YfData
        YfData.cache_get.cache_clear()
    except Exception:
        pass


def _row(df, col, names):
    for n in names:
        if n in df.index and col in df.columns:
            v = num(df.at[n, col])
            if v is not None:
                return v
    return None


def split_factor(splits, after) -> float:
    """Gabungan rasio pemecahan saham sesudah tanggal `after` (1 = tidak ada)."""
    f = 1.0
    if splits is not None:
        for when, ratio in splits.items():
            if when > after and ratio > 0:
                f *= ratio
    return f


def share_factors(df, rows, splits, shares_now) -> dict:
    """Pengali jumlah saham per kolom laporan untuk pemecahan saham yang belum diterapkan Yahoo -> {tanggal: faktor}.

    Harga Yahoo sudah disesuaikan, tetapi laporan kadang belum (PBSA 2:1 pada 14 Okt 2026: neraca 30 Jun 2026 masih
    memakai jumlah saham lama). Per pemecahan, jumlah saham kolom terakhir sebelumnya dibandingkan dengan kolom pertama
    sesudahnya (atau jumlah saham sekarang): melompat sebesar rasionya = belum disesuaikan."""
    counts = {d: _row(df, d, rows) for d in df.columns} if df is not None and not df.empty else {}
    cols = sorted(d for d, n in counts.items() if n and n > 0)
    factor = {d: 1.0 for d in cols}
    if splits is None or not cols:
        return factor
    for when, ratio in sorted(splits.items(), reverse=True):  # terbaru dulu, agar pembanding sudah disesuaikan
        before = [d for d in cols if d < when]
        if not before or ratio <= 0 or ratio == 1:
            continue
        after = [d for d in cols if d >= when]
        post = counts[after[0]] * factor[after[0]] if after else shares_now
        pre = counts[before[-1]] * factor[before[-1]]
        if post and abs(math.log(post / (pre * ratio))) < abs(math.log(post / pre)):
            for d in before:
                factor[d] *= ratio
    return factor


Sheet = namedtuple("Sheet", "bvps date mi equity shares")


def latest_sheet(sheet, fx: float, since, splits, shares_now) -> Sheet | None:
    """Kolom neraca terbaru yang lengkap: BVPS (IDR), tanggal, kepentingan nonpengendali & ekuitas (mata uang laporan),
    jumlah saham (sudah disesuaikan dengan pemecahan saham). BVPS kosong bila ekuitasnya negatif atau kolomnya sebelum
    IPO (ekuitas lama dibagi jumlah saham sesudah IPO)."""
    if sheet is None or sheet.empty:
        return None
    factor = share_factors(sheet, SHARE_ROWS, splits, shares_now)
    for d in sorted(sheet.columns, reverse=True):
        equity, shares = _row(sheet, d, EQUITY_ROWS), _row(sheet, d, SHARE_ROWS)
        if equity is not None and shares and shares > 0:
            total = _row(sheet, d, ["Total Equity Gross Minority Interest"])
            shares *= factor[d]
            pre_ipo = since is not None and d < since
            bvps = equity * fx / shares if equity > 0 and not pre_ipo else None
            return Sheet(bvps, d, total - equity if total is not None else 0.0, equity, shares)
    return None


def pick_bvps(t, i: dict, fx: float, fin_ccy: str, shares, splits, partial: list):
    """Nilai buku per saham (IDR) -> (nilai, tanggal neraca bila bukan bookValue Yahoo apa adanya).

    bookValue Yahoo kadang salah satuan (HRTA ~100x lebih kecil), keliru (ENRG, INDY), dibulatkan ke 0,001 USD (BUMI),
    atau masih memakai jumlah saham sebelum IPO / pemecahan saham (JELI, PBSA). Pembanding utamanya ekuitas per kuartal
    terakhir menurut Yahoo sendiri (total utang ÷ DER) dikurangi kepentingan nonpengendali, dibagi jumlah saham
    sekarang. Tanpa DER (bank, emiten tanpa utang) pembandingnya neraca, yang bisa tertinggal satu kuartal."""
    book_value = num(i.get("bookValue"))
    bv = book_value * fx if book_value is not None else None
    rounded = fin_ccy != "IDR" and book_value is not None and 0 < book_value < 0.05  # galat pembulatan > 1%
    mrq = utc_dt(i.get("mostRecentQuarter"))
    since = utc_dt(i.get("firstTradeDateMilliseconds"), 1000)  # tanggal IPO

    @functools.cache
    def quarterly():
        qbs = t.quarterly_balance_sheet
        if qbs is None or qbs.empty:  # tabel kosong = gagal diambil (yfinance menelan error) atau memang tidak ada
            try:
                if yahoo_has_series(t, "quarterlyStockholdersEquity"):
                    partial.append("neraca kuartal")
            except Exception as e:
                if is_rate_limit(e):
                    raise
                partial.append("neraca kuartal")
        return latest_sheet(qbs, fx, since, splits, shares)

    annual = latest_sheet(t.balance_sheet, fx, since, splits, shares)
    td, de = num(i.get("totalDebt")), num(i.get("debtToEquity"))
    # Ekuitas total (termasuk nonpengendali) per mrq menurut Yahoo sendiri: total utang ÷ DER. DER dalam persen dengan
    # 3 desimal, jadi di bawah 1% galat pembulatannya terlalu besar. mrq sebelum IPO: ekuitasnya belum memuat dana IPO.
    equity = td * 100 / de if td and de and de >= 1 and shares and mrq and not (since and since > mrq) else None

    def reference(s):
        """Pembanding BVPS per mrq dari ekuitas Yahoo & neraca s -> (nilai, toleransi, tanggal) atau None."""
        if not equity or s is None or not s.equity or s.equity <= 0:
            return None
        if s.bvps and s.date >= mrq:  # neraca kuartal yang sama: angka persis
            return s.bvps, 0.05, s.date
        # Jumlah saham sekarang, kecuali berbeda lebih dari 3x dengan neraca (lebih mungkin keliru, MKNT).
        n = shares if 1 / 3 <= shares / s.shares <= 3 else s.shares
        est = (equity - s.mi) * fx / n  # kepentingan nonpengendali dari neraca yang mungkin lebih lama
        return (est, 0.05 + 0.1 * abs(s.mi) / s.equity, mrq) if est > 0 else None

    def near(x, ref):
        return x is not None and abs(x / ref[0] - 1) <= ref[1]

    ref = reference(annual)
    if ref and not rounded and near(bv, ref):
        return bv, None
    if equity and annual:
        ref = reference(quarterly()) or ref  # neraca kuartal: nonpengendali lebih baru
        if ref:
            if not rounded and near(bv, ref):
                return bv, None
            return ref[0], ref[2].date().isoformat()

    # Tanpa pembanding ekuitas Yahoo: bookValue dipakai kecuali tidak cocok dengan neraca tahunan.
    f = split_factor(splits, mrq) if mrq else 1.0
    if bv is not None and bv > 0 and f != 1 and annual and annual.bvps:
        # Pemecahan saham sesudah mrq: bookValue bisa masih per saham lama.
        bv = min(bv, bv / f, key=lambda x: abs(math.log(x / annual.bvps)))

    def off(ref, tol):
        return bv is not None and bv > 0 and ref is not None and not 1 / tol <= bv / ref <= tol

    def usable(s, tol):
        if bv is None:
            return True
        if mrq is None or s.date >= mrq:
            return rounded or off(s.bvps, tol)
        # Neraca lebih lama dari bookValue: pakai hanya bila bookValue jelas keliru, atau neraca masih di dalam
        # rentang pembulatan bookValue (lebih presisi).
        return off(s.bvps, 2.5) or (rounded and abs(s.bvps / fx - book_value) <= 0.0005)

    if bv is not None and not rounded and not off(annual.bvps if annual else None, 1.33):
        return bv, None
    q = quarterly()
    if q and q.bvps is not None:
        return (q.bvps, q.date.date().isoformat()) if usable(q, 1.25) else (bv, None)
    if annual and annual.bvps is not None and usable(annual, 2.0):
        return annual.bvps, annual.date.date().isoformat()
    return bv, None


def fx_history(currency: str):
    """Kurs bulanan 6 tahun (mata uang laporan -> IDR), di-cache agar tidak diambil ulang per emiten."""
    hit = _fx_hist_cache.get(currency)
    if not hit or time.time() - hit[0] > CACHE_TTL:
        series = yf.Ticker(f"{currency}IDR=X").history(period="6y", interval="1mo")["Close"]
        series.index = series.index.tz_localize(None)
        hit = _fx_hist_cache[currency] = (time.time(), series)
    return hit[1]


def history_multiples(t, close, fin_ccy: str, splits, shares_now) -> dict:
    """Rata-rata PBV & PER per tahun buku (harga rata-rata 12 bulan / BVPS & EPS akhir tahun)."""
    bs, inc = t.balance_sheet, t.income_stmt
    # yfinance menelan error (termasuk rate limit) dan mengembalikan tabel kosong, sama seperti saat Yahoo memang
    # tidak punya laporannya (emiten baru, sebagian emiten kecil): tanya langsung sebelum menandai data sebagian.
    missing = [k for k, df in (("annualStockholdersEquity", bs), ("annualNetIncome", inc)) if df is None or df.empty]
    if missing and yahoo_has_series(t, ",".join(missing)):
        raise Degraded("laporan keuangan tahunan")
    if bs is None or bs.empty:
        return {"histPbv": None, "histPe": None, "histYears": []}
    fx_hist = fx_history(fin_ccy) if fin_ccy != "IDR" else None
    # Harga sudah disesuaikan dengan pemecahan saham; jumlah saham & EPS di laporan kadang belum.
    share_f = share_factors(bs, SHARE_ROWS, splits, shares_now)
    eps_f = share_factors(inc, AVG_SHARE_ROWS, splits, shares_now)

    pbvs, pes, years = [], [], []
    for d in bs.columns:
        start = d - timedelta(days=365)
        window = close[(close.index > start) & (close.index <= d)]
        equity = _row(bs, d, EQUITY_ROWS)
        shares = _row(bs, d, SHARE_ROWS)
        if not len(window) or not equity or not shares or shares <= 0:
            continue
        shares *= share_f[d]
        fx = 1.0
        if fx_hist is not None:
            fx_window = fx_hist[(fx_hist.index > start) & (fx_hist.index <= d)]
            if not len(fx_window):
                continue
            fx = float(fx_window.mean())
        price = float(window.mean())
        bvps = equity * fx / shares
        if bvps > 0 and price / bvps < 50:
            pbvs.append(price / bvps)
        eps = _row(inc, d, ["Diluted EPS", "Basic EPS"])
        if eps:
            eps /= eps_f.get(d, share_f[d])
        if eps and eps > 0 and price / (eps * fx) < 100:
            pes.append(price / (eps * fx))
        years.append(d.year)

    def stats(xs):
        return {"avg": sum(xs) / len(xs), "min": min(xs), "max": max(xs), "n": len(xs)} if len(xs) >= 2 else None

    return {"histPbv": stats(pbvs), "histPe": stats(pes), "histYears": sorted(years)}


def fetch(code: str) -> dict:
    t = yf.Ticker(f"{code}.JK")
    i = t.info or {}

    price = num(i.get("currentPrice")) or num(i.get("regularMarketPrice"))
    if not price:
        # 404 hanya bila Yahoo memastikan kodenya tidak ada; info kosong karena gangguan sesaat -> coba lagi.
        if set(i) - {"trailingPegRatio"} or not quote_exists(t):
            raise NotFound(f"Kode {code} tidak ditemukan di Yahoo Finance")
        raise Retryable("data kutipan Yahoo tidak lengkap")
    # Harga ada tetapi ringkasan fundamental gagal (mata uang laporan, ROE, FCF, periode laporan tidak ada).
    if not any(k in i for k in ("mostRecentQuarter", "currentPrice", "sector")):
        raise Retryable("ringkasan fundamental Yahoo tidak lengkap")

    # bookValue, laba, arus kas & utang memakai mata uang laporan keuangan (mis. USD untuk ADRO/MEDC/INCO),
    # sedangkan harga dalam IDR -> konversi.
    fin_ccy = i.get("financialCurrency") or "IDR"
    fx = fx_to_idr(fin_ccy)
    mcap = num(i.get("marketCap"))
    # sharesOutstanding Yahoo kadang keliru jauh (BKSL, BRMS, JPFA, BBNI); jumlah saham tersirat dari
    # kapitalisasi pasar konsisten dengan harga.
    shares = num(i.get("impliedSharesOutstanding")) or (mcap / price if mcap else None) or num(i.get("sharesOutstanding"))

    partial = []
    # Satu permintaan harga harian 6 tahun (tanpa penyesuaian dividen) dipakai untuk tiga hal: pemecahan saham,
    # dividen 12 bulan terakhir, dan harga rata-rata per tahun buku (PBV/PER historis).
    try:
        prices = t.history(period="6y", interval="1d", auto_adjust=False, actions=True)
        prices.index = prices.index.tz_localize(None)
    except Exception as e:
        if is_rate_limit(e):
            raise
        prices = None
    if prices is None or not len(prices):
        prices = None
        partial.append("riwayat harga & dividen")
    splits = prices["Stock Splits"] if prices is not None and "Stock Splits" in prices else None
    if splits is not None:
        splits = splits[splits > 0]

    bvps, bv_source = pick_bvps(t, i, fx, fin_ccy, shares, splits, partial)

    # EPS dari Yahoo sudah dalam IDR; turunkan dari PER agar konsisten dengan harga. PER kosong (umumnya rugi):
    # pakai laba bersih 12 bulan ÷ jumlah saham, karena trailingEps kadang keliru tanda (ENRG).
    pe = num(i.get("trailingPE"))
    net_income = num(i.get("netIncomeToCommon"))
    eps_from_ni = not pe and net_income is not None and bool(shares)
    if pe:
        eps = price / pe
    elif eps_from_ni:
        eps = net_income * fx / shares
    else:
        eps = num(i.get("trailingEps")) if fin_ccy == "IDR" else None

    dps = None
    if prices is not None and "Dividends" in prices and (prices["Dividends"] > 0).any():
        divs = prices["Dividends"]
        dps = float(divs[divs.index >= datetime.now() - timedelta(days=365)].sum())

    roe = num(i.get("returnOnEquity"))
    if roe is None and eps is not None and bvps:
        roe = eps / bvps

    # Arus kas, EBITDA & utang dalam mata uang laporan -> IDR (per saham bila perlu).
    fcf, ebitda = num(i.get("freeCashflow")), num(i.get("ebitda"))
    debt, cash = num(i.get("totalDebt")), num(i.get("totalCash"))
    fcfps = fcf * fx / shares if fcf is not None and shares else None
    net_debt = (debt or 0) * fx - (cash or 0) * fx if debt is not None or cash is not None else None

    hist = {"histPbv": None, "histPe": None, "histYears": []}
    if prices is not None:
        try:
            hist = history_multiples(t, prices["Close"], fin_ccy, splits, shares)
        except Exception as e:
            if is_rate_limit(e):
                raise
            partial.append(str(e) if isinstance(e, Degraded) else "PBV & PER historis")
    if partial:
        clear_request_memo()

    return {
        **hist,
        "fcfps": fcfps,
        "ebitda": ebitda * fx if ebitda is not None else None,
        "netDebt": net_debt,
        "shares": shares,
        "code": code,
        "name": i.get("longName") or i.get("shortName") or code,
        "sector": i.get("sector") or "Lainnya",
        "industry": i.get("industry") or "",
        "price": price,
        "bvps": bvps,
        # Tanggal neraca bila BVPS dihitung dari neraca karena bookValue Yahoo tidak konsisten.
        "bvSource": bv_source,
        "eps": eps,
        "epsFromNi": eps_from_ni,
        "fwdEps": num(i.get("forwardEps")),
        "dps": dps,
        "roe": roe,
        "payout": num(i.get("payoutRatio")),
        "epsGrowth": num(i.get("earningsGrowth")),
        "revGrowth": num(i.get("revenueGrowth")),
        "der": num(i.get("debtToEquity")),
        "mcap": mcap,
        "low52": num(i.get("fiftyTwoWeekLow")),
        "high52": num(i.get("fiftyTwoWeekHigh")),
        "finCcy": fin_ccy,
        # Periode laporan keuangan terakhir yang dipakai Yahoo (book value, ROE, EPS TTM).
        "lastReport": iso_date(i.get("mostRecentQuarter")),
        "lastFiscalYearEnd": iso_date(i.get("lastFiscalYearEnd")),
        # Bagian data yang gagal diambil (kosong = lengkap). Hasil parsial tidak di-cache.
        "partial": partial,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
    }


def scan(raw_code: str) -> tuple[int, dict]:
    """Kembalikan (HTTP status, payload JSON)."""
    code = (raw_code or "").strip().upper().removesuffix(".JK")
    if not re.fullmatch(r"[A-Z0-9]{2,6}", code):
        return 400, {"error": "Format kode tidak valid. Contoh: BBRI, TLKM, ASII"}
    hit = _cache.get(code)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return 200, {"stock": hit[1], "cached": True}
    try:
        stock = fetch(code)
    except NotFound as e:
        return 404, {"error": str(e)}
    except Exception as e:
        if is_rate_limit(e):
            return 429, {"error": "Yahoo Finance sedang membatasi permintaan (rate limit). Coba lagi beberapa saat lagi.",
                         "retryable": True}
        # Respons gagal bisa tersimpan di memo yfinance; tanpa dibuang, percobaan ulang hanya mengulang kegagalannya.
        clear_request_memo()
        return 502, {"error": f"Gagal mengambil data {code}: {e}", "retryable": True}
    if not stock["partial"]:
        _cache[code] = (time.time(), stock)
    return 200, {"stock": stock, "cached": False}


def cache_header(status: int, payload: dict) -> str:
    """Hanya hasil lengkap yang boleh di-cache CDN; error & hasil parsial selalu diambil ulang."""
    if status == 200 and not payload["stock"].get("partial"):
        return f"public, s-maxage={CACHE_TTL}"
    return "no-store"


INDEX_HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "index.html")


class handler(BaseHTTPRequestHandler):
    """Entrypoint Vercel: /api/scan -> JSON; / -> halaman (cadangan bila public/ tidak disajikan CDN)."""

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.rstrip("/") == "/api/scan":
            code = parse_qs(url.query).get("code", [""])[0]
            status, payload = scan(code)
            self._send(status, json.dumps(payload).encode(), "application/json", cache_header(status, payload))
        elif url.path in ("/", "/index.html"):
            with open(INDEX_HTML, "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8", "no-cache")
        else:
            self._send(404, b'{"error": "Tidak ditemukan"}', "application/json", "no-store")

    def _send(self, status, body, content_type, cache):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)
