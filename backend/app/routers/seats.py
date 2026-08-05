import json
import re
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from app.database import get_scoped_connection
from app.dependencies import get_current_user, CurrentUser
from app.permissions import require_permission, require_row_permission
from app import lucid

router = APIRouter(prefix="/seats", tags=["accountability-chart"])

# Only Lucid's own hosts may be embedded — prevents an admin (or a copy-paste
# mistake) from framing an arbitrary/phishing page in the portal.
_LUCID_HOSTS = {"lucid.app", "www.lucid.app", "lucidchart.com", "www.lucidchart.com"}


def _clean_embed_url(raw: str | None) -> str | None:
    """Accept a bare URL OR a pasted <iframe> snippet; return the validated
    Lucid src URL, or raise 400."""
    if not raw or not raw.strip():
        return None
    raw = raw.strip()
    m = re.search(r'src=["\']([^"\']+)["\']', raw)  # pull src out of an <iframe …> paste
    url = m.group(1) if m else raw
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in _LUCID_HOSTS:
        raise HTTPException(
            status_code=400,
            detail="Embed URL must be an https link on lucid.app or lucidchart.com "
                   "(from File → Share → Embed → Activate Embed Code).",
        )
    # A personal invitation/share token must never be embedded — it can grant access.
    if "invitationid" in (parsed.query or "").lower() or "invitationid" in url.lower():
        raise HTTPException(
            status_code=400,
            detail="That's a personal invitation link (it contains an invitationId) — don't embed it, "
                   "it can grant others access to your document. In Lucid use File → Share → Embed → "
                   "Activate Embed Code and paste THAT link instead.",
        )
    # Must be an actual embed link, not an /edit or share link.
    if "/documents/embed" not in parsed.path and "/documents/embeddedchart" not in parsed.path:
        raise HTTPException(
            status_code=400,
            detail="That looks like an edit/share link, not an embed link. In Lucid: File → Share → Embed → "
                   "Activate Embed Code — the embed URL looks like https://lucid.app/documents/embed/…",
        )
    return url


class NewSeatRequest(BaseModel):
    tenant_id: str
    title: str
    holder_user_id: str | None = None
    holder_ids: list[str] | None = None      # multiple person-to-role assignments
    parent_seat_id: str | None = None
    responsibilities: str | None = None      # up to 5 newline bullets (UI-enforced)
    gwc_gets: bool | None = None
    gwc_wants: bool | None = None
    gwc_capacity: bool | None = None


class UpdateSeatRequest(BaseModel):
    title: str | None = None
    holder_user_id: str | None = None
    holder_ids: list[str] | None = None
    parent_seat_id: str | None = None
    responsibilities: str | None = None
    gwc_gets: bool | None = None
    gwc_wants: bool | None = None
    gwc_capacity: bool | None = None


class ReparentRequest(BaseModel):
    parent_seat_id: str | None = None        # drag-and-drop: new parent (null = top level)


class PublishRequest(BaseModel):
    tenant_id: str
    label: str | None = None


class EmbedRequest(BaseModel):
    tenant_id: str
    embed_url: str | None = None      # Lucidchart embed URL (or a pasted <iframe> snippet); null clears it


class EmbedIdRequest(BaseModel):
    tenant_id: str
    embed_id: str | None = None       # Lucid embed/document id for token-based mode; null clears it


async def _sync_holders(conn, seat_id, tenant_id, holder_ids):
    """Replace a seat's holder set; return the primary (first) holder id."""
    await conn.execute("DELETE FROM seat_holders WHERE seat_id = $1", seat_id)
    seen = []
    for uid in holder_ids:
        if uid and uid not in seen:
            await conn.execute(
                "INSERT INTO seat_holders (seat_id, user_id, tenant_id) VALUES ($1, $2, $3) "
                "ON CONFLICT (seat_id, user_id) DO NOTHING",
                seat_id, uid, tenant_id,
            )
            seen.append(uid)
    return seen[0] if seen else None


@router.get("", response_model=None)
async def list_seats(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """The Accountability Chart — a flat list the UI renders (and drag-reparents) as a tree."""
    target_tenant = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """
            SELECT s.id, s.title, s.parent_seat_id, s.responsibilities, s.tenant_id, s.sort_order,
                   s.holder_user_id, u.name AS holder_name,
                   s.gwc_gets, s.gwc_wants, s.gwc_capacity,
                   COALESCE(
                     (SELECT json_agg(json_build_object('id', sh.user_id, 'name', hu.name) ORDER BY hu.name)
                      FROM seat_holders sh JOIN users hu ON hu.id = sh.user_id
                      WHERE sh.seat_id = s.id),
                     '[]'::json) AS holders
            FROM seats s
            LEFT JOIN users u ON u.id = s.holder_user_id
            WHERE ($1::uuid IS NULL OR s.tenant_id = $1::uuid)
            ORDER BY s.sort_order, s.created_at
            """,
            target_tenant,
        )
    out = []
    for r in rows:
        d = dict(r)
        d["holders"] = json.loads(d["holders"]) if isinstance(d["holders"], str) else d["holders"]
        d["gwc_score"] = sum(1 for g in (r["gwc_gets"], r["gwc_wants"], r["gwc_capacity"]) if g)
        out.append(d)
    return out


