# Org Structure — Lucidchart Embed (the "link out" option)

The Accountability Chart module ships with a **native** chart (drag-and-drop seats,
GWC, responsibilities, exports) AND a **Lucidchart** view, matching the spec's note
that HHCP can "link out to an existing tool like Lucidchart at no additional build
cost." Toggle between them on the Accountability Chart page.

## Approach 1 — Cookie-Based Embedding (implemented, recommended)

Relies on the viewer's own Lucid / corporate SSO session. Zero secrets on the frontend.

- **Setup (admin):** in Lucidchart → **File → Share → Embed → Activate Embed Code**,
  copy the embed URL (or the whole `<iframe>` snippet).
- On the Accountability Chart page, switch to the **Lucidchart** tab and paste it.
- Stored per-tenant as `organizations.lucid_embed_url` (migration 20). The backend
  validates the host is `lucid.app` / `lucidchart.com` and, if you paste a full
  `<iframe>`, extracts the `src` — so an admin can't accidentally frame an arbitrary
  page (`PUT /seats/embed` → 400 for non-Lucid hosts).
- Rendered as a plain iframe (`GET /seats/embed` returns the URL, no secrets):

```html
<div class="lucid-embed" style="position:relative;width:100%;height:620px">
  <iframe src="<lucid embed url>" width="100%" height="100%" frameborder="0"
          allowfullscreen loading="lazy" title="Accountability Chart (Lucidchart)"></iframe>
</div>
```

- **Access control** maps to Lucid's own permissions + corporate SSO: remove someone
  from the directory and they lose the embedded view automatically. If a viewer isn't
  logged into Lucid, Lucid shows its own secure login prompt inside the iframe.

## Approach 2 — Token-Based Embedding (IMPLEMENTED, for no-login viewers)

Use when viewers must see the chart **without a personal Lucid account**, or you need a
guarantee they never see a login prompt. Toggle **Lucidchart → Token-based (no login)**.

**Real Lucid Embed API flow** (per developer.lucid.co/docs/tutorial-token-embeds):

1. `refresh_token` (in `.env`) → **access token**: `POST https://api.lucid.co/oauth2/token`
   (`grant_type=refresh_token` + client id/secret).
2. access token → **short-lived embed session token**:
   `POST https://api.lucid.co/embeds/token` with headers `Authorization: Bearer <access>`,
   `Lucid-Api-Version: 1`, body `{ "origin": "<portal origin>", "embedId": "<doc embed id>" }`.
3. iframe src = `https://lucid.app/embeds?token=<session token>`.

The backend (`app/lucid.py`) mints a **fresh token on every view** and returns only the
final iframe URL — the Client Secret and refresh token never reach the browser. The
frontend calls `GET /seats/embed-session`; per-tenant embed id is set via
`PUT /seats/embed-id`.

### One-time setup (only you can do this — needs your Lucid account)

1. At **developer.lucid.co**, create an OAuth 2.0 client. Note the **Client ID** + **Client
   Secret**. Add redirect URI `http://localhost:5599/callback`. Grant scopes
   `offline_access` and `lucidchart.document.app.picker`.
2. Get a refresh token:
   ```bash
   cd backend
   export LUCID_CLIENT_ID=…  LUCID_CLIENT_SECRET=…
   ./venv/bin/python scripts/lucid_oauth.py        # opens Lucid, authorize, prints LUCID_* lines
   ```
3. Paste the printed lines into **`backend/.env`** (git-ignored) and restart the backend:
   ```
   LUCID_CLIENT_ID=…
   LUCID_CLIENT_SECRET=…
   LUCID_REFRESH_TOKEN=…
   LUCID_API_VERSION=1
   LUCID_EMBED_ORIGIN=http://localhost:3002
   ```
4. In the app: **Accountability Chart → Lucidchart → Token-based**, enter the tenant's
   **Lucid embed id**. Viewers now see the chart with no Lucid login.

Until those env vars are set, the endpoint returns `configured: false` and the UI shows
these setup steps instead of erroring. **Never paste the Client Secret or refresh token
into chat or the frontend** — they live only in `backend/.env`, same as the Supabase
service-role key.

## Summary

| | Approach 1 (Cookie) | Approach 2 (Token) |
|---|---|---|
| Status here | Built | Built (needs your Lucid OAuth creds in `.env`) |
| Complexity | Low (frontend only) | Medium (backend OAuth + refresh token) |
| Private keys | None | Client Secret + refresh token, backend-only |
| User login | Prompts if logged out | Never |
| Best for | Standard internal portal | No-login / non-Lucid viewers |
