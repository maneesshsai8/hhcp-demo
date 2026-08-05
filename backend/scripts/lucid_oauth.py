"""
One-time helper to obtain a Lucid REFRESH TOKEN for Approach 2 (token-based embeds).

You run this once. It never goes in the app. Secrets stay in your shell / .env.

Prereqs (do these in your Lucid account at developer.lucid.co):
  1. Create an OAuth 2.0 client → note the Client ID and Client Secret.
  2. Add a redirect URI of exactly:  http://localhost:5599/callback
  3. Give the client the scopes: offline_access  lucidchart.document.app.picker

Usage:
  export LUCID_CLIENT_ID=...     LUCID_CLIENT_SECRET=...
  python scripts/lucid_oauth.py
Then open the printed URL, authorize, and it prints LUCID_REFRESH_TOKEN=...
Paste that line into backend/.env (git-ignored) and restart the backend.
"""
import os, sys, urllib.parse, webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
import httpx

CID = os.environ.get("LUCID_CLIENT_ID"); CSEC = os.environ.get("LUCID_CLIENT_SECRET")
REDIRECT = "http://localhost:5599/callback"
SCOPES = "offline_access lucidchart.document.app.picker"

if not CID or not CSEC:
    sys.exit("Set LUCID_CLIENT_ID and LUCID_CLIENT_SECRET in your environment first.")

auth_url = "https://lucid.app/oauth2/authorize?" + urllib.parse.urlencode({
    "client_id": CID, "redirect_uri": REDIRECT, "scope": SCOPES,
    "response_type": "code",
})
print("\nOpen this URL and authorize:\n", auth_url, "\n")
try: webbrowser.open(auth_url)
except Exception: pass

code_holder = {}
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.urlparse(self.path).query
        code_holder["code"] = urllib.parse.parse_qs(q).get("code", [None])[0]
        self.send_response(200); self.end_headers()
        self.wfile.write(b"Done — you can close this tab and return to the terminal.")
    def log_message(self, *a): pass

HTTPServer(("localhost", 5599), H).handle_request()
code = code_holder.get("code")
if not code: sys.exit("No authorization code received.")

resp = httpx.post("https://api.lucid.co/oauth2/token", json={
    "grant_type": "authorization_code", "code": code,
    "client_id": CID, "client_secret": CSEC, "redirect_uri": REDIRECT,
}, timeout=20)
resp.raise_for_status()
data = resp.json()
print("\n=== Add these to backend/.env (git-ignored) ===")
print(f"LUCID_CLIENT_ID={CID}")
print(f"LUCID_CLIENT_SECRET={CSEC}")
print(f"LUCID_REFRESH_TOKEN={data.get('refresh_token')}")
print("LUCID_API_VERSION=1")
print("LUCID_EMBED_ORIGIN=http://localhost:3002")
