"use client";
import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getStoredAuth, clearAuth, apiFetch, switchTenant as apiSwitchTenant } from "./api";

const AuthContext = createContext(null);

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

  return (
    <AuthContext.Provider value={{ ...state, switchTenant: doSwitch, logout, reload: load }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
