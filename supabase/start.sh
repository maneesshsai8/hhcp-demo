#!/usr/bin/env bash
# Start local Supabase WITH OAuth provider creds loaded from supabase/.env.oauth.
# Use this instead of a bare `supabase start` (config.toml references those env vars).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f supabase/.env.oauth ]; then set -a; source supabase/.env.oauth; set +a; fi
supabase start