@router.get("/versions")
async def list_versions(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    target = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        rows = await conn.fetch(
            """SELECT v.id, v.label, v.seat_count, v.created_at, u.name AS created_by_name
               FROM org_chart_versions v LEFT JOIN users u ON u.id = v.created_by
               WHERE ($1::uuid IS NULL OR v.tenant_id = $1::uuid)
               ORDER BY v.created_at DESC LIMIT 25""",
            target,
        )
    return [dict(r) for r in rows]


@router.get("/embed")
async def get_embed(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """The tenant's Lucidchart embed URL (Approach 1, cookie-based) — anyone who can
    view the tenant can see it; it carries no secrets."""
    target = tenant_id or current_user.active_tenant_id
    async with get_scoped_connection(current_user.user_id) as conn:
        url = await conn.fetchval("SELECT lucid_embed_url FROM organizations WHERE id = $1", target)
    return {"embed_url": url}


@router.put("/embed")
async def set_embed(body: EmbedRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Set/clear the tenant's Lucidchart embed URL. Requires edit rights on the tenant.
    The URL is validated to a Lucid host — no API keys or secrets are involved."""
    url = _clean_embed_url(body.embed_url)
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "edit")
        await conn.execute("UPDATE organizations SET lucid_embed_url = $2 WHERE id = $1", body.tenant_id, url)
    return {"embed_url": url}


@router.put("/embed-id")
async def set_embed_id(body: EmbedIdRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Set/clear the tenant's Lucid embed/document id for TOKEN-based embeds. Edit rights required."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "edit")
        eid = (body.embed_id or "").strip() or None
        await conn.execute("UPDATE organizations SET lucid_embed_id = $2 WHERE id = $1", body.tenant_id, eid)
    return {"embed_id": eid}


@router.get("/embed-session")
async def embed_session(tenant_id: str | None = Query(default=None), current_user: CurrentUser = Depends(get_current_user)):
    """Approach 2: mint a SHORT-LIVED Lucid session token server-side and return a
    ready-to-iframe URL. Viewers need no Lucid account and never see a login prompt.
    Reports `configured: false` (not an error) when the Lucid OAuth env isn't set up,
    so the UI can explain what to do."""
    target = tenant_id or current_user.active_tenant_id
    if not lucid.is_configured():
        return {"configured": False, "reason": "Lucid OAuth credentials not set in backend .env"}
    async with get_scoped_connection(current_user.user_id) as conn:
        embed_id = await conn.fetchval("SELECT lucid_embed_id FROM organizations WHERE id = $1", target)
    if not embed_id:
        return {"configured": True, "embed_id": None}
    try:
        url = await lucid.mint_embed_url(embed_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Lucid embed session failed: {e}")
    return {"configured": True, "embed_id": embed_id, "embed_url": url}


@router.get("/{seat_id}/links")
async def seat_links(seat_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """What the seat's holder(s) own across modules — Scorecard KPIs, VCBs, and To-Dos.
    This is the 'role linked to ownership' requirement, resolved live."""
    async with get_scoped_connection(current_user.user_id) as conn:
        seat = await conn.fetchrow("SELECT tenant_id FROM seats WHERE id = $1", seat_id)
        if seat is None:
            raise HTTPException(status_code=404, detail="Seat not found or not accessible")
        holder_ids = [r["user_id"] for r in await conn.fetch(
            "SELECT user_id FROM seat_holders WHERE seat_id = $1", seat_id)]
        if not holder_ids:
            return {"kpis": [], "vcbs": [], "todos": []}
        kpis = await conn.fetch(
            "SELECT id, title FROM kpis WHERE owner_id = ANY($1::uuid[]) ORDER BY title", holder_ids)
        vcbs = await conn.fetch(
            "SELECT id, title FROM vcbs WHERE created_by = ANY($1::uuid[]) ORDER BY title", holder_ids)
        todos = await conn.fetch(
            "SELECT id, title, status FROM todos WHERE owner_id = ANY($1::uuid[]) AND status = 'open' ORDER BY due_date NULLS LAST",
            holder_ids)
    return {
        "kpis": [dict(r) for r in kpis],
        "vcbs": [dict(r) for r in vcbs],
        "todos": [dict(r) for r in todos],
    }


@router.post("")
async def create_seat(body: NewSeatRequest, current_user: CurrentUser = Depends(get_current_user)):
    holders = body.holder_ids if body.holder_ids is not None else ([body.holder_user_id] if body.holder_user_id else [])
    holders = [h for h in holders if h]
    primary = holders[0] if holders else None
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "create")
        nxt = await conn.fetchval("SELECT COALESCE(MAX(sort_order)+1, 0) FROM seats WHERE tenant_id = $1", body.tenant_id)
        row = await conn.fetchrow(
            """
            INSERT INTO seats (tenant_id, title, holder_user_id, parent_seat_id, responsibilities,
                               gwc_gets, gwc_wants, gwc_capacity, sort_order)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id, title, parent_seat_id, tenant_id
            """,
            body.tenant_id, body.title, primary, body.parent_seat_id, body.responsibilities,
            body.gwc_gets, body.gwc_wants, body.gwc_capacity, nxt,
        )
        if holders:
            await _sync_holders(conn, row["id"], body.tenant_id, holders)
    return dict(row)


@router.patch("/{seat_id}")
async def update_seat(seat_id: str, body: UpdateSeatRequest, current_user: CurrentUser = Depends(get_current_user)):
    async with get_scoped_connection(current_user.user_id) as conn:
        tenant_id = await require_row_permission(conn, current_user.user_id, "seats", seat_id, "edit")
        primary = None
        if body.holder_ids is not None:
            primary = await _sync_holders(conn, seat_id, str(tenant_id), body.holder_ids)
        holder_override = primary or body.holder_user_id
        row = await conn.fetchrow(
            """
            UPDATE seats SET
                title = COALESCE($2, title),
                holder_user_id = COALESCE($3, holder_user_id),
                parent_seat_id = COALESCE($4, parent_seat_id),
                responsibilities = COALESCE($5, responsibilities),
                gwc_gets = COALESCE($6, gwc_gets),
                gwc_wants = COALESCE($7, gwc_wants),
                gwc_capacity = COALESCE($8, gwc_capacity)
            WHERE id = $1
            RETURNING id, title, tenant_id
            """,
            seat_id, body.title, holder_override, body.parent_seat_id, body.responsibilities,
            body.gwc_gets, body.gwc_wants, body.gwc_capacity,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Seat not found or not accessible")
    return dict(row)


@router.post("/{seat_id}/reparent")
async def reparent_seat(seat_id: str, body: ReparentRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Drag-and-drop: move a seat under a new parent (or to the top). Guards against
    making a seat its own ancestor (which would orphan a subtree)."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "seats", seat_id, "edit")
        new_parent = body.parent_seat_id
        if new_parent == seat_id:
            raise HTTPException(status_code=400, detail="A seat can't report to itself")
        cur = new_parent
        while cur:
            if cur == seat_id:
                raise HTTPException(status_code=400, detail="That would create a reporting loop")
            nxt = await conn.fetchval("SELECT parent_seat_id FROM seats WHERE id = $1", cur)
            cur = str(nxt) if nxt else None
        await conn.execute("UPDATE seats SET parent_seat_id = $2 WHERE id = $1", seat_id, new_parent)
    return {"reparented": True}


@router.delete("/{seat_id}")
async def delete_seat(seat_id: str, current_user: CurrentUser = Depends(get_current_user)):
    """Deleting a seat cascades to seats reporting under it (FK ON DELETE CASCADE)."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_row_permission(conn, current_user.user_id, "seats", seat_id, "delete")
        result = await conn.execute("DELETE FROM seats WHERE id = $1", seat_id)
    return {"deleted": result}


@router.post("/publish")
async def publish_chart(body: PublishRequest, current_user: CurrentUser = Depends(get_current_user)):
    """Snapshot the whole chart into version history."""
    async with get_scoped_connection(current_user.user_id) as conn:
        await require_permission(conn, current_user.user_id, body.tenant_id, "edit")
        seats = await conn.fetch(
            """SELECT id, title, parent_seat_id, holder_user_id, responsibilities,
                      gwc_gets, gwc_wants, gwc_capacity FROM seats WHERE tenant_id = $1 ORDER BY sort_order""",
            body.tenant_id,
        )
        snapshot = [dict(s) | {"id": str(s["id"]),
                               "parent_seat_id": str(s["parent_seat_id"]) if s["parent_seat_id"] else None,
                               "holder_user_id": str(s["holder_user_id"]) if s["holder_user_id"] else None}
                    for s in seats]
        row = await conn.fetchrow(
            """INSERT INTO org_chart_versions (tenant_id, label, snapshot, seat_count, created_by)
               VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at""",
            body.tenant_id, body.label, json.dumps(snapshot), len(snapshot), current_user.user_id,
        )
    return {"id": str(row["id"]), "seat_count": len(snapshot), "created_at": row["created_at"].isoformat()}
