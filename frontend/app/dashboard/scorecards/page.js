"use client";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import CreateDrawer from "@/components/CreateDrawer";

const BLANK = {
  title: "",
  description: "",
  target_value: "",
  green_threshold: "",
  red_threshold: "",
  direction: "higher_is_better",
  frequency: "weekly",
  unit: "units",
  owner_id: "",
  group_id: "",
};

const PERIODS = [
  { key: "trends", label: "Trends" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "annual", label: "Annual" },
];

const STATUS_OPTS = [
  { key: "RED", label: "Off-track" },
  { key: "YELLOW", label: "At risk" },
  { key: "GREEN", label: "On-track" },
  { key: "NONE", label: "No recent data" },
];
const SORT_OPTS = [
  { key: "status_off", label: "Status (Off-track first)" },
  { key: "status_on", label: "Status (On-track first)" },
  { key: "az", label: "A-Z" },
  { key: "za", label: "Z-A" },
];
const DATE_RANGES = [
  { key: "13w", label: "Last 13 weeks" },
  { key: "qtd", label: "Quarter to date" },
  { key: "ytd", label: "Year to date" },
];

/* Ninety-style filter pill with a dropdown panel. */
function FilterPill({ id, label, open, setOpen, active, children }) {
  const isOpen = open === id;
  return (
    <div className="score-pill-wrap">
      <button
        className={`score-pill ${active ? "on" : ""} ${isOpen ? "open" : ""}`}
        onClick={() => setOpen(isOpen ? null : id)}
      >
        {label} <span className={`pill-caret ${isOpen ? "up" : ""}`}>⌄</span>
      </button>
      {isOpen && <div className="score-pill-menu" onClick={(e) => e.stopPropagation()}>{children}</div>}
    </div>
  );
}

const PERIOD_META = {
  weekly: { title: "Weekly KPIs", range: "Last 13 Weeks", view: "Week", count: 13, kind: "week" },
  monthly: { title: "Monthly KPIs", range: "Last 13 Months", view: "Month", count: 13, kind: "month" },
  quarterly: { title: "Quarterly KPIs", range: "Last 13 Quarters", view: "Quarter", count: 6, kind: "quarter" },
  annual: { title: "Annual KPIs", range: "Last 5 Years", view: "Year", count: 5, kind: "year" },
};

function formatValue(value, unit) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (unit === "$" || String(unit || "").toLowerCase().includes("currency")) {
    return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 });
  }
  if (unit === "%" || String(unit || "").toLowerCase().includes("percent")) return `${n.toLocaleString()}%`;
  return n.toLocaleString(undefined, { maximumFractionDigits: n % 1 ? 2 : 0 });
}

function goalText(k) {
  const op = k.direction === "lower_is_better" ? "<=" : ">=";
  return `${op} ${formatValue(k.target_value, k.unit)}`;
}

function initials(name) {
  if (!name) return "?";
  return name.split(" ").filter(Boolean).map((s) => s[0]).slice(0, 2).join("").toUpperCase();
}

function ragForValue(k, value) {
  if (value === null || value === undefined || value === "") return null;
  const actual = Number(value);
  const green = Number(k.green_threshold ?? k.target_value);
  const red = Number(k.red_threshold ?? k.target_value);
  if (!Number.isFinite(actual)) return null;
  if (k.direction === "lower_is_better") {
    if (actual <= green) return "GREEN";
    if (actual > red) return "RED";
    return "YELLOW";
  }
  if (actual >= green) return "GREEN";
  if (actual < red) return "RED";
  return "YELLOW";
}

function startOfDay(d) { const s = new Date(d); s.setHours(0, 0, 0, 0); return s; }
function endOfDay(d) { const e = new Date(d); e.setHours(23, 59, 59, 0); return e; }

