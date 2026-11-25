"""
server.py — Vapour local dev server
Serves files with no-cache headers so the browser always fetches the latest version.
Run: python server.py
"""
import http.server
import socketserver
import os

PORT = 3000
ROOT = os.path.dirname(os.path.abspath(__file__))

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Force browser to always revalidate — no stale cache
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma",        "no-cache")
        self.send_header("Expires",       "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()}  {fmt % args}")

with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"\n  ☁  Vapour dev server running at http://localhost:{PORT}\n")
    httpd.serve_forever()
