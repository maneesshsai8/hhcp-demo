"use client";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const TENANT_ROLES = ["lead_partner", "deal_qb", "ops_qb", "portco_management", "addon_management"];

function Section({ title, sub, children }) {
  return (
    <section className="admin-section">
      <div className="admin-section-head">
        <h2 className="admin-section-title display">{title}</h2>
        {sub && <p className="admin-section-sub">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

export default function AdminPage() {
  const { user, reload } = useAuth();
  const router = useRouter();

  const [orgs, setOrgs] = useState([]);
  const [users, setUsers] = useState([]);
  const [grants, setGrants] = useState([]);
  const [teams, setTeams] = useState([]);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const loadAll = useCallback(async () => {
    try {
      const [o, u, g, t] = await Promise.all([
        apiFetch("/organizations"),
        apiFetch("/users"),
        apiFetch("/organizations/grants"),
        apiFetch("/teams"),
      ]);
      setOrgs(o); setUsers(u); setGrants(g); setTeams(t);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => {
    if (user && !user.is_fund_admin) { router.replace("/dashboard/scorecards"); return; }
    loadAll();
  }, [user, loadAll, router]);

  const flash = (m) => { setMsg(m); setErr(""); setTimeout(() => setMsg(""), 3500); };
  const fail = (e) => { setErr(e.message || String(e)); };

  // ---- forms state ----
  const [org, setOrg] = useState({ name: "", tenant_type: "portco", parent_tenant_id: "", fund_label: "", acquisition_date: "", transaction_type: "" });
  const [nu, setNu] = useState({ name: "", email: "", password: "Demo1234!", is_fund_admin: false });
  const [grant, setGrant] = useState({ user_id: "", tenant_id: "", role: "ops_qb" });
  const [team, setTeam] = useState({ tenant_id: "", name: "" });
  const [tm, setTm] = useState({ team_id: "", user_id: "" });

  const parents = orgs.filter((o) => o.tenant_type !== "addon"); // add-ons hang under fund/portco

  async function createOrg(e) {
    e.preventDefault();
    try {
      const body = {
        name: org.name,
        tenant_type: org.tenant_type,
        parent_tenant_id: org.tenant_type === "addon" ? (org.parent_tenant_id || null) : null,
        fund_label: org.fund_label || null,
        acquisition_date: org.acquisition_date || null,
        transaction_type: org.transaction_type || null,
      };
      await apiFetch("/organizations", { method: "POST", body: JSON.stringify(body) });
      setOrg({ name: "", tenant_type: "portco", parent_tenant_id: "", fund_label: "", acquisition_date: "", transaction_type: "" });
      flash(`Created ${body.tenant_type} “${body.name}”.`);
      await loadAll();
      await reload();            // refresh the sidebar switcher too
    } catch (e) { fail(e); }
  }

  async function createUser(e) {
    e.preventDefault();
    try {
      await apiFetch("/users", { method: "POST", body: JSON.stringify(nu) });
      setNu({ name: "", email: "", password: "Demo1234!", is_fund_admin: false });
      flash(`Created user ${nu.email}.`);
      await loadAll();
    } catch (e) { fail(e); }
  }

  async function createGrant(e) {
    e.preventDefault();
    if (!grant.user_id || !grant.tenant_id) return;
    try {
      await apiFetch("/organizations/grants", { method: "POST", body: JSON.stringify(grant) });
      flash("Access granted.");
      await loadAll();
      await reload();
    } catch (e) { fail(e); }
  }

  async function revokeGrant(id) {
    try {
      await apiFetch(`/organizations/grants/${id}`, { method: "DELETE" });
      flash("Access revoked — enforced on that user’s very next request.");
      await loadAll();
      await reload();
    } catch (e) { fail(e); }
  }

  async function createTeam(e) {
    e.preventDefault();
    if (!team.tenant_id) return;
    try {
      await apiFetch("/teams", { method: "POST", body: JSON.stringify(team) });
      setTeam({ tenant_id: "", name: "" });
      flash("Team created.");
      await loadAll();
    } catch (e) { fail(e); }
  }

  async function addMember(e) {
    e.preventDefault();
    if (!tm.team_id || !tm.user_id) return;
    try {
      await apiFetch(`/teams/${tm.team_id}/members`, { method: "POST", body: JSON.stringify({ user_id: tm.user_id }) });
      flash("Member added to team.");
      await loadAll();
    } catch (e) { fail(e); }
  }

  const tenantName = (id) => orgs.find((o) => o.id === id)?.name || "—";

  if (user && !user.is_fund_admin) return null;

  return (
    <div>
      <h1 className="page-title display">Admin Console</h1>
      <p className="page-sub">PortCo provisioning, users, access grants, and teams — Tier 1 only.</p>

      {msg && <div className="ok-banner">{msg}</div>}
      {err && <div className="error-banner">{err}</div>}

      {/* ---------------- PortCos & Add-ons ---------------- */}
      <Section title="PortCos & Add-ons" sub="Create a new tenant in the portfolio. Add-ons nest under a PortCo or the Fund.">
        <form className="admin-form" onSubmit={createOrg}>
          <div className="admin-grid">
            <label>Name<input value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} required placeholder="Restaurant D" /></label>
            <label>Type
              <select value={org.tenant_type} onChange={(e) => setOrg({ ...org, tenant_type: e.target.value })}>
                <option value="portco">PortCo</option>
                <option value="addon">Add-on</option>
                <option value="fund">Fund</option>
              </select>
            </label>
            {org.tenant_type === "addon" && (
              <label>Parent
                <select value={org.parent_tenant_id} onChange={(e) => setOrg({ ...org, parent_tenant_id: e.target.value })} required>
                  <option value="">Select parent…</option>
                  {parents.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.tenant_type})</option>)}
                </select>
              </label>
            )}
            <label>Fund label<input value={org.fund_label} onChange={(e) => setOrg({ ...org, fund_label: e.target.value })} placeholder="Fund II" /></label>
            <label>Acquisition date<input type="date" value={org.acquisition_date} onChange={(e) => setOrg({ ...org, acquisition_date: e.target.value })} /></label>
            <label>Transaction type
              <select value={org.transaction_type} onChange={(e) => setOrg({ ...org, transaction_type: e.target.value })}>
                <option value="">—</option>
                <option value="buyout">Buyout</option>
                <option value="carveout">Carve-out</option>
                <option value="merger">Merger</option>
              </select>
            </label>
          </div>
          <button className="btn-secondary" type="submit">Create tenant</button>
        </form>

        <table className="admin-table">
          <thead><tr><th>Name</th><th>Type</th><th>Parent</th><th>Fund</th><th>Acquired</th></tr></thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id}>
                <td>{o.name}</td>
                <td><span className={`tier-tag ${o.tenant_type}`}>{o.tenant_type}</span></td>
                <td>{o.parent_tenant_id ? tenantName(o.parent_tenant_id) : "—"}</td>
                <td>{o.fund_label || "—"}</td>
                <td>{o.acquisition_date || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ---------------- Users ---------------- */}
      <Section title="Users" sub="Create logins. Fund admins see the whole portfolio; everyone else needs a grant below.">
        <form className="admin-form" onSubmit={createUser}>
          <div className="admin-grid">
            <label>Name<input value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} required placeholder="Dave Ops" /></label>
            <label>Email<input type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} required placeholder="dave@restaurantd.com" /></label>
            <label>Password<input value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required /></label>
            <label className="checkbox-label"><input type="checkbox" checked={nu.is_fund_admin} onChange={(e) => setNu({ ...nu, is_fund_admin: e.target.checked })} /> Fund admin (Tier 1)</label>
          </div>
          <button className="btn-secondary" type="submit">Create user</button>
        </form>

        <table className="admin-table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Grants</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td><td>{u.email}</td>
                <td>{u.is_fund_admin ? <span className="tier-tag fund">fund admin</span> : <span className="tier-tag portco">tenant user</span>}</td>
                <td>{u.grant_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ---------------- Access Grants ---------------- */}
      <Section title="Access Grants (Tier 2)" sub="Give a user access to a PortCo/Add-on. Access cascades to everything underneath it.">
        <form className="admin-form" onSubmit={createGrant}>
          <div className="admin-grid">
            <label>User
              <select value={grant.user_id} onChange={(e) => setGrant({ ...grant, user_id: e.target.value })} required>
                <option value="">Select user…</option>
                {users.filter((u) => !u.is_fund_admin).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label>Tenant
              <select value={grant.tenant_id} onChange={(e) => setGrant({ ...grant, tenant_id: e.target.value })} required>
                <option value="">Select tenant…</option>
                {orgs.filter((o) => o.tenant_type !== "fund").map((o) => <option key={o.id} value={o.id}>{o.name} ({o.tenant_type})</option>)}
              </select>
            </label>
            <label>Role
              <select value={grant.role} onChange={(e) => setGrant({ ...grant, role: e.target.value })}>
                {TENANT_ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
              </select>
            </label>
          </div>
          <button className="btn-secondary" type="submit">Grant access</button>
        </form>

        <table className="admin-table">
          <thead><tr><th>User</th><th>Tenant</th><th>Role</th><th></th></tr></thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>{g.user_name}</td>
                <td>{g.tenant_name} <span className={`tier-tag ${g.tenant_type}`}>{g.tenant_type}</span></td>
                <td>{g.role.replace(/_/g, " ")}</td>
                <td><button className="link-danger" onClick={() => revokeGrant(g.id)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ---------------- Teams ---------------- */}
      <Section title="Teams" sub="Create teams inside a tenant, then add users. Teams can be assigned to Rocks and Issues.">
        <div className="admin-two-col">
          <form className="admin-form" onSubmit={createTeam}>
            <p className="mini-label">New team</p>
            <div className="admin-grid">
              <label>Tenant
                <select value={team.tenant_id} onChange={(e) => setTeam({ ...team, tenant_id: e.target.value })} required>
                  <option value="">Select tenant…</option>
                  {orgs.filter((o) => o.tenant_type !== "fund").map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
              <label>Team name<input value={team.name} onChange={(e) => setTeam({ ...team, name: e.target.value })} required placeholder="Leadership Team" /></label>
            </div>
            <button className="btn-secondary" type="submit">Create team</button>
          </form>

          <form className="admin-form" onSubmit={addMember}>
            <p className="mini-label">Add member to team</p>
            <div className="admin-grid">
              <label>Team
                <select value={tm.team_id} onChange={(e) => setTm({ ...tm, team_id: e.target.value })} required>
                  <option value="">Select team…</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.tenant_name}</option>)}
                </select>
              </label>
              <label>User
                <select value={tm.user_id} onChange={(e) => setTm({ ...tm, user_id: e.target.value })} required>
                  <option value="">Select user…</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
            </div>
            <button className="btn-secondary" type="submit">Add to team</button>
          </form>
        </div>

        <table className="admin-table">
          <thead><tr><th>Team</th><th>Tenant</th><th>Members</th></tr></thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id}><td>{t.name}</td><td>{t.tenant_name}</td><td>{t.member_count}</td></tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
