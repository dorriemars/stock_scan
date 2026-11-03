"""Server lokal: menyajikan app/index.html dan endpoint /api/scan.

Pemakaian:
    .venv\\Scripts\\python.exe server.py              # buka http://localhost:8765
    .venv\\Scripts\\python.exe server.py --no-browser
"""

import json
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

APP = Path(__file__).parent / "app"
sys.path.insert(0, str(APP / "api"))
from scan import scan  # noqa: E402

HOST, PORT = "127.0.0.1", 8765


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP), **kwargs)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.rstrip("/") == "/api/scan":
            code = parse_qs(url.query).get("code", [""])[0]
            status, payload = scan(code)
            print(f"  scan {code.upper():<8} -> {status}" + (" (cache)" if payload.get("cached") else ""))
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif url.path.startswith("/api/"):
            self.send_error(404)  # jangan sajikan source code API
        else:
            super().do_GET()

    def end_headers(self):
        # Selalu ambil halaman terbaru setelah file diubah (tanpa cache browser).
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"Scanner saham berjalan di {url}  (Ctrl+C untuk berhenti)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
