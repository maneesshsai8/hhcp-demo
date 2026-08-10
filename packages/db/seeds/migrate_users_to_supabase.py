"""
Migrate every app user into Supabase Auth and link users.supabase_uid.

Idempotent: if a Supabase account for the email already exists, it reuses it.
Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env. All demo
users get password Demo1234!, auto-confirmed.
"""
import json
import os
import ssl
import urllib.request
import urllib.error
from pathlib import Path

import certifi
import psycopg2

# load backend/.env
for line in (Path(__file__).resolve().parent.parent / "backend" / ".env").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())

URL = os.environ["SUPABASE_URL"]
SR = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
CTX = ssl.create_default_context(cafile=certifi.where())
HDR = {"apikey": SR, "Authorization": f"Bearer {SR}", "Content-Type": "application/json"}
PASSWORD = "Demo1234!"


def _req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}{path}", data=data, headers=HDR, method=method)
    try:
        with urllib.request.urlopen(req, context=CTX) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def list_supabase_users():
    _, d = _req("GET", "/auth/v1/admin/users")
    return {u["email"].lower(): u["id"] for u in d.get("users", [])}


def main():
    conn = psycopg2.connect(dbname="hhcp_demo")
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute("SELECT email, supabase_uid FROM users ORDER BY email")
    app_users = cur.fetchall()

    existing = list_supabase_users()
    print(f"Supabase already has {len(existing)} user(s)\n")

    for email, existing_uid in app_users:
        key = email.lower()
        if key in existing:
            sub = existing[key]
            status = "already in Supabase"
        else:
            code, res = _req("POST", "/auth/v1/admin/users",
                             {"email": email, "password": PASSWORD, "email_confirm": True})
            if code in (200, 201) and res.get("id"):
                sub = res["id"]; status = "created"
            else:
                print(f"  ✗ {email:38s} — could NOT create ({code}: {res.get('msg') or res.get('error_code') or res})")
                continue

        cur.execute("UPDATE users SET supabase_uid = %s WHERE email = %s", (sub, email))
        print(f"  ✓ {email:38s} — {status}, linked supabase_uid")

    print("\nDone. All linked users can now log in through Supabase (password:", PASSWORD + ").")


if __name__ == "__main__":
    main()
