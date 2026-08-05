# HHCP Business Operating System — Entity-Relationship Diagram

Generated from the live PostgreSQL schema (`hhcp_demo`). Every box is a real
table; every line is a real foreign key. Multi-tenancy is enforced with
Row-Level Security keyed on `tenant_id → organizations.id` (not shown as it's a
policy, not a column relationship).

```mermaid
erDiagram
    organizations {
        uuid id PK
        text name
        text tenant_type "fund | portco | addon"
        uuid parent_tenant_id FK "self → tree"
        text fund_label
        date acquisition_date
        text transaction_type
        date exit_date
    }
    users {
        uuid id PK
        text email
        text name
        text password_hash
        boolean is_fund_admin "Tier 1 flag"
    }
    tenant_memberships {
        uuid id PK
        uuid user_id FK
        uuid tenant_id FK
        text role "lead_partner | deal_qb | ops_qb | *_management"
        uuid granted_by FK
    }
    teams {
        uuid id PK
        uuid tenant_id FK
        text name
    }
    team_members {
        uuid id PK
        uuid tenant_id FK
        uuid team_id FK
        uuid user_id FK
    }
    refresh_tokens {
        uuid id PK
        uuid user_id FK
        text token_hash
        timestamptz expires_at
        timestamptz revoked_at
    }
    kpis {
        uuid id PK
        uuid tenant_id FK
        uuid owner_id FK
        text title
        numeric target_value
        text comparison_operator
        text unit
    }
    kpi_scores {
        uuid kpi_id PK,FK
        timestamptz recorded_at PK
        uuid tenant_id FK
        numeric actual_value
    }
    rocks {
        uuid id PK
        uuid tenant_id FK
        uuid owner_id FK
        uuid team_id FK
        text title
        text status
        date due_date
        text description
    }
    issues {
        uuid id PK
        uuid tenant_id FK
        uuid created_by FK
        uuid team_id FK
        text title
        text status
        text priority
        timestamptz solved_at
    }
    todos {
        uuid id PK
        uuid tenant_id FK
        uuid owner_id FK
        uuid team_id FK
        text title
        text status
        boolean is_private
        date due_date
    }
    meetings {
        uuid id PK
        uuid tenant_id FK
        uuid created_by FK
        uuid team_id FK
        text agenda_key
        jsonb sections "agenda snapshot"
        text status
        timestamptz started_at
        timestamptz ended_at
        numeric rating
    }
    seats {
        uuid id PK
        uuid tenant_id FK
        uuid holder_user_id FK
        uuid parent_seat_id FK "self → chart"
        text title
        text responsibilities
    }

    organizations ||--o{ organizations : "parent"
    organizations ||--o{ tenant_memberships : "scopes"
    users        ||--o{ tenant_memberships : "granted"
    organizations ||--o{ teams : "owns"
    teams        ||--o{ team_members : "has"
    users        ||--o{ team_members : "member"
    organizations ||--o{ team_members : "scopes"
    users        ||--o{ refresh_tokens : "issued"

    organizations ||--o{ kpis : "owns"
    users        ||--o{ kpis : "owner"
    kpis         ||--o{ kpi_scores : "weekly"
    organizations ||--o{ kpi_scores : "scopes"

    organizations ||--o{ rocks : "owns"
    users        ||--o{ rocks : "owner"
    teams        ||--o{ rocks : "assigned"

    organizations ||--o{ issues : "owns"
    users        ||--o{ issues : "raised"
    teams        ||--o{ issues : "assigned"

    organizations ||--o{ todos : "owns"
    users        ||--o{ todos : "owner"
    teams        ||--o{ todos : "assigned"

    organizations ||--o{ meetings : "owns"
    users        ||--o{ meetings : "facilitator"
    teams        ||--o{ meetings : "for"

    organizations ||--o{ seats : "owns"
    users        ||--o{ seats : "holder"
    seats        ||--o{ seats : "reports to"
```

## Reading the diagram

**Three hubs everything hangs off:**
- **`organizations`** — the Fund → PortCo → Add-on tree (`parent_tenant_id` is self-referencing). Every business table carries `tenant_id → organizations.id`; RLS filters on it.
- **`users`** — deliberately has **no** tenant column. A user's access comes from `tenant_memberships` (Tier 2 grants) plus the `is_fund_admin` flag (Tier 1), which is what lets one person work across many PortCos.
- **`teams` / `team_members`** — working groups inside a tenant; Rocks / Issues / To-Dos / Meetings can be assigned to a team.

**Feature modules** (all tenant-scoped, all optionally owner/team-linked):
`kpis` + `kpi_scores` (Scorecard, append-only weekly history), `rocks`, `issues`, `todos`, `meetings` (with a JSONB agenda snapshot + timing), and `seats` (Accountability Chart, self-referencing `parent_seat_id`).

**Auth:** `refresh_tokens` backs server-side session revocation; access tokens are stateless JWTs (not stored).
