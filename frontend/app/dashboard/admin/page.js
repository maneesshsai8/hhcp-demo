"use client";
import { useEffect, useState, useCallback, Fragment } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import MultiSelect from "@/components/MultiSelect";

const TENANT_ROLES = ["lead_partner", "deal_qb", "ops_qb", "deal_team", "pog_member", "portco_management", "addon_management", "manager", "team_member", "read_only"];

// Order tenants as a Fund → PortCo → Add-on tree and tag each with its depth,
// so a <select> can show the hierarchy with indentation.
function hierarchy(orgs) {
  const byParent = {};
  orgs.forEach((o) => { const p = o.parent_tenant_id || "root"; (byParent[p] ||= []).push(o); });
  const out = [];
  (function walk(parentId, depth) {
    (byParent[parentId] || []).slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((o) => {
      out.push({ ...o, depth });
      walk(o.id, depth + 1);
    });
  })("root", 0);
  return out;
}
function TenantOptions({ orgs, includeFund = true }) {
  return hierarchy(orgs)
    .filter((o) => includeFund || o.tenant_type !== "fund")
    .map((o) => (
      <option key={o.id} value={o.id}>
        {"   ".repeat(o.depth)}{o.depth > 0 ? "› " : ""}{o.name} ({o.tenant_type})
      </option>
    ));
}

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
  const [audit, setAudit] = useState([]);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [section, setSection] = useState("portcos");   // admin sub-sidebar selection

  const loadAll = useCallback(async () => {
    try {
      const [o, u, g, t, a] = await Promise.all([
        apiFetch("/organizations"),
        apiFetch("/users"),
        apiFetch("/organizations/grants"),
        apiFetch("/teams"),
        apiFetch("/audit?limit=100").catch(() => []),
      ]);
      setOrgs(o); setUsers(u); setGrants(g); setTeams(t); setAudit(a);
    } catch (e) { setErr(e.message); }
  }, []);

  // Fund admins can manage; fund viewers get a read-only dashboard.
  const canManage = !!user?.is_fund_admin;
  const readOnly = !!user?.is_fund_viewer && !user?.is_fund_admin;

  useEffect(() => {
    if (user && !user.is_fund_admin && !user.is_fund_viewer) { router.replace("/dashboard/scorecards"); return; }
    loadAll();
  }, [user, loadAll, router]);

  const flash = (m) => { setMsg(m); setErr(""); setTimeout(() => setMsg(""), 3500); };
  const fail = (e) => { setErr(e.message || String(e)); };

  // ---- forms state ----
  const [org, setOrg] = useState({ name: "", tenant_type: "portco", parent_tenant_id: "", fund_label: "", acquisition_date: "", transaction_type: "", initial_user_ids: [], initial_role: "ops_qb" });
  const [nu, setNu] = useState({ name: "", email: "", password: "Demo1234!", is_fund_admin: false, is_fund_viewer: false, title: "", department: "", reports_to: "" });
  const [grant, setGrant] = useState({ user_id: "", tenant_ids: [], role: "ops_qb" });
  const [team, setTeam] = useState({ tenant_id: "", name: "", member_ids: [] });
  const [teamPeople, setTeamPeople] = useState([]);     // members of the tenant picked in "New team"
  const [expanded, setExpanded] = useState(null);       // team_id whose members are shown
  const [expMembers, setExpMembers] = useState([]);     // members of the expanded team
  const [expPeople, setExpPeople] = useState([]);       // assignable people in the expanded team's tenant
  const [addSel, setAddSel] = useState([]);             // user_ids selected to add to the expanded team
  const [editId, setEditId] = useState(null);      // org being edited
  const [ev, setEv] = useState({});                // edit values
  const [uEditId, setUEditId] = useState(null);    // user being edited
  const [uev, setUev] = useState({});              // user edit values
  const [csv, setCsv] = useState("");              // CSV bulk-import text

  function startEdit(o) {
    setEditId(o.id);
    setEv({ name: o.name, fund_label: o.fund_label || "", acquisition_date: o.acquisition_date || "",
            transaction_type: o.transaction_type || "", exit_date: o.exit_date || "" });
  }
  async function saveOrg(id) {
    try {
      await apiFetch(`/organizations/${id}`, { method: "PATCH", body: JSON.stringify({
        name: ev.name || null, fund_label: ev.fund_label || null, acquisition_date: ev.acquisition_date || null,
        transaction_type: ev.transaction_type || null, exit_date: ev.exit_date || null,
      })});
      setEditId(null); flash("PortCo metadata updated."); await loadAll(); await reload();
    } catch (e) { fail(e); }
  }

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
      const created = await apiFetch("/organizations", { method: "POST", body: JSON.stringify(body) });
      // Workflow step 2: configure initial admin users for the new PortCo.
      if (org.initial_user_ids.length) {
        await apiFetch("/organizations/grants", { method: "POST", body: JSON.stringify({
          user_id: org.initial_user_ids[0], role: org.initial_role, tenant_ids: [created.id],
        })});
        for (const uid of org.initial_user_ids.slice(1)) {
          await apiFetch("/organizations/grants", { method: "POST", body: JSON.stringify({
            user_id: uid, role: org.initial_role, tenant_ids: [created.id],
          })});
        }
      }
      setOrg({ name: "", tenant_type: "portco", parent_tenant_id: "", fund_label: "", acquisition_date: "", transaction_type: "", initial_user_ids: [], initial_role: "ops_qb" });
      flash(`Created ${body.tenant_type} “${body.name}”${org.initial_user_ids.length ? ` with ${org.initial_user_ids.length} initial user(s)` : ""}.`);
      await loadAll();
      await reload();            // refresh the sidebar switcher too
    } catch (e) { fail(e); }
  }

  async function createUser(e) {
    e.preventDefault();
    try {
      await apiFetch("/users", { method: "POST", body: JSON.stringify({
        ...nu, title: nu.title || null, department: nu.department || null, reports_to: nu.reports_to || null,
      })});
      setNu({ name: "", email: "", password: "Demo1234!", is_fund_admin: false, is_fund_viewer: false, title: "", department: "", reports_to: "" });
      flash(`Created user ${nu.email}.`);
      await loadAll();
    } catch (e) { fail(e); }
  }

  function startEditUser(u) {
    setUEditId(u.id);
    setUev({ name: u.name, title: u.title || "", department: u.department || "", reports_to: u.reports_to || "" });
  }
  async function saveUser(id) {
    try {
      await apiFetch(`/users/${id}`, { method: "PATCH", body: JSON.stringify({
        name: uev.name || null, title: uev.title || null, department: uev.department || null, reports_to: uev.reports_to || null,
      })});
      setUEditId(null); flash("User updated."); await loadAll();
    } catch (e) { fail(e); }
  }
  async function toggleActive(u) {
    try {
      await apiFetch(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ is_active: !u.is_active }) });
      flash(u.is_active ? `${u.name} deactivated — access revoked on next request.` : `${u.name} reactivated.`);
      await loadAll();
    } catch (e) { fail(e); }
  }
  async function importUsers(e) {
    e.preventDefault();
    if (!csv.trim()) return;
    try {
      const r = await apiFetch("/users/import", { method: "POST", body: JSON.stringify({ csv }) });
      setCsv(""); flash(`Imported ${r.created} user(s), skipped ${r.skipped}.`);
      await loadAll();
    } catch (e) { fail(e); }
  }

  async function createGrant(e) {
    e.preventDefault();
    if (!grant.user_id || !grant.tenant_ids.length) return;
    try {
      const r = await apiFetch("/organizations/grants", { method: "POST", body: JSON.stringify(grant) });
      setGrant({ user_id: "", tenant_ids: [], role: "ops_qb" });
      flash(`Granted ${grant.role.replace(/_/g, " ")} on ${r.granted} PortCo(s).`);
      await loadAll();
      await reload();
    } catch (e) { fail(e); }
  }
  const toggleGrantTenant = (id) =>
    setGrant((g) => ({ ...g, tenant_ids: g.tenant_ids.includes(id) ? g.tenant_ids.filter((x) => x !== id) : [...g.tenant_ids, id] }));
  const toggleInitialUser = (id) =>
    setOrg((o) => ({ ...o, initial_user_ids: o.initial_user_ids.includes(id) ? o.initial_user_ids.filter((x) => x !== id) : [...o.initial_user_ids, id] }));

  async function revokeGrant(id) {
    try {
      await apiFetch(`/organizations/grants/${id}`, { method: "DELETE" });
      flash("Access revoked — enforced on that user’s very next request.");
      await loadAll();
      await reload();
    } catch (e) { fail(e); }
  }

  // When a tenant is picked in the New-team form, load that tenant's members
  // for the multi-select checklist.
  async function pickTeamTenant(tenant_id) {
    setTeam({ ...team, tenant_id, member_ids: [] });
    if (!tenant_id) { setTeamPeople([]); return; }
    try { setTeamPeople(await apiFetch(`/directory?tenant_id=${tenant_id}`)); }
    catch { setTeamPeople([]); }
  }
  const toggleTeamMember = (id) =>
    setTeam((t) => ({ ...t, member_ids: t.member_ids.includes(id) ? t.member_ids.filter((x) => x !== id) : [...t.member_ids, id] }));

  async function createTeam(e) {
    e.preventDefault();
    if (!team.tenant_id) return;
    try {
      await apiFetch("/teams", { method: "POST", body: JSON.stringify(team) });
      setTeam({ tenant_id: "", name: "", member_ids: [] });
      setTeamPeople([]);
      flash("Team created with members.");
      await loadAll();
    } catch (e) { fail(e); }
  }

  // Expand a team to manage its members (add/remove).
  async function toggleExpand(t) {
    if (expanded === t.id) { setExpanded(null); return; }
    setExpanded(t.id); setAddSel([]);
    try {
      const [members, people] = await Promise.all([
        apiFetch(`/teams/${t.id}/members`),
        apiFetch(`/directory?tenant_id=${t.tenant_id}`),
      ]);
      setExpMembers(members); setExpPeople(people);
    } catch (e) { fail(e); }
  }
  async function removeMember(team_id, user_id) {
    try {
      await apiFetch(`/teams/${team_id}/members/${user_id}`, { method: "DELETE" });
      setExpMembers((m) => m.filter((x) => x.user_id !== user_id));
      await loadAll();
    } catch (e) { fail(e); }
  }
  async function addSelectedMembers(team_id) {
    try {
      for (const uid of addSel) {
        await apiFetch(`/teams/${team_id}/members`, { method: "POST", body: JSON.stringify({ user_id: uid }) });
      }
      setAddSel([]);
      setExpMembers(await apiFetch(`/teams/${team_id}/members`));
      await loadAll();
    } catch (e) { fail(e); }
  }

  const tenantName = (id) => orgs.find((o) => o.id === id)?.name || "—";

  if (user && !user.is_fund_admin && !user.is_fund_viewer) return null;

  return (
    <div>
      <h1 className="page-title display">Admin Console</h1>
      <p className="page-sub">PortCo provisioning, users, access grants, and teams — fund-level only.</p>

      {readOnly && <div className="ok-banner">👁 Read-only view — you&rsquo;re signed in as a Fund Viewer. Provisioning actions are disabled.</div>}
      {msg && <div className="ok-banner">{msg}</div>}
      {err && <div className="error-banner">{err}</div>}

      <div className="admin-layout">
        <aside className="admin-subnav">
          {[
            { key: "portcos", label: "PortCos & Add-ons", count: orgs.length },
            { key: "users", label: "Users & Directory", count: users.length },
            { key: "grants", label: "Access Grants", count: grants.length },
            { key: "teams", label: "Teams", count: teams.length },
            { key: "audit", label: "Audit Log", count: audit.length },
          ].map((s) => (
            <button key={s.key} className={`admin-subnav-item ${section === s.key ? "active" : ""}`} onClick={() => setSection(s.key)}>
              <span>{s.label}</span><span className="count">{s.count}</span>
            </button>
          ))}
        </aside>

        <div className="admin-content">

      {/* ---------------- PortCos & Add-ons ---------------- */}
      {section === "portcos" && (
      <Section title="PortCos & Add-ons" sub="Provision a PortCo workspace or link an Add-on Acquisition. Add-ons nest under a PortCo and inherit its access automatically.">
        {!readOnly && (
        <form className="admin-form" onSubmit={createOrg}>
          <div className="admin-grid">
            <label>Name<input value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} required placeholder="Restaurant D" /></label>
            <label>Type
              <select value={org.tenant_type} onChange={(e) => setOrg({ ...org, tenant_type: e.target.value })}>
                <option value="portco">PortCo</option>
                <option value="addon">Add-on Acquisition</option>
                <option value="fund">Fund</option>
              </select>
            </label>
            {org.tenant_type === "addon" && (
              <label>Parent PortCo
                <select value={org.parent_tenant_id} onChange={(e) => setOrg({ ...org, parent_tenant_id: e.target.value })} required>
                  <option value="">Select parent…</option>
                  <TenantOptions orgs={orgs} includeFund={true} />
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

          {/* Cascade preview when linking an add-on */}
          {org.tenant_type === "addon" && org.parent_tenant_id && (
            <div className="cascade-preview">
              <p className="mini-label">Access cascade preview</p>
              <p className="admin-section-sub" style={{ marginTop: 0 }}>
                This add-on will inherit access from <strong>{tenantName(org.parent_tenant_id)}</strong>.
                {(() => {
                  const inheritors = grants.filter((g) => g.tenant_id === org.parent_tenant_id);
                  return inheritors.length
                    ? <> These {inheritors.length} grant(s) will automatically see it: {inheritors.map((g) => `${g.user_name} (${g.role.replace(/_/g, " ")})`).join(", ")}.</>
                    : <> No one is granted on the parent yet, so no access cascades until you add grants below.</>;
                })()}
              </p>
            </div>
          )}

          {/* Initial admin users for a new PortCo (workflow step 2) */}
          {org.tenant_type !== "fund" && (
            <div className="member-picker">
              <div className="admin-grid">
                <label>Initial admin users <span className="fld-opt">(optional)</span>
                  <MultiSelect
                    options={users.filter((u) => !u.is_fund_admin)}
                    selected={org.initial_user_ids}
                    onToggle={toggleInitialUser}
                    placeholder="Grant access on creation…"
                    empty="No users yet."
                  />
                </label>
                {org.initial_user_ids.length > 0 && (
                  <label>Their role
                    <select value={org.initial_role} onChange={(e) => setOrg({ ...org, initial_role: e.target.value })}>
                      {TENANT_ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </div>
          )}
          <button className="btn-secondary" type="submit">Create tenant</button>
        </form>
        )}

        <table className="admin-table">
          <thead><tr><th>Name</th><th>Type</th><th>Parent</th><th>Fund</th><th>Acquired</th><th>Txn</th><th>Exit</th><th></th></tr></thead>
          <tbody>
            {orgs.map((o) => (
              editId === o.id ? (
                <tr key={o.id} className="editing-row">
                  <td><input className="mini-input" value={ev.name} onChange={(e) => setEv({ ...ev, name: e.target.value })} /></td>
                  <td><span className={`tier-tag ${o.tenant_type}`}>{o.tenant_type}</span></td>
                  <td>{o.parent_tenant_id ? tenantName(o.parent_tenant_id) : "—"}</td>
                  <td><input className="mini-input sm" value={ev.fund_label} onChange={(e) => setEv({ ...ev, fund_label: e.target.value })} /></td>
                  <td><input className="mini-input sm" type="date" value={ev.acquisition_date} onChange={(e) => setEv({ ...ev, acquisition_date: e.target.value })} /></td>
                  <td><input className="mini-input sm" value={ev.transaction_type} onChange={(e) => setEv({ ...ev, transaction_type: e.target.value })} placeholder="buyout" /></td>
                  <td><input className="mini-input sm" type="date" value={ev.exit_date} onChange={(e) => setEv({ ...ev, exit_date: e.target.value })} /></td>
                  <td className="row-actions">
                    <button className="btn-mini" onClick={() => saveOrg(o.id)}>Save</button>
                    <button className="link-muted" onClick={() => setEditId(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={o.id}>
                  <td>{o.name}</td>
                  <td><span className={`tier-tag ${o.tenant_type}`}>{o.tenant_type}</span></td>
                  <td>{o.parent_tenant_id ? tenantName(o.parent_tenant_id) : "—"}</td>
                  <td>{o.fund_label || "—"}</td>
                  <td>{o.acquisition_date || "—"}</td>
                  <td>{o.transaction_type || "—"}</td>
                  <td>{o.exit_date || "—"}</td>
                  <td className="row-actions">{!readOnly && o.tenant_type !== "fund" && <button className="btn-mini ghost" onClick={() => startEdit(o)}>Edit</button>}</td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      </Section>
      )}

      {/* ---------------- Users / Employee Directory ---------------- */}
      {section === "users" && (
      <Section title="Users & Employee Directory" sub="Create logins with title, department and reporting line. Fund admins see the whole portfolio; everyone else needs a grant below.">
        {!readOnly && (
        <form className="admin-form" onSubmit={createUser}>
          <div className="admin-grid">
            <label>Name<input value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} required placeholder="Dave Ops" /></label>
            <label>Email<input type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} required placeholder="dave@restaurantd.com" /></label>
            <label>Password<input value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} required /></label>
            <label>Title<input value={nu.title} onChange={(e) => setNu({ ...nu, title: e.target.value })} placeholder="VP Operations" /></label>
            <label>Department<input value={nu.department} onChange={(e) => setNu({ ...nu, department: e.target.value })} placeholder="Operations" /></label>
            <label>Reports to
              <select value={nu.reports_to} onChange={(e) => setNu({ ...nu, reports_to: e.target.value })}>
                <option value="">—</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label className="checkbox-label"><input type="checkbox" checked={nu.is_fund_admin} onChange={(e) => setNu({ ...nu, is_fund_admin: e.target.checked, is_fund_viewer: e.target.checked ? false : nu.is_fund_viewer })} /> Fund admin (Tier 1)</label>
            <label className="checkbox-label"><input type="checkbox" checked={nu.is_fund_viewer} disabled={nu.is_fund_admin} onChange={(e) => setNu({ ...nu, is_fund_viewer: e.target.checked })} /> Fund viewer (read-only)</label>
          </div>
          <button className="btn-secondary" type="submit">Create user</button>
        </form>
        )}

        <table className="admin-table">
          <thead><tr><th>Name</th><th>Email</th><th>Title</th><th>Dept</th><th>Reports to</th><th>Role</th><th>Grants</th><th>Status</th>{!readOnly && <th></th>}</tr></thead>
          <tbody>
            {users.map((u) => (
              uEditId === u.id ? (
                <tr key={u.id} className="editing-row">
                  <td><input className="mini-input sm" value={uev.name} onChange={(e) => setUev({ ...uev, name: e.target.value })} /></td>
                  <td>{u.email}</td>
                  <td><input className="mini-input sm" value={uev.title} onChange={(e) => setUev({ ...uev, title: e.target.value })} /></td>
                  <td><input className="mini-input sm" value={uev.department} onChange={(e) => setUev({ ...uev, department: e.target.value })} /></td>
                  <td>
                    <select className="mini-input sm" value={uev.reports_to} onChange={(e) => setUev({ ...uev, reports_to: e.target.value })}>
                      <option value="">—</option>
                      {users.filter((x) => x.id !== u.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </td>
                  <td colSpan={2}></td>
                  <td>{u.is_active ? <span className="tier-tag portco">active</span> : <span className="tier-tag addon">inactive</span>}</td>
                  <td className="row-actions">
                    <button className="btn-mini" onClick={() => saveUser(u.id)}>Save</button>
                    <button className="link-muted" onClick={() => setUEditId(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={u.id} className={u.is_active ? "" : "inactive-row"}>
                  <td>{u.name}</td><td>{u.email}</td>
                  <td>{u.title || "—"}</td><td>{u.department || "—"}</td>
                  <td>{u.reports_to_name || "—"}</td>
                  <td>{u.is_fund_admin ? <span className="tier-tag fund">fund admin</span> : u.is_fund_viewer ? <span className="tier-tag addon">fund viewer</span> : <span className="tier-tag portco">tenant user</span>}</td>
                  <td>{u.grant_count}</td>
                  <td>{u.is_active ? <span className="tier-tag portco">active</span> : <span className="tier-tag addon">inactive</span>}</td>
                  {!readOnly && (
                  <td className="row-actions">
                    <button className="btn-mini ghost" onClick={() => startEditUser(u)}>Edit</button>
                    {u.id !== user?.id && (
                      <button className={u.is_active ? "link-danger" : "link-muted"} onClick={() => toggleActive(u)}>
                        {u.is_active ? "Deactivate" : "Reactivate"}
                      </button>
                    )}
                  </td>
                  )}
                </tr>
              )
            ))}
          </tbody>
        </table>

        {!readOnly && (
        <form className="admin-form" onSubmit={importUsers} style={{ marginTop: 18 }}>
          <p className="mini-label">Bulk import (CSV)</p>
          <p className="admin-section-sub" style={{ marginTop: 0 }}>Header row: <code>name,email,title,department</code>. New users get a temporary password (<code>ChangeMe123!</code>) and should reset or use SSO. Existing emails are skipped.</p>
          <textarea className="mini-input" style={{ width: "100%", minHeight: 90, fontFamily: "monospace" }}
            value={csv} onChange={(e) => setCsv(e.target.value)}
            placeholder={"name,email,title,department\nJane Cook,jane@restaurantd.com,Line Cook,Kitchen"} />
          <button className="btn-secondary" type="submit">Import users</button>
        </form>
        )}
      </Section>
      )}

      {/* ---------------- Access Grants ---------------- */}
      {section === "grants" && (
      <Section title="Access Grants (Tier 2)" sub="Assign Lead Partner / Deal QB / Ops QB to one or more PortCos at once. Access cascades to everything underneath each one.">
        {!readOnly && (
        <form className="admin-form" onSubmit={createGrant}>
          <div className="admin-grid">
            <label>User
              <select value={grant.user_id} onChange={(e) => setGrant({ ...grant, user_id: e.target.value })} required>
                <option value="">Select user…</option>
                {users.filter((u) => !u.is_fund_admin).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label>Role
              <select value={grant.role} onChange={(e) => setGrant({ ...grant, role: e.target.value })}>
                {TENANT_ROLES.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
              </select>
            </label>
            <label>PortCos ({grant.tenant_ids.length} selected)
              <MultiSelect
                options={orgs.filter((o) => o.tenant_type !== "fund").map((o) => ({ id: o.id, name: `${o.name} (${o.tenant_type})` }))}
                selected={grant.tenant_ids}
                onToggle={toggleGrantTenant}
                placeholder="Select one or more PortCos…"
              />
            </label>
          </div>
          <button className="btn-secondary" type="submit">Grant access</button>
        </form>
        )}

        <table className="admin-table">
          <thead><tr><th>User</th><th>Tenant</th><th>Role</th>{!readOnly && <th></th>}</tr></thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>{g.user_name}</td>
                <td>{g.tenant_name} <span className={`tier-tag ${g.tenant_type}`}>{g.tenant_type}</span></td>
                <td>{g.role.replace(/_/g, " ")}</td>
                {!readOnly && <td><button className="link-danger" onClick={() => revokeGrant(g.id)}>Revoke</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      )}

      {/* ---------------- Teams ---------------- */}
      {section === "teams" && (
      <Section title="Teams" sub="Pick a tenant (shown as a Fund → PortCo → Add-on hierarchy), then tick the members to include. Manage a team any time to add or remove people.">
        {!readOnly && (
        <form className="admin-form" onSubmit={createTeam}>
          <p className="mini-label">New team</p>
          <div className="admin-grid">
            <label>Tenant
              <select value={team.tenant_id} onChange={(e) => pickTeamTenant(e.target.value)} required>
                <option value="">Select tenant…</option>
                <TenantOptions orgs={orgs} includeFund={false} />
              </select>
            </label>
            <label>Team name<input value={team.name} onChange={(e) => setTeam({ ...team, name: e.target.value })} required placeholder="Leadership Team" /></label>
          </div>
          {team.tenant_id && (
            <div className="member-picker">
              <p className="mini-label">Members ({team.member_ids.length} selected)</p>
              <MultiSelect
                options={teamPeople}
                selected={team.member_ids}
                onToggle={toggleTeamMember}
                placeholder="Select members…"
                empty="No members in this tenant yet."
              />
            </div>
          )}
          <button className="btn-secondary" type="submit">Create team</button>
        </form>
        )}

        <table className="admin-table">
          <thead><tr><th>Team</th><th>Tenant</th><th>Members</th>{!readOnly && <th></th>}</tr></thead>
          <tbody>
            {teams.map((t) => (
              <Fragment key={t.id}>
                <tr>
                  <td>{t.name}</td><td>{t.tenant_name}</td><td>{t.member_count}</td>
                  {!readOnly && <td className="row-actions"><button className="btn-mini ghost" onClick={() => toggleExpand(t)}>{expanded === t.id ? "Close" : "Manage"}</button></td>}
                </tr>
                {expanded === t.id && (
                  <tr className="editing-row">
                    <td colSpan={4}>
                      <p className="mini-label">Current members</p>
                      {expMembers.length === 0 && <p className="admin-section-sub">No members yet.</p>}
                      <div className="chip-row">
                        {expMembers.map((m) => (
                          <span key={m.user_id} className="member-chip">{m.name}
                            <button className="chip-x" title="Remove" onClick={() => removeMember(t.id, m.user_id)}>×</button>
                          </span>
                        ))}
                      </div>
                      <p className="mini-label" style={{ marginTop: 12 }}>Add members from {t.tenant_name}</p>
                      <MultiSelect
                        options={expPeople.filter((p) => !expMembers.some((m) => m.user_id === p.id))}
                        selected={addSel}
                        onToggle={(id) => setAddSel((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id])}
                        placeholder="Select members to add…"
                        empty="Everyone in this tenant is already on the team."
                      />
                      <button className="btn-mini" disabled={!addSel.length} onClick={() => addSelectedMembers(t.id)} style={{ marginTop: 8 }}>Add {addSel.length || ""} selected</button>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Section>
      )}

      {/* ---------------- Audit Log ---------------- */}
      {section === "audit" && (
      <Section title="Audit Log" sub="Compliance trail of logins, user edits, deactivations, and access grants across every tenant. Most recent first.">
        <table className="admin-table">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
          <tbody>
            {audit.length === 0 && <tr><td colSpan={5} className="admin-section-sub">No audit entries yet.</td></tr>}
            {audit.map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.created_at).toLocaleString()}</td>
                <td>{a.actor_name || "—"}</td>
                <td><span className="tier-tag portco">{a.action}</span></td>
                <td>{a.entity_type || "—"}</td>
                <td>{a.detail || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      )}

        </div>
      </div>
    </div>
  );
}
