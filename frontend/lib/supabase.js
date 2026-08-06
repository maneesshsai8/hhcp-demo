import { createClient } from "@supabase/supabase-js";

// Flip NEXT_PUBLIC_AUTH_PROVIDER=supabase in frontend/.env.local to use Supabase
// Auth for login. Default stays 'local' so the existing demo keeps working.
export const AUTH_PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER || "local";

// In-memory storage adapter: supabase-js gets a place to put the session that is
// NOT localStorage, so the token is never persisted where JS can read it later.
// The real session lives in the backend's httpOnly cookie.
function memoryStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
}

// Realtime client — always created when the Supabase URL + anon key are present,
// independent of the auth provider. The meeting runner uses PUBLIC channels
// (broadcast + presence) so no user JWT is needed; authoritative meeting data
// still comes from the RLS-guarded REST API, and the SERVER (outbox worker) is
// the only publisher of confirmed events. Clients only send ephemeral presence
// and lightweight "nudge" hints.
export const realtime =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

export const supabase =
  AUTH_PROVIDER === "supabase" &&
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        // Implicit flow: the OAuth callback returns the tokens in the URL #hash,
        // so there's no PKCE code_verifier that would need to survive the redirect
        // (we store nothing persistent in the browser). The callback page reads the
        // hash and hands the tokens to the backend's httpOnly cookie immediately.
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          flowType: "implicit",
          storage: memoryStorage(),
        },
      })
    : null;
