"use client";
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getStoredAuth, clearAuth, apiFetch, switchTenant as apiSwitchTenant } from "./api";

const AuthContext = createContext(null);

// Mirrors backend app/permissions.py — the backend is authoritative; this only
// gates the UI so users aren't shown buttons that would 403.
const ROLE_PERMISSIONS = {
  fund_admin: ["view", "create", "edit", "delete", "provision"],
  lead_partner: ["view", "create", "edit", "delete"],
  deal_qb: ["view", "create", "edit", "delete"],
  portco_management: ["view", "create", "edit", "delete"],
  ops_qb: ["view", "create", "edit"],
  addon_management: ["view", "create", "edit"],
};

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, accessibleTenants: [], activeTenantId: null });
  const router = useRouter();

  const load = useCallback(async () => {
    const auth = getStoredAuth();
    if (!auth?.access_token) {
      setState({ loading: false, user: null, accessibleTenants: [], activeTenantId: null });
      return;
    }
    try {
      const me = await apiFetch("/auth/me");
      setState({
        loading: false,
        user: me.user,
        accessibleTenants: me.accessible_tenants,
        activeTenantId: me.active_tenant_id,
      });
    } catch (e) {
      clearAuth();
      setState({ loading: false, user: null, accessibleTenants: [], activeTenantId: null });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const doSwitch = async (tenantId) => {
    await apiSwitchTenant(tenantId);
    setState((s) => ({ ...s, activeTenantId: tenantId }));
  };

  const logout = () => {
    clearAuth();
    setState({ loading: false, user: null, accessibleTenants: [], activeTenantId: null });
    router.push("/login");
  };

  // Effective role for the tenant the user is currently "standing inside".
  // In fund-admin rollup mode (no active tenant) they have fund_admin powers.
  const activeTenant = state.accessibleTenants.find((t) => t.id === state.activeTenantId);
  const activeRole = activeTenant?.role || (state.user?.is_fund_admin ? "fund_admin" : null);
  const can = (action) => (ROLE_PERMISSIONS[activeRole] || []).includes(action);

  return (
    <AuthContext.Provider value={{ ...state, activeRole, can, switchTenant: doSwitch, logout, reload: load }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
