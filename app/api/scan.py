"""GET /api/scan?code=BBRI -> data fundamental satu emiten IDX dari Yahoo Finance.

Dipakai dua cara:
- Vercel: file ini otomatis jadi serverless function (class `handler`).
- Lokal: server.py mengimpor `scan()` dari sini.
"""

import json
import os
import re
import tempfile
import time
import warnings
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import yfinance as yf

warnings.filterwarnings("ignore")
# Di Vercel hanya /tmp yang bisa ditulis.
yf.set_tz_cache_location(os.path.join(tempfile.gettempdir(), "yf-cache"))

CACHE_TTL = 600  # detik
_cache: dict[str, tuple[float, dict]] = {}
_fx_cache: dict[str, tuple[float, float | None]] = {}


class NotFound(Exception):
    pass


def num(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) != float("inf") else None


def fx_to_idr(currency: str) -> float | None:
    if currency in ("IDR", None, ""):
        return 1.0
    hit = _fx_cache.get(currency)
    if not hit or time.time() - hit[0] > CACHE_TTL:
        try:
            rate = float(yf.Ticker(f"{currency}IDR=X").fast_info["lastPrice"])
        except Exception:
            rate = None
        hit = _fx_cache[currency] = (time.time(), rate)
    return hit[1]


def _row(df, col, names):
    for n in names:
        if n in df.index and col in df.columns:
            v = num(df.at[n, col])
            if v is not None:
                return v
    return None


def history_multiples(t, fin_ccy: str) -> dict:
    """Rata-rata PBV & PER per tahun buku (harga rata-rata 12 bulan / BVPS & EPS akhir tahun)."""
    bs, inc = t.balance_sheet, t.income_stmt
    close = t.history(period="6y", interval="1mo", auto_adjust=False)["Close"]
    close.index = close.index.tz_localize(None)
    fx_hist = None
    if fin_ccy != "IDR":
        fx_hist = yf.Ticker(f"{fin_ccy}IDR=X").history(period="6y", interval="1mo")["Close"]
        fx_hist.index = fx_hist.index.tz_localize(None)

    pbvs, pes, years = [], [], []
    for d in bs.columns:
        start = d - timedelta(days=365)
        window = close[(close.index > start) & (close.index <= d)]
        equity = _row(bs, d, ["Common Stock Equity", "Stockholders Equity"])
        shares = _row(bs, d, ["Ordinary Shares Number", "Share Issued"])
        if not len(window) or not equity or not shares:
            continue
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
        raise NotFound(f"Kode {code} tidak ditemukan di Yahoo Finance")

    # bookValue memakai mata uang laporan keuangan (mis. USD untuk ADRO/MEDC/INCO),
    # sedangkan harga dalam IDR -> konversi.
    fin_ccy = i.get("financialCurrency") or "IDR"
    fx = fx_to_idr(fin_ccy)
    bvps = num(i.get("bookValue"))
    if bvps is not None and fx:
        bvps *= fx
    elif fin_ccy != "IDR":
        bvps = None

    # EPS dari Yahoo sudah dalam IDR; turunkan dari PER agar konsisten dengan harga.
    pe = num(i.get("trailingPE"))
    eps = price / pe if pe else num(i.get("trailingEps"))

    # Dividen 12 bulan terakhir dari riwayat pembayaran (dalam IDR).
    dps = None
    try:
        divs = t.dividends
        if len(divs):
            cutoff = datetime.now(timezone.utc) - timedelta(days=365)
            dps = float(divs[divs.index >= cutoff.astimezone(divs.index.tz)].sum())
    except Exception:
        pass

    roe = num(i.get("returnOnEquity"))
    if roe is None and eps is not None and bvps:
        roe = eps / bvps

    # Arus kas, EBITDA & utang dalam mata uang laporan -> IDR (per saham bila perlu).
    shares = num(i.get("sharesOutstanding"))
    fcf, ebitda = num(i.get("freeCashflow")), num(i.get("ebitda"))
    debt, cash = num(i.get("totalDebt")), num(i.get("totalCash"))
    fcfps = fcf * fx / shares if fcf is not None and fx and shares else None
    net_debt = (debt or 0) * fx - (cash or 0) * fx if fx and (debt is not None or cash is not None) else None

    try:
        hist = history_multiples(t, fin_ccy)
    except Exception:
        hist = {"histPbv": None, "histPe": None, "histYears": []}

    return {
        **hist,
        "fcfps": fcfps,
        "ebitda": ebitda * fx if ebitda is not None and fx else None,
        "netDebt": net_debt,
        "shares": shares,
        "code": code,
        "name": i.get("longName") or i.get("shortName") or code,
        "sector": i.get("sector") or "Lainnya",
        "industry": i.get("industry") or "",
        "price": price,
        "bvps": bvps,
        "eps": eps,
        "fwdEps": num(i.get("forwardEps")),
        "dps": dps,
        "roe": roe,
        "payout": num(i.get("payoutRatio")),
        "epsGrowth": num(i.get("earningsGrowth")),
        "revGrowth": num(i.get("revenueGrowth")),
        "der": num(i.get("debtToEquity")),
        "mcap": num(i.get("marketCap")),
        "low52": num(i.get("fiftyTwoWeekLow")),
        "high52": num(i.get("fiftyTwoWeekHigh")),
        "finCcy": fin_ccy,
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
        return 502, {"error": f"Gagal mengambil data {code}: {e}"}
    _cache[code] = (time.time(), stock)
    return 200, {"stock": stock, "cached": False}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        code = parse_qs(urlparse(self.path).query).get("code", [""])[0]
        status, payload = scan(code)
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if status == 200:
            self.send_header("Cache-Control", f"public, s-maxage={CACHE_TTL}")
        self.end_headers()
        self.wfile.write(body)
