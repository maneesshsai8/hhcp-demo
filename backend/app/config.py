"""
Demo configuration. In a real deployment these would come from environment
variables / a secrets manager (e.g. Vercel + Supabase env vars) — hardcoded
here only because this is a local, throwaway demo database with no real data.
"""

DATABASE_URL = "postgresql://hhcp_app:demo_password_local_only@localhost:5432/hhcp_demo"

JWT_SECRET = "demo-only-secret-do-not-use-in-production-1234567890"
JWT_ALGORITHM = "HS256"

ACCESS_TOKEN_LIFETIME_MINUTES = 15   # short-lived on purpose (see Foundation tech direction doc)
REFRESH_TOKEN_LIFETIME_DAYS = 14
