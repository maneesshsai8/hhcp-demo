"use client";
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, switchTenant as apiSwitchTenant, logout as apiLogout, setActiveTenant } from "./api";

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
  deal_team: ["view", "create", "edit"],
  pog_member: ["view"],
  manager: ["view", "create", "edit", "delete"],
  team_member: ["view", "create", "edit"],
  read_only: ["view"],
};

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, accessibleTenants: [], activeTenantId: null });
  const router = useRouter();

  const load = useCallback(async () => {
    // No token to check on the client anymore — just ask the server who we are.
    // If the cookie is missing/expired (and refresh fails), this throws → logged out.
    try {
      const me = await apiFetch("/auth/me");
      // Non-admins with no active tenant (e.g. under Supabase auth, where the
      // token doesn't carry one) default into their first PortCo so the app is
      // scoped to a single tenant, like fund admins default into rollup.
      let active = me.active_tenant_id;
      if (!active && !me.user.is_fund_admin && me.accessible_tenants.length) {
        const first = me.accessible_tenants.find((t) => t.tenant_type === "portco") || me.accessible_tenants[0];
        active = first.id;
        setActiveTenant(active);
      }
      setState({
        loading: false,
        user: me.user,
        accessibleTenants: me.accessible_tenants,
        activeTenantId: active,
      });
    } catch (e) {
      setState({ loading: false, user: null, accessibleTenants: [], activeTenantId: null });
    }
  }, []);

  useEffect(() => {
    // Both providers now persist the session in an httpOnly cookie, so a single
    // /auth/me on mount restores it on reload.
    load();
  }, [load]);

  const doSwitch = async (tenantId) => {
    await apiSwitchTenant(tenantId);
    setState((s) => ({ ...s, activeTenantId: tenantId }));
  };

  const logout = async () => {
    await apiLogout();
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
