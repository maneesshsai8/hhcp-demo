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
SUPABASE_JWKS_URL = os.getenv("SUPABASE_JWKS_URL") or (
    f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else None
)
