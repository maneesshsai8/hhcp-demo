"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

/* ------------------------------------------------------------------
   Group the flat tenant list into a parent -> children map so add-ons
   render nested under their PortCo. A node is a visual root when it has
   no parent, OR its parent isn't visible to this user (e.g. Priya sees
   Restaurant A but not the Fund above it).
------------------------------------------------------------------ */
function buildTree(tenants) {
  const visibleIds = new Set(tenants.map((t) => t.id));
  const byParent = {};
  tenants.forEach((t) => {
    const key = t.parent_tenant_id && visibleIds.has(t.parent_tenant_id) ? t.parent_tenant_id : "root";
    (byParent[key] = byParent[key] || []).push(t);
  });
  return byParent;
}

function Chevron({ open }) {
  return (
    <svg className={`chev ${open ? "open" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* recursively render a switchable tenant node + its descendants */
function TenantNodes({ nodes, byParent, activeTenantId, onSelect }) {
  return nodes.map((node) => (
    <div key={node.id}>
      <button
        className={`ws-item ${node.tenant_type} ${node.id === activeTenantId ? "active" : ""}`}
        onClick={() => onSelect(node.id)}
      >
        <span className="ws-dot" />
        <span className="ws-item-name">{node.name}</span>
        <span className="ws-tier">{node.tenant_type}</span>
        {node.id === activeTenantId && <span className="ws-check">✓</span>}
      </button>
      {byParent[node.id] && (
        <TenantNodes nodes={byParent[node.id]} byParent={byParent} activeTenantId={activeTenantId} onSelect={onSelect} />
      )}
    </div>
  ));
}

const ICONS = {
  scorecards: "M4 19V5m0 14h16M8 15v-4m4 4V8m4 7v-6",
  rocks: "M3 20h18L14 6l-4 7-2-3-5 10z",
  todos: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  issues: "M12 8v5m0 3h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  meetings: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  accountability: "M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 7v4M12 11H5v4M12 11h7v4",
  admin: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 3.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8a1.65 1.65 0 0 0 1.51 1H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
};
function NavIcon({ name }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path d={ICONS[name]} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MODULES = [
  { href: "/dashboard/scorecards", label: "Scorecard", icon: "scorecards" },
  { href: "/dashboard/rocks", label: "Rocks", icon: "rocks" },
  { href: "/dashboard/todos", label: "To-Dos", icon: "todos" },
  { href: "/dashboard/issues", label: "Issues", icon: "issues" },
  { href: "/dashboard/meetings", label: "Meetings", icon: "meetings" },
  { href: "/dashboard/accountability", label: "Accountability Chart", icon: "accountability" },
];

export default function DashboardLayout({ children }) {
  const { loading, user, accessibleTenants, activeTenantId, activeRole, switchTenant, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const [wsOpen, setWsOpen] = useState(false);       // workspace dropdown open?
  const [portcoOpen, setPortcoOpen] = useState(true); // admin's "PortCos" section expanded?
  const switcherRef = useRef(null);

  // close the dropdown on outside click
  useEffect(() => {
    function onDoc(e) {
      if (switcherRef.current && !switcherRef.current.contains(e.target)) setWsOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) return <div style={{ padding: 40 }} className="loading-line">Loading...</div>;

  const byParent = buildTree(accessibleTenants);
  const roots = byParent["root"] || [];
  const activeTenant = accessibleTenants.find((t) => t.id === activeTenantId);
  const currentLabel = activeTenant ? activeTenant.name : "All PortCos · Rollup";

  const choose = (id) => {
    switchTenant(id).catch(() => {});
    setWsOpen(false);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand-row">
          <span className="brand-mark">HH</span>
          <div>
            <p className="sidebar-brand">Hidden Harbor</p>
            <p className="sidebar-brand-sub">Operating System</p>
          </div>
        </div>

        {/* ---------- Workspace / PortCo switcher (the ⌄ dropdown) ---------- */}
        <div className="ws-switcher" ref={switcherRef}>
          <button className={`ws-current ${wsOpen ? "open" : ""}`} onClick={() => setWsOpen((o) => !o)}>
            <span className="ws-current-text">
              <span className="ws-current-name">{currentLabel}</span>
              <span className="ws-current-role">{activeRole ? activeRole.replace(/_/g, " ") : (user.is_fund_admin ? "fund admin" : "no access")}</span>
            </span>
            <Chevron open={wsOpen} />
          </button>

          {wsOpen && (
            <div className="ws-panel">
              {user.is_fund_admin ? (
                <>
                  {/* Tier 1 rollup */}
                  <button
                    className={`ws-item rollup ${activeTenantId === null ? "active" : ""}`}
                    onClick={() => choose(null)}
                  >
                    <span className="ws-dot rollup-dot" />
                    <span className="ws-item-name">All PortCos</span>
                    <span className="ws-tier">rollup</span>
                    {activeTenantId === null && <span className="ws-check">✓</span>}
                  </button>

                  {/* Admin-only: the expandable "PortCos" option */}
                  <button className="ws-group-toggle" onClick={() => setPortcoOpen((o) => !o)}>
                    <Chevron open={portcoOpen} />
                    <span>PortCos</span>
                    <span className="ws-count">{accessibleTenants.filter((t) => t.tenant_type !== "fund").length}</span>
                  </button>
                  {portcoOpen && (
                    <div className="ws-group-body">
                      <TenantNodes nodes={roots} byParent={byParent} activeTenantId={activeTenantId} onSelect={choose} />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="ws-group-label">Your PortCos</p>
                  <TenantNodes nodes={roots} byParent={byParent} activeTenantId={activeTenantId} onSelect={choose} />
                </>
              )}
            </div>
          )}
        </div>

        {/* ---------- Module navigation ---------- */}
        <nav className="nav">
          {MODULES.map((m) => (
            <button
              key={m.href}
              className={`nav-item ${pathname === m.href ? "active" : ""}`}
              onClick={() => router.push(m.href)}
            >
              <NavIcon name={m.icon} />
              <span>{m.label}</span>
            </button>
          ))}
          {user.is_fund_admin && (
            <>
              <div className="nav-divider" />
              <button
                className={`nav-item ${pathname === "/dashboard/admin" ? "active" : ""}`}
                onClick={() => router.push("/dashboard/admin")}
              >
                <NavIcon name="admin" />
                <span>Admin</span>
              </button>
            </>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="avatar">{user.name.split(" ").map((s) => s[0]).slice(0, 2).join("")}</div>
          <div className="footer-id">
            <p className="sidebar-user">{user.name}</p>
            <button className="link-muted" onClick={logout}>Sign out</button>
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="topbar-context">
            <span className="ctx-label">Viewing</span>
            <strong>{activeTenant ? activeTenant.name : "Portfolio rollup"}</strong>
            {activeTenant && <span className="ctx-tier">{activeTenant.tenant_type}</span>}
          </div>
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
