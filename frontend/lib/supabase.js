import { createClient, RealtimeClient } from "@supabase/supabase-js";

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

// Realtime client for PRIVATE, tenant-scoped channels.
//
// IMPORTANT: this is a BARE RealtimeClient, not `createClient(...).realtime`.
// A full supabase-js client wires GoTrue auth into realtime and re-applies its
// own token (here: the anon key, since this client has no session) on every
// socket (re)connect — which silently clobbers our minted token and drops the
// connection back to `anon`, failing the private-channel RLS check on the next
// reconnect (network blip / tab switch / HMR). A bare RealtimeClient has no such
// wiring: the token we set via authorizeRealtime() (see lib/realtime.js) sticks
// across reconnects. The server (outbox worker) is still the only publisher of
// authoritative events; clients only send presence + lightweight nudges.
export const realtime =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? new RealtimeClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/^http/, "ws") + "/realtime/v1",
        { params: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY } },
      )
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
