const API_BASE = "http://localhost:8000";

function getStoredAuth() {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem("hhcp_auth");
  return raw ? JSON.parse(raw) : null;
}

function storeAuth(auth) {
  localStorage.setItem("hhcp_auth", JSON.stringify(auth));
}

export function clearAuth() {
  localStorage.removeItem("hhcp_auth");
}

async function doRefresh() {
  const auth = getStoredAuth();
  if (!auth?.refresh_token) throw new Error("no refresh token");

  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: auth.refresh_token }),
  });
  if (!res.ok) throw new Error("refresh failed");
  const data = await res.json();
  const updated = { ...auth, ...data };
  storeAuth(updated);
  return updated;
}

/**
 * Every authenticated call in this app goes through here. On a 401 (access
 * token expired), it transparently refreshes once and retries — the same
 * background renewal flow we designed together, just wired up client-side.
 */
export async function apiFetch(path, options = {}) {
  let auth = getStoredAuth();
  if (!auth?.access_token) throw new Error("not authenticated");

  const attempt = async (token) =>
    fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

  let res = await attempt(auth.access_token);

  if (res.status === 401) {
    auth = await doRefresh();
    res = await attempt(auth.access_token);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function login(email, password) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || "Login failed");
  }
  const data = await res.json();
  storeAuth(data);
  return data;
}

export async function switchTenant(tenantId) {
  const data = await apiFetch("/auth/switch-tenant", {
    method: "POST",
    body: JSON.stringify({ tenant_id: tenantId }),
  });
  const auth = getStoredAuth();
  storeAuth({ ...auth, access_token: data.access_token, active_tenant_id: data.active_tenant_id });
  return data;
}

export { getStoredAuth, storeAuth, API_BASE };
