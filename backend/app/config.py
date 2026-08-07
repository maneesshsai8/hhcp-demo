"""
Configuration. Reads backend/.env when present (so secrets like the Supabase
keys stay out of the code), falling back to demo defaults for local runs.
"""
import os
from pathlib import Path


def _load_dotenv():
    env_path = Path(__file__).resolve().parent.parent / ".env"   # backend/.env
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://hhcp_app:demo_password_local_only@localhost:5432/hhcp_demo"
)

# --- our own (local) JWT auth ---
JWT_SECRET = os.getenv("JWT_SECRET", "demo-only-secret-do-not-use-in-production-1234567890")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_LIFETIME_MINUTES = 15
REFRESH_TOKEN_LIFETIME_DAYS = 14

# --- authentication provider: 'local' (self-issued JWT) or 'supabase' ---
AUTH_PROVIDER = os.getenv("AUTH_PROVIDER", "local").lower()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
# Secret used ONLY to MINT short-lived Realtime tokens (claims-scoped private
# channels). Kept separate from SUPABASE_JWT_SECRET on purpose: setting that one
# would flip verify_supabase_token() onto the HS256 path and break login (local
# user tokens are ES256/JWKS). This one just signs the realtime token we mint.
SUPABASE_REALTIME_SIGNING_SECRET = os.getenv("SUPABASE_REALTIME_SIGNING_SECRET")
SUPABASE_JWKS_URL = os.getenv("SUPABASE_JWKS_URL") or (
    f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else None
)
# Set for LOCAL Supabase (Supabase CLI), which signs tokens symmetrically (HS256)
# instead of the hosted project's asymmetric ES256/JWKS. When present, we verify
# with this shared secret; when absent, we fall back to JWKS/ES256.
SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET")

# --- Lucidchart token-based embeds (Approach 2). All secrets stay here / in .env,
#     never on the frontend. Unset in the demo → the endpoint reports 'not configured'.
LUCID_CLIENT_ID = os.getenv("LUCID_CLIENT_ID")
LUCID_CLIENT_SECRET = os.getenv("LUCID_CLIENT_SECRET")
LUCID_REFRESH_TOKEN = os.getenv("LUCID_REFRESH_TOKEN")   # obtained once via the OAuth helper
LUCID_API_VERSION = os.getenv("LUCID_API_VERSION", "1")
LUCID_EMBED_ORIGIN = os.getenv("LUCID_EMBED_ORIGIN", "http://localhost:3002")

# --- Email (announcements). Defaults target the local Supabase Mailpit catcher
#     (view sent mail at http://127.0.0.1:54324). Point at a real SMTP in prod.
SMTP_HOST = os.getenv("SMTP_HOST", "127.0.0.1")
SMTP_PORT = int(os.getenv("SMTP_PORT", "54325"))
SMTP_FROM = os.getenv("SMTP_FROM", "announcements@hhcp.local")

# ---- Calendar providers (async, best-effort; all unset in the demo) ----
GOOGLE_CALENDAR_CLIENT_ID = os.getenv("GOOGLE_CALENDAR_CLIENT_ID")
GOOGLE_CALENDAR_CLIENT_SECRET = os.getenv("GOOGLE_CALENDAR_CLIENT_SECRET")
GOOGLE_CALENDAR_REFRESH_TOKEN = os.getenv("GOOGLE_CALENDAR_REFRESH_TOKEN")
MS_CALENDAR_CLIENT_ID = os.getenv("MS_CALENDAR_CLIENT_ID")
MS_CALENDAR_CLIENT_SECRET = os.getenv("MS_CALENDAR_CLIENT_SECRET")
MS_CALENDAR_REFRESH_TOKEN = os.getenv("MS_CALENDAR_REFRESH_TOKEN")
