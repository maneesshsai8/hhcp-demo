import { AUTH_PROVIDER, supabase } from "./supabase";

// Which backend to talk to. Defaults to the Python backend (:8000); set
// NEXT_PUBLIC_API_BASE=http://localhost:8001 in .env.local to use the Node
// (NestJS) backend. This is the single env-driven switch from the migration
// plan (docs/BACKEND-MIGRATION-ANALYSIS.md §9) — same contracts either way.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";

/*
 Two auth providers, chosen by NEXT_PUBLIC_AUTH_PROVIDER:

 - 'local'    : the backend sets httpOnly cookies; we send `credentials: include`
                and touch no tokens.
 - 'supabase' : Supabase Auth owns login + token refresh (supabase-js). We attach
                the current Supabase access token as a Bearer header; the backend
                verifies it via JWKS. Active tenant is a separate header.
                (Production note: swap supabase-js for @supabase/ssr to keep the
                session in httpOnly cookies instead of localStorage.)
*/

function getActiveTenant() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("hhcp_active_tenant") || null;
}
export function setActiveTenant(id) {
  if (id) window.localStorage.setItem("hhcp_active_tenant", id);
  else window.localStorage.removeItem("hhcp_active_tenant");
}

async function authHeaders() {
  // The access token lives in an httpOnly cookie (both providers) — never a
  // Bearer header. Only the active-tenant hint travels in a header, in supabase
  // mode (in local mode it's baked into the token).
  const h = {};
  if (AUTH_PROVIDER === "supabase") {
    const t = getActiveTenant();
    if (t) h["X-Active-Tenant"] = t;
  }
  return h;
}

async function doRefresh() {
  const path = AUTH_PROVIDER === "supabase" ? "/auth/supabase-refresh" : "/auth/refresh";
  const res = await fetch(`${API_BASE}${path}`, { method: "POST", credentials: "include" });
  if (!res.ok) throw new Error("refresh failed");
  return res.json();
}

export async function apiFetch(path, options = {}) {
  const attempt = async () =>
    fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(await authHeaders()), ...(options.headers || {}) },
    });

  let res = await attempt();
  if (res.status === 401) {
    // Access cookie expired → backend refreshes it (from the httpOnly refresh
    // cookie), then retry once.
    try {
      await doRefresh();
      res = await attempt();
    } catch {
      /* fall through */
    }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function apiDownload(path, filename) {
  let res = await fetch(`${API_BASE}${path}`, { credentials: "include", headers: await authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Export failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Hand a Supabase session to the backend, which stores it in httpOnly cookies.
async function establishSupabaseSession(session) {
  const res = await fetch(`${API_BASE}/auth/supabase-session`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.detail || "Could not establish session");
  }
}

/** Start an OAuth login (Google/Microsoft/etc). Redirects to the provider. */
export async function loginWithOAuth(provider) {
  if (!(AUTH_PROVIDER === "supabase" && supabase)) throw new Error("OAuth requires Supabase auth");
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${window.location.origin}/auth/callback` },
  });
  if (error) throw new Error(error.message);
}

/** Finish an OAuth login on /auth/callback: read the tokens from the URL #hash
    (implicit flow), hand them to the backend, then scrub them from the URL. */
export async function completeOAuth() {
  if (!(AUTH_PROVIDER === "supabase" && supabase)) throw new Error("OAuth requires Supabase auth");

  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const search = new URLSearchParams(window.location.search);

  // provider/Supabase error came back?
  const errDesc = hash.get("error_description") || search.get("error_description");
  if (errDesc) throw new Error(errDesc);

  const access_token = hash.get("access_token");
  const refresh_token = hash.get("refresh_token");
  if (!access_token) throw new Error("No token in callback URL");

  await establishSupabaseSession({ access_token, refresh_token });
  // remove the tokens from the address bar / history
  window.history.replaceState({}, "", "/auth/callback");
}

/** Send an SMS one-time passcode to a phone number (E.164, e.g. +14155550123). */
export async function sendSmsOtp(phone) {
  if (!(AUTH_PROVIDER === "supabase" && supabase)) throw new Error("SMS OTP requires Supabase auth");
  const { error } = await supabase.auth.signInWithOtp({ phone });
  if (error) throw new Error(error.message);
}

/** Verify the SMS code and establish the httpOnly session. */
export async function verifySmsOtp(phone, token) {
  if (!(AUTH_PROVIDER === "supabase" && supabase)) throw new Error("SMS OTP requires Supabase auth");
  const { data, error } = await supabase.auth.verifyOtp({ phone, token, type: "sms" });
  if (error) throw new Error(error.message);
  await establishSupabaseSession(data.session);
}

export async function login(email, password) {
  if (AUTH_PROVIDER === "supabase" && supabase) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    await establishSupabaseSession(data.session);
    return {}; // /auth/me populates the app state
  }
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || "Login failed");
  }
  return res.json();
}

export async function switchTenant(tenantId) {
  if (AUTH_PROVIDER === "supabase") {
    // Active tenant is client-side state sent as a header; the backend still
    // scopes every query via RLS, so an out-of-grant value just returns nothing.
    setActiveTenant(tenantId);
    return { active_tenant_id: tenantId };
  }
  return apiFetch("/auth/switch-tenant", { method: "POST", body: JSON.stringify({ tenant_id: tenantId }) });
}

export async function logout() {
  setActiveTenant(null);
  // Backend clears the httpOnly cookies (both providers).
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {
    /* best effort */
  }
  if (AUTH_PROVIDER === "supabase" && supabase) {
    try { await supabase.auth.signOut(); } catch {}
  }
}

export { API_BASE };
