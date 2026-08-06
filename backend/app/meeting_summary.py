"""
Deterministic post-meeting summary builder.

Pure structured-data formatter (no AI dependency). Shared by the synchronous
finish path and the background summary worker, so both produce identical output.
The signature is intentionally narrow — `conn` must already be RLS-scoped to a
user who can see the meeting's tenant (the request user, or, in the worker, the
meeting's creator) — so a later AI-backed implementation can swap the body
without changing callers.
"""


def _fmt_duration(seconds: int | None) -> str:
    if not seconds:
        return "0 minutes"
    m = seconds // 60
    return f"{m} minute{'s' if m != 1 else ''}"


async def build_summary(conn, meeting_id: str) -> dict:
    """Return the structured summary dict for a completed meeting.

    Counts are computed from the meeting window (records created/solved between
    started_at and now), the agenda snapshot, and persisted attendance/ratings.
    """
    m = await conn.fetchrow(
        """
        SELECT m.title, m.tenant_id, m.started_at, m.ended_at, m.rating, m.notes,
               m.sections, m.meeting_type, u.name AS facilitator
        FROM meetings m LEFT JOIN users u ON u.id = m.created_by
        WHERE m.id = $1
        """,
        meeting_id,
    )
    if m is None:
        raise ValueError("meeting not found or not accessible")

    tenant_id, started = m["tenant_id"], m["started_at"]
    import json
    sections = json.loads(m["sections"]) if isinstance(m["sections"], str) else (m["sections"] or [])
    kinds = [s.get("kind") for s in sections]

    present = [r["name"] for r in await conn.fetch(
        "SELECT u.name FROM meeting_attendance a JOIN users u ON u.id=a.user_id "
        "WHERE a.meeting_id=$1 AND a.present ORDER BY u.name", meeting_id)]

    issues_raised, todos_created, issues_solved = [], [], 0
    if started:
        issues_raised = [r["title"] for r in await conn.fetch(
            "SELECT title FROM issues WHERE tenant_id=$1 AND created_at >= $2 ORDER BY created_at", tenant_id, started)]
        issues_solved = await conn.fetchval(
            "SELECT count(*) FROM issues WHERE tenant_id=$1 AND solved_at >= $2", tenant_id, started) or 0
        todos_created = [r["title"] for r in await conn.fetch(
            "SELECT title FROM todos WHERE tenant_id=$1 AND created_at >= $2 ORDER BY created_at", tenant_id, started)]

    duration = int((m["ended_at"] - started).total_seconds()) if (started and m["ended_at"]) else 0
    rating = float(m["rating"]) if m["rating"] is not None else None

    structured = {
        "title": m["title"],
        "meeting_type": m["meeting_type"],
        "date": m["ended_at"].isoformat() if m["ended_at"] else None,
        "duration_seconds": duration,
        "facilitator": m["facilitator"],
        "attendance": len(present),
        "present": present,
        "segments_total": len(sections),
        "scorecards_reviewed": kinds.count("scorecard"),
        "rocks_reviewed": kinds.count("rocks") + kinds.count("vcbs"),
        "issues_raised": issues_raised,
        "issues_solved": issues_solved,
        "todos_created": todos_created,
        "rating": rating,
        "notes": m["notes"],
    }
    structured["summary_text"] = _render_text(structured)
    return structured


def _render_text(s: dict) -> str:
    date = (s["date"] or "")[:10]
    lines = [
        f"{s['title']} completed{f' on {date}' if date else ''}.",
        "",
        f"Attendees: {s['attendance']}",
        f"Duration: {_fmt_duration(s['duration_seconds'])}",
        f"Segments: {s['segments_total']}",
    ]
    if s["scorecards_reviewed"]:
        lines.append(f"Scorecard segments reviewed: {s['scorecards_reviewed']}")
    if s["rocks_reviewed"]:
        lines.append(f"Rock/VCB segments reviewed: {s['rocks_reviewed']}")
    lines += [
        f"Issues created: {len(s['issues_raised'])}",
        f"Issues resolved: {s['issues_solved']}",
        f"To-Dos created: {len(s['todos_created'])}",
        f"Average rating: {s['rating'] if s['rating'] is not None else '—'}",
    ]
    return "\n".join(lines)
