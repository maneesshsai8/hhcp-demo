"""
Live meeting rooms over WebSockets. In-process room manager keyed by meeting_id.

Each participant opens ws://.../ws/meetings/{id}?token=<access_token>. The server
tracks who's connected and broadcasts three message types to the room:
  - presence : {type:'presence', users:[{id,name}]}   -> "N present"
  - section  : {type:'section', index}                 -> everyone follows the facilitator
  - refetch  : {type:'refetch', what}                  -> a list changed; reload it

PRODUCTION NOTE: for multiple backend instances this needs a shared bus
(Redis pub/sub) instead of an in-process dict, and a socket auth handshake
instead of a token in the query string. See ARCHITECTURE-GAPS.md.
"""
from collections import defaultdict

import jwt
from fastapi import WebSocket, WebSocketDisconnect

from app.security import decode_access_token
from app import database

# meeting_id -> { websocket: {"user_id":..., "name":...} }
_rooms: dict[str, dict] = defaultdict(dict)


def _presence(meeting_id: str):
    seen = {}
    for info in _rooms[meeting_id].values():
        seen[info["user_id"]] = info["name"]
    return [{"id": uid, "name": name} for uid, name in seen.items()]


async def _broadcast(meeting_id: str, message: dict):
    dead = []
    for ws in list(_rooms[meeting_id].keys()):
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _rooms[meeting_id].pop(ws, None)


async def meeting_ws(websocket: WebSocket, meeting_id: str):
    token = websocket.query_params.get("token")
    try:
        payload = decode_access_token(token)
        user_id = payload["user_id"]
    except (jwt.InvalidTokenError, KeyError, TypeError):
        await websocket.close(code=4401)
        return

    async with database._pool.acquire() as conn:
        name = await conn.fetchval("SELECT name FROM users WHERE id = $1", user_id)

    await websocket.accept()
    _rooms[meeting_id][websocket] = {"user_id": user_id, "name": name or "User"}
    await _broadcast(meeting_id, {"type": "presence", "users": _presence(meeting_id)})

    try:
        while True:
            data = await websocket.receive_json()
            t = data.get("type")
            if t == "section":
                await _broadcast(meeting_id, {"type": "section", "index": data.get("index")})
            elif t == "changed":
                await _broadcast(meeting_id, {"type": "refetch", "what": data.get("what")})
            # ignore anything else
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _rooms[meeting_id].pop(websocket, None)
        await _broadcast(meeting_id, {"type": "presence", "users": _presence(meeting_id)})