function recentColumns(period) {
  const meta = PERIOD_META[period] || PERIOD_META.weekly;
  const today = new Date();
  const cols = [];
  for (let i = 0; i < meta.count; i += 1) {
    const d = new Date(today);
    let label = "", sub = "", start, end;
    if (period === "weekly") {
      d.setDate(today.getDate() - i * 7);
      end = endOfDay(d);
      start = startOfDay(d); start.setDate(d.getDate() - 6);
      label = i === 0 ? "Current Week" : start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      sub = `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
    } else if (period === "monthly") {
      d.setMonth(today.getMonth() - i);
      start = startOfDay(new Date(d.getFullYear(), d.getMonth(), 1));
      end = endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
      label = i === 0 ? "Current Month" : d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
      sub = d.toLocaleDateString(undefined, { month: "long" });
    } else if (period === "quarterly") {
      d.setMonth(today.getMonth() - i * 3);
      const qi = Math.floor(d.getMonth() / 3);
      start = startOfDay(new Date(d.getFullYear(), qi * 3, 1));
      end = endOfDay(new Date(d.getFullYear(), qi * 3 + 3, 0));
      label = i === 0 ? "Current Quarter" : `Q${qi + 1}`;
      sub = `FY ${d.getFullYear()}`;
    } else {
      d.setFullYear(today.getFullYear() - i);
      start = startOfDay(new Date(d.getFullYear(), 0, 1));
      end = endOfDay(new Date(d.getFullYear(), 11, 31));
      label = i === 0 ? "Current Year" : `FY ${d.getFullYear()}`;
      sub = `FY ${d.getFullYear()}`;
    }
    // stamp = canonical recorded_at for entries in this column: the period-end
    // date at 23:59:59 UTC. Using UTC (not local end-of-day) makes it the latest
    // instant of that calendar day regardless of the viewer's timezone, and
    // matches the seed convention — so re-entering a period upserts the same row
    // and always wins the "latest score in the period" display.
    const stamp = new Date(Date.UTC(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59)).toISOString();
    cols.push({ label, sub, current: i === 0, start, end, stamp });
  }
  return cols;
}

/** Value shown in a given column: the latest score whose date falls in the
 *  column's [start, end] range (empty string if none). Aligns entries to the
 *  right period regardless of insertion order. */
function valueInColumn(k, col) {
  let val = "";
  for (const p of k.weekly_history || []) {   // chronological → last match wins
    const d = new Date(`${p.week_ending}T12:00:00`);
    if (d >= col.start && d <= col.end) val = p.actual_value;
  }
  return val;
}

function aggregateStats(kpis) {
  const counted = kpis.filter((k) => k.current_rag);
  const total = counted.length || kpis.length || 1;
  const red = kpis.filter((k) => k.current_rag === "RED").length;
  const yellow = kpis.filter((k) => k.current_rag === "YELLOW").length;
  const green = kpis.filter((k) => k.current_rag === "GREEN").length;
  return {
    red: { count: red, pct: Math.round((red / total) * 100) },
    yellow: { count: yellow, pct: Math.round((yellow / total) * 100) },
    green: { count: green, pct: Math.round((green / total) * 100) },
  };
}

function payloadFrom(f) {
  return {
    title: f.title,
    description: f.description || null,
    target_value: Number(f.target_value || 0),
    green_threshold: f.green_threshold === "" ? Number(f.target_value || 0) : Number(f.green_threshold),
    red_threshold: f.red_threshold === "" ? Number(f.target_value || 0) : Number(f.red_threshold),
    direction: f.direction,
    frequency: f.frequency,
    unit: f.unit,
    owner_id: f.owner_id || null,
    group_id: f.group_id || null,
  };
}

export default function ScorecardsPage() {
  const { activeTenantId, can, accessibleTenants } = useAuth();
  const [kpis, setKpis] = useState(null);
  const [people, setPeople] = useState([]);
  const [groups, setGroups] = useState([]);
  const [groupDrawerOpen, setGroupDrawerOpen] = useState(false);
  const [groupForm, setGroupForm] = useState({ name: "", description: "", tenant_id: "" });
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState("trends");
  const [search, setSearch] = useState("");
  // --- ninety-style filter bar state ---
  const [statusFilter, setStatusFilter] = useState(() => new Set()); // empty = All
  const [ownerFilter, setOwnerFilter] = useState(() => new Set());   // empty = All (owner_id values)
  const [sortMode, setSortMode] = useState("status_off");            // status_off|status_on|az|za
  const [dateRange, setDateRange] = useState("13w");                 // 13w|qtd|ytd
  const [openFilter, setOpenFilter] = useState(null);                // which filter dropdown is open
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [nk, setNk] = useState(BLANK);
  const [editId, setEditId] = useState(null);
  const [scoreDraft, setScoreDraft] = useState({});

  function load() {
    apiFetch("/scorecards").then(setKpis).catch((e) => setError(e.message));
    apiFetch(`/scorecards/groups${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`)
      .then(setGroups).catch(() => setGroups([]));
  }

  async function createGroup(e) {
    e.preventDefault();
    const tid = groupForm.tenant_id || activeTenantId;   // rollup → picked in the drawer
    if (!tid || !groupForm.name.trim()) return;
    try {
      await apiFetch("/scorecards/groups", {
        method: "POST",
        body: JSON.stringify({ tenant_id: tid, name: groupForm.name, description: groupForm.description || null }),
      });
      setGroupForm({ name: "", description: "", tenant_id: "" });
      setGroupDrawerOpen(false);
      load();
    } catch (e) { setError(e.message); }
  }

  async function deleteGroup(id) {
    if (!confirm("Delete this group? Its measurables move back to the default section.")) return;
    try {
      await apiFetch(`/scorecards/groups/${id}`, { method: "DELETE" });
      load();
    } catch (e) { setError(e.message); }
  }

  useEffect(() => {
    setKpis(null);
    load();
    apiFetch(`/directory${activeTenantId ? `?tenant_id=${activeTenantId}` : ""}`).then(setPeople).catch(() => setPeople([]));
    /* eslint-disable-next-line */
  }, [activeTenantId]);

  // close any open filter dropdown on outside click / Escape
  useEffect(() => {
    if (!openFilter) return;
    function onDoc(e) {
      if (!e.target.closest?.(".score-pill-wrap")) setOpenFilter(null);
    }
    function onKey(e) { if (e.key === "Escape") setOpenFilter(null); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [openFilter]);

  function toggleInSet(setter, value) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  const tablePeriod = period === "trends" ? "weekly" : period;
  const STATUS_RANK = { RED: 0, YELLOW: 1, GREEN: 2, NONE: 3 };
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = (kpis || []).filter((k) => {
      const periodOk = tablePeriod === "quarterly" || tablePeriod === "annual" ? k.frequency !== "weekly" || true : k.frequency === tablePeriod;
      const textOk = !q || [k.title, k.description, k.owner].some((v) => String(v || "").toLowerCase().includes(q));
      const statusOk = statusFilter.size === 0 || statusFilter.has(k.current_rag || "NONE");
      const ownerOk = ownerFilter.size === 0 || ownerFilter.has(k.owner_id || "none");
      return periodOk && textOk && statusOk && ownerOk;
    });
    // Sorting is a Trends-view option (mirrors ninety); the grid keeps its
    // stored/drag order so manual reordering isn't clobbered.
    if (period === "trends") {
      arr = [...arr].sort((a, b) => {
        if (sortMode === "az") return String(a.title).localeCompare(String(b.title));
        if (sortMode === "za") return String(b.title).localeCompare(String(a.title));
        const ra = STATUS_RANK[a.current_rag || "NONE"], rb = STATUS_RANK[b.current_rag || "NONE"];
        return sortMode === "status_on" ? rb - ra : ra - rb;
      });
    }
    return arr;
    /* eslint-disable-next-line */
  }, [kpis, search, tablePeriod, period, statusFilter, ownerFilter, sortMode]);

  const columns = recentColumns(tablePeriod);
  const stats = aggregateStats(visible);

  async function createKpi(e) {
    e.preventDefault();
    if (!activeTenantId || !nk.title.trim()) return;
    try {
      await apiFetch("/scorecards", { method: "POST", body: JSON.stringify({ tenant_id: activeTenantId, ...payloadFrom(nk) }) });
      setNk(BLANK);
      setDrawerOpen(false);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function updateKpi(e) {
    e.preventDefault();
    if (!editId) return;
    try {
      await apiFetch(`/scorecards/${editId}`, { method: "PATCH", body: JSON.stringify(payloadFrom(nk)) });
      setEditId(null);
      setNk(BLANK);
      setDrawerOpen(false);
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  function openCreate(freq = tablePeriod, groupId = null) {
    setEditId(null);
    setNk({ ...BLANK, group_id: groupId || "", frequency: freq === "annual" || freq === "quarterly" ? "monthly" : freq });
    setDrawerOpen(true);
    setMenuOpen(false);
  }

  function openEdit(k) {
    setEditId(k.kpi_id);
    setNk({
      title: k.title,
      description: k.description || "",
      target_value: k.target_value,
      green_threshold: k.green_threshold ?? "",
      red_threshold: k.red_threshold ?? "",
      direction: k.direction,
      frequency: k.frequency,
      unit: k.unit || "units",
      owner_id: k.owner_id || "",
      group_id: k.group_id || "",
    });
    setDrawerOpen(true);
  }

  async function delKpi(id) {
    if (!confirm("Delete this measurable and its history?")) return;
    try {
      await apiFetch(`/scorecards/${id}`, { method: "DELETE" });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  function stamp() {
    return new Date().toISOString().slice(0, 10) + "T23:59:59Z";
  }

  async function addScore(id, value, recordedAt, draftKey) {
    if (value === undefined || String(value).trim() === "") return;
    try {
      await apiFetch(`/scorecards/${id}/scores`, {
        method: "POST",
        body: JSON.stringify({ recorded_at: recordedAt || stamp(), actual_value: Number(value) }),
      });
      setScoreDraft((prev) => {
        const next = { ...prev };
        delete next[draftKey || id];
        return next;
      });
      load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function move(idx, dir) {
    const arr = [...visible];
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    const merged = (kpis || []).map((k) => arr.find((v) => v.kpi_id === k.kpi_id) || k);
    setKpis(merged);
    try {
      await apiFetch("/scorecards/reorder", { method: "POST", body: JSON.stringify({ order: arr.map((k) => k.kpi_id) }) });
    } catch (e) {
      setError(e.message);
      load();
    }
  }

  async function exportFile(kind) {
    try {
      await apiDownload(`/reports/scorecard.${kind}?tenant_id=${activeTenantId}`, `scorecard.${kind}`);
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="score-page">
      <ScoreHeader onCreate={() => setCreateOpen(true)} />
      <CreateDrawer open={createOpen} onClose={() => setCreateOpen(false)} initialType="measurable" onCreated={() => load()} />
      <div className="score-tabs">
        {PERIODS.map((p) => (
          <button key={p.key} className={period === p.key ? "active" : ""} onClick={() => setPeriod(p.key)}>{p.label}</button>
        ))}
      </div>

      <div className="score-toolbar">
        <div className="score-filter-row">
          <button className="score-pill">Team: {activeTenantId ? "Current Workspace" : "All"} <span>⌄</span></button>
          {period !== "trends" && <button className="score-pill">View by: {PERIOD_META[tablePeriod].view} <span>⌄</span></button>}
          <FilterPill
            id="range" label={`Date Range: ${DATE_RANGES.find((r) => r.key === dateRange)?.label || "Last 13 weeks"}`}
            open={openFilter} setOpen={setOpenFilter}
          >
            {DATE_RANGES.map((r) => (
              <button key={r.key} className={`filter-opt ${dateRange === r.key ? "sel" : ""}`}
                onClick={() => { setDateRange(r.key); setOpenFilter(null); }}>{r.label}</button>
            ))}
          </FilterPill>
          {period === "trends" && (
            <>
              <FilterPill
                id="status"
                label={`Status: ${statusFilter.size === 0 ? "All" : `${statusFilter.size} selected`}`}
                active={statusFilter.size > 0} open={openFilter} setOpen={setOpenFilter}
              >
                <button className={`filter-opt check ${statusFilter.size === 0 ? "sel" : ""}`} onClick={() => setStatusFilter(new Set())}>
                  <span className="cbox">{statusFilter.size === 0 ? "✓" : ""}</span> All
                </button>
                {STATUS_OPTS.map((s) => (
                  <button key={s.key} className={`filter-opt check ${statusFilter.has(s.key) ? "sel" : ""}`}
                    onClick={() => toggleInSet(setStatusFilter, s.key)}>
                    <span className="cbox">{statusFilter.has(s.key) ? "✓" : ""}</span> {s.label}
                  </button>
                ))}
              </FilterPill>
              <FilterPill
                id="owner"
                label={`Owner: ${ownerFilter.size === 0 ? "All" : `${ownerFilter.size} selected`}`}
                active={ownerFilter.size > 0} open={openFilter} setOpen={setOpenFilter}
              >
                <button className={`filter-opt check ${ownerFilter.size === 0 ? "sel" : ""}`} onClick={() => setOwnerFilter(new Set())}>
                  <span className="cbox">{ownerFilter.size === 0 ? "✓" : ""}</span> All
                </button>
                {people.map((p) => (
                  <button key={p.id} className={`filter-opt check ${ownerFilter.has(p.id) ? "sel" : ""}`}
                    onClick={() => toggleInSet(setOwnerFilter, p.id)}>
                    <span className="cbox">{ownerFilter.has(p.id) ? "✓" : ""}</span> {p.name}
                  </button>
                ))}
              </FilterPill>
              <FilterPill
                id="sort" label={`Sort: ${SORT_OPTS.find((s) => s.key === sortMode)?.label}`}
                open={openFilter} setOpen={setOpenFilter}
              >
                {SORT_OPTS.map((s) => (
                  <button key={s.key} className={`filter-opt ${sortMode === s.key ? "sel" : ""}`}
                    onClick={() => { setSortMode(s.key); setOpenFilter(null); }}>{s.label}</button>
                ))}
              </FilterPill>
            </>
          )}
        </div>
        <div className="score-action-row">
          <button className="score-icon-btn" title="Undo">↶</button>
          <button className="score-icon-btn" title="Redo">↷</button>
          {can("create") && <button className="score-outline" onClick={() => { setGroupForm({ name: "", description: "", tenant_id: activeTenantId || "" }); setGroupDrawerOpen(true); }}>⊕ New group</button>}
          <button className="score-outline" onClick={() => setManagerOpen(true)}>Go to Measurable Manager</button>
          <button className="score-icon-btn" title="More">…</button>
          <label className="score-search">
            <span>⌕</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search Measurables..." />
          </label>
          {activeTenantId && kpis?.length > 0 && (
            <>
              <button className="score-export" onClick={() => exportFile("xlsx")}>Excel</button>
              <button className="score-export" onClick={() => exportFile("pdf")}>PDF</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!kpis && !error && <p className="loading-line">Loading scorecard...</p>}

      {kpis && period === "trends" && <TrendsView kpis={visible} stats={stats} onEdit={openEdit} />}
      {kpis && period !== "trends" && (
        <div className="score-groups">
          {[
            { key: "__implicit", title: PERIOD_META[tablePeriod].title, group: null, rows: visible.filter((k) => !k.group_id) },
            ...groups.map((g) => ({ key: g.id, title: g.name, group: g, rows: visible.filter((k) => k.group_id === g.id) })),
          ].map((section) => (
            <GridView
              key={section.key}
              title={section.title}
              group={section.group}
              kpis={section.rows}
              columns={columns}
              period={tablePeriod}
              canEdit={can("edit")}
              canCreate={can("create")}
              canDelete={can("delete")}
              openCreate={openCreate}
              setManagerOpen={setManagerOpen}
              onDeleteGroup={deleteGroup}
              move={move}
              openEdit={openEdit}
              delKpi={delKpi}
              scoreDraft={scoreDraft}
              setScoreDraft={setScoreDraft}
              addScore={addScore}
            />
          ))}
        </div>
      )}

      {drawerOpen && (
        <KpiDrawer
          f={nk}
          setF={setNk}
          people={people}
          groups={groups}
          onSubmit={editId ? updateKpi : createKpi}
          onClose={() => { setDrawerOpen(false); setEditId(null); setNk(BLANK); }}
          mode={editId ? "edit" : "create"}
        />
      )}

      {groupDrawerOpen && (
        <GroupDrawer
          f={groupForm}
          setF={setGroupForm}
          tenants={accessibleTenants}
          activeTenantId={activeTenantId}
          onSubmit={createGroup}
          onClose={() => setGroupDrawerOpen(false)}
        />
      )}

      {managerOpen && (
        <MeasurableManager
          kpis={kpis || []}
          search={search}
          setSearch={setSearch}
          onClose={() => setManagerOpen(false)}
          onEdit={(k) => { setManagerOpen(false); openEdit(k); }}
        />
      )}
    </div>
  );
}

function ScoreHeader({ onCreate }) {
  return (
    <div className="score-head">
      <div>
        <h1>Scorecard</h1>
        <p>Record and evaluate key metrics, streamlined for strategic success.</p>
      </div>
      <div className="score-head-actions">
        <button className="score-bell" aria-label="Notifications">🔔</button>
        <button className="score-create" onClick={onCreate}>Create</button>
      </div>
    </div>
  );
}

function TrendsView({ kpis, stats, onEdit }) {
  return (
    <div className="score-trends">
      <div className="score-status-card">
        <div>
          <h2>May 4 - Aug 10</h2>
          <p>Statuses are based off the 3 most recently populated scores.</p>
        </div>
        <div className="score-status-grid">
          <StatusBlock tone="red" label="Off-track" pct={stats.red.pct} count={stats.red.count} icon="!" />
          <StatusBlock tone="yellow" label="At-risk" pct={stats.yellow.pct} count={stats.yellow.count} icon="△" />
          <StatusBlock tone="green" label="On-track" pct={stats.green.pct} count={stats.green.count} icon="↗" />
        </div>
      </div>
      <div className="trend-card-grid">
        {kpis.map((k) => <TrendCard key={k.kpi_id} k={k} onEdit={() => onEdit(k)} />)}
      </div>
      {kpis.length === 0 && <EmptyScorecard />}
    </div>
  );
}

function StatusBlock({ tone, label, pct, count, icon }) {
  return (
    <div className={`score-status-block ${tone}`}>
      <p className="ssb-label">{label}</p>
      <div className="ssb-row">
        <span className="score-status-icon">{icon}</span>
        <div className="ssb-nums">
          <strong>{pct}%</strong>
          <small>{count} Measurable{count === 1 ? "" : "s"}</small>
        </div>
      </div>
    </div>
  );
}

function TrendCard({ k, onEdit }) {
  const points = k.weekly_history || [];
  const values = points.map((p) => Number(p.actual_value || 0));
  const max = Math.max(Number(k.green_threshold || k.target_value || 1), ...values, 1);
  const path = values.map((v, i) => {
    const x = 24 + i * (360 / Math.max(values.length - 1, 1));
    const y = 210 - (v / max) * 160;
    return `${i === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");
  const rag = k.current_rag || "YELLOW";

  return (
    <div className="trend-card">
      <div className="trend-card-top">
        <span className={`score-tag ${rag}`}>{rag === "RED" ? "Off-track" : rag === "YELLOW" ? "At-risk" : "On-track"}</span>
        <span className="owner-bubble">{initials(k.owner)}</span>
        <button className="score-mini-square" onClick={onEdit}>↗</button>
        <button className="score-mini-square">…</button>
      </div>
      <h3>{k.title}</h3>
      <p>{goalText(k)}</p>
      <svg className="trend-svg" viewBox="0 0 430 240" role="img">
        <line x1="24" x2="408" y1="210" y2="210" className="axis" />
        <line x1="24" x2="408" y1="110" y2="110" className="goal" />
        <line x1="24" x2="408" y1="150" y2="150" className="avg" />
        {path && <path d={path} className="actual-line" />}
        {values.map((v, i) => {
          const x = 24 + i * (360 / Math.max(values.length - 1, 1));
          const y = 210 - (v / max) * 160;
          return <circle key={i} cx={x} cy={y} r="4" className="actual-dot" />;
        })}
      </svg>
      <div className="trend-legend"><span className="dash" /> Goal <span className="dot" /> Actual <span className="line" /> Average</div>
    </div>
  );
}

function GridView(props) {
  const {
    kpis, columns, period, canEdit, canCreate, canDelete, openCreate,
    setManagerOpen, move, openEdit, delKpi, scoreDraft, setScoreDraft, addScore,
    title, group, onDeleteGroup,
  } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const groupId = group ? group.id : null;

  return (
    <div className="score-grid-card">
      <div className="score-grid-head">
        <h2>{title} <span>{kpis.length}</span></h2>
        <div className="score-grid-actions">
          {canCreate && (
            <div className="score-menu-wrap">
              <button className="score-new-btn" onClick={() => setMenuOpen(!menuOpen)}>New Measurable ⌄</button>
              {menuOpen && (
                <div className="score-new-menu">
                  <button onClick={() => { setMenuOpen(false); openCreate(period, groupId); }}><span>⊕</span>Create new Measurable</button>
                  <button onClick={() => { setMenuOpen(false); setManagerOpen(true); }}><span>⊕</span>Add existing Measurable</button>
                </div>
              )}
            </div>
          )}
          {group && canDelete && (
            <button className="score-icon-plain" title="Delete group" onClick={() => onDeleteGroup(group.id)}>🗑</button>
          )}
          <button className="score-icon-plain" title={collapsed ? "Expand" : "Collapse"} onClick={() => setCollapsed((c) => !c)}>{collapsed ? "⌄" : "⌃"}</button>
        </div>
      </div>
      {!collapsed && (
      <div className="score-table-wrap">
        <table className="score-table">
          <thead>
            <tr>
              <th className="check"><input type="checkbox" /></th>
              <th className="trend">View<br />Trend</th>
              <th className="title">Title</th>
              <th className="owner"></th>
              <th>Goal</th>
              <th>Average</th>
              <th>Total</th>
              {columns.map((c, i) => <th key={i} className={c.current ? "current" : ""}>{c.current && <span className="current-dot" />}<strong>{c.label}</strong><br /><span>{c.sub}</span></th>)}
              <th className="actions"></th>
            </tr>
          </thead>
          <tbody>
            {kpis.map((k, idx) => {
              // one value per visible column (deduped, latest-in-period) so a
              // period with more than one stored score isn't double-counted.
              const values = columns.map((c) => valueInColumn(k, c)).filter((v) => v !== "").map(Number);
              const total = values.reduce((a, b) => a + b, 0);
              const avg = values.length ? total / values.length : 0;
              return (
                <tr key={k.kpi_id}>
                  <td className="check"><input type="checkbox" /></td>
                  <td><span className={`trend-status ${k.current_rag || "NONE"}`}>{k.current_rag ? (k.current_rag === "GREEN" ? "↗" : "△") : "?"}</span></td>
                  <td className="title-cell">{canEdit && <span className="drag-handle">⋮⋮</span>}<button onClick={() => openEdit(k)}>{k.title}</button></td>
                  <td><span className="owner-bubble">{initials(k.owner)}</span></td>
                  <td>{goalText(k)}</td>
                  <td>{formatValue(avg, k.unit)}</td>
                  <td>{formatValue(total, k.unit)}</td>
                  {columns.map((col, colIdx) => {
                    const val = valueInColumn(k, col);
                    const rag = ragForValue(k, val);
                    const dkey = `${k.kpi_id}|${colIdx}`;
                    return (
                      <td key={colIdx} className={`score-cell ${rag || ""} entry-cell`}>
                        {canCreate ? (
                          <input
                            value={scoreDraft[dkey] ?? (val === "" ? "" : String(val))}
                            onChange={(e) => setScoreDraft({ ...scoreDraft, [dkey]: e.target.value })}
                            onBlur={(e) => { if (e.target.value !== (val === "" ? "" : String(val))) addScore(k.kpi_id, e.target.value, col.stamp, dkey); }}
                            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                            inputMode="decimal"
                          />
                        ) : formatValue(val, k.unit)}
                      </td>
                    );
                  })}
                  <td className="row-tools">
                    {canEdit && <button onClick={() => move(idx, -1)} disabled={idx === 0}>↑</button>}
                    {canEdit && <button onClick={() => move(idx, 1)} disabled={idx === kpis.length - 1}>↓</button>}
                    {canDelete && <button onClick={() => delKpi(k.kpi_id)}>Delete</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
      {!collapsed && kpis.length === 0 && (group ? <p className="score-empty-row">No data to show</p> : <EmptyScorecard />)}
    </div>
  );
}

function GroupDrawer({ f, setF, onSubmit, onClose, tenants = [], activeTenantId }) {
  const up = (patch) => setF({ ...f, ...patch });
  // In rollup (no active workspace) the group needs a target workspace to belong to.
  const pickable = tenants.filter((t) => t.tenant_type !== "fund");
  const needsWorkspace = !activeTenantId;
  const canSave = !!(f.name || "").trim() && !!(f.tenant_id || activeTenantId);
  return (
    <div className="score-drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="score-drawer">
        <div className="score-drawer-head">
          <h2>Create group</h2>
          <div><button onClick={onClose}>×</button></div>
        </div>
        <form onSubmit={onSubmit}>
          <label className="drawer-field">Name<input value={f.name} onChange={(e) => up({ name: e.target.value })} placeholder="e.g. Sales KPIs" required autoFocus /></label>
          {needsWorkspace && (
            <label className="drawer-field">Workspace
              <select value={f.tenant_id || ""} onChange={(e) => up({ tenant_id: e.target.value })} required>
                <option value="">Select a workspace…</option>
                {pickable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          <label className="drawer-field">Description <span>(Optional)</span>
            <textarea value={f.description} onChange={(e) => up({ description: e.target.value })} placeholder="Add a description" maxLength={300} />
          </label>
          <div className="score-drawer-footer">
            <button className="score-save" type="submit" disabled={!canSave}>Save</button>
            <button type="button" className="score-cancel" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function KpiDrawer({ f, setF, people, groups = [], onSubmit, onClose, mode }) {
  const up = (patch) => setF({ ...f, ...patch });
  return (
    <div className="score-drawer-backdrop">
      <aside className="score-drawer">
        <div className="score-drawer-head">
          <h2>{mode === "edit" ? "Edit Measurable" : "Create Measurable"}</h2>
          <div>
            <button>…</button>
            <button>♙+</button>
            <button onClick={onClose}>×</button>
          </div>
        </div>
        <form onSubmit={onSubmit}>
          <label className="drawer-field">Title<input value={f.title} onChange={(e) => up({ title: e.target.value })} required /></label>
          <label className="drawer-field">Description <span>(Optional)</span>
            <textarea value={f.description} onChange={(e) => up({ description: e.target.value })} placeholder="Add a description" />
          </label>
          <label className="drawer-field">Period Interval
            <select value={f.frequency} onChange={(e) => up({ frequency: e.target.value })}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label className="drawer-field">Group
            <select value={f.group_id} onChange={(e) => up({ group_id: e.target.value })}>
              <option value="">Default ({f.frequency === "monthly" ? "Monthly" : "Weekly"} KPIs)</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <section className="drawer-section">
            <h3>Owner</h3>
            <label className="drawer-field">Owner
              <select value={f.owner_id} onChange={(e) => up({ owner_id: e.target.value })}>
                <option value="">Unassigned</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </section>
          <section className="drawer-section">
            <h3>Goal</h3>
            <div className="drawer-two">
              <label className="drawer-field">Direction
                <select value={f.direction} onChange={(e) => up({ direction: e.target.value })}>
                  <option value="higher_is_better">Higher is better</option>
                  <option value="lower_is_better">Lower is better</option>
                </select>
              </label>
              <label className="drawer-field">Unit<input value={f.unit} onChange={(e) => up({ unit: e.target.value })} /></label>
            </div>
            <div className="drawer-three">
              <label className="drawer-field">Goal<input type="number" step="any" value={f.target_value} onChange={(e) => up({ target_value: e.target.value, green_threshold: e.target.value })} required /></label>
              <label className="drawer-field">Green<input type="number" step="any" value={f.green_threshold} onChange={(e) => up({ green_threshold: e.target.value })} /></label>
              <label className="drawer-field">Red<input type="number" step="any" value={f.red_threshold} onChange={(e) => up({ red_threshold: e.target.value })} /></label>
            </div>
          </section>
          <section className="drawer-section">
            <h3>Columns ⓘ</h3>
            <Toggle label="Show Total" text="This column shows the sum total of all the data points in this row." />
            <Toggle label="Show Average" text="This column shows the average of all the data points in this row." />
            <Toggle label="Show Goal" text="This column shows the intended goal of this measurable." />
          </section>
          <div className="score-drawer-footer">
            <button className="score-save" type="submit">{mode === "edit" ? "Save" : "Save"}</button>
            <button type="button" className="score-cancel" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function Toggle({ label, text }) {
  return (
    <div className="score-toggle-row">
      <span className="score-toggle on" />
      <div>
        <strong>{label}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function MeasurableManager({ kpis, search, setSearch, onClose, onEdit }) {
  const rows = kpis.filter((k) => !search || k.title.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="score-manager-backdrop">
      <div className="score-manager-modal">
        <div className="score-manager-head">
          <div>
            <h2>Weekly Measurables</h2>
            <p>All the Weekly Measurables in your company</p>
          </div>
          <label className="score-search modal-search"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search measurables..." /></label>
        </div>
        <button className="score-pill">Person: All <span>⌄</span></button>
        <table className="score-manager-table">
          <thead><tr><th><input type="checkbox" /></th><th>Owner</th><th>Title ↑</th><th>Teams ⓘ</th><th>Goal</th></tr></thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k.kpi_id} onDoubleClick={() => onEdit(k)}>
                <td><input type="checkbox" /></td>
                <td><span className="owner-bubble">{initials(k.owner)}</span></td>
                <td>{k.title}</td>
                <td>No team(s)</td>
                <td>{goalText(k)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="score-manager-foot">
          <span>Items per page: <button>25⌄</button></span>
          <span>1 - {rows.length} of {rows.length}</span>
          <button>‹</button><button>›</button>
          <button className="score-cancel" onClick={onClose}>Cancel</button>
          <button className="score-save" disabled>Add</button>
        </div>
      </div>
    </div>
  );
}

function EmptyScorecard() {
  return <div className="empty-state"><p className="display">No measurables here yet</p><p>Create a measurable to start tracking performance.</p></div>;
}
