import { Injectable, Logger } from '@nestjs/common';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import { SecurityService } from '../auth/security';
import { DatabaseService } from '../database/database.service';

/**
 * Live meeting rooms over WebSockets. In-process room manager keyed by
 * meeting_id — a faithful 1:1 port of backend/app/realtime.py.
 *
 * Each participant opens ws://.../ws/meetings/{id} with the httpOnly
 * `access_token` cookie (preferred) or a `?token=` query param. The server
 * tracks who is connected and broadcasts three message types to the room:
 *   - presence : {type:'presence', users:[{id,name}]}   -> "N present"
 *   - section  : {type:'section', index}                 -> everyone follows the facilitator
 *   - refetch  : {type:'refetch', what}                  -> a list changed; reload it
 *
 * Nest ws gateways don't handle path params well, so instead of a NestGateway
 * this attaches a raw `ws` server (noServer mode) to the underlying Node HTTP
 * server and filters 'upgrade' events by path. Non-matching paths are left
 * untouched so the Fastify proxy / other upgrade listeners can coexist.
 *
 * PRODUCTION NOTE (same as the Python original): for multiple backend instances
 * this needs a shared bus (Redis pub/sub) instead of an in-process map, and a
 * real socket auth handshake instead of a token in the query string.
 */

interface Participant {
  userId: string;
  name: string;
}

type Room = Map<WebSocket, Participant>;

const MEETING_PATH = /^\/ws\/meetings\/([^/]+)$/;

/** Parse a raw Cookie header into a key -> value map. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

@Injectable()
export class MeetingRealtime {
  private readonly logger = new Logger(MeetingRealtime.name);

  // noServer mode: we drive the handshake ourselves from the 'upgrade' event.
  private readonly wss = new WebSocketServer({ noServer: true });

  // meeting_id -> ( websocket -> { userId, name } ). Mirrors Python's `_rooms`.
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly security: SecurityService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * Register the WS upgrade handler on the underlying Node HTTP server. Only
   * upgrades whose path matches `/ws/meetings/{id}` are consumed; anything else
   * is ignored (NOT destroyed) so other upgrade listeners keep working.
   */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const match = MEETING_PATH.exec(url.pathname);
      if (!match) return; // not ours — leave it for other handlers

      const meetingId = decodeURIComponent(match[1]);
      const cookies = parseCookies(req.headers.cookie);
      // Prefer the httpOnly cookie; fall back to a query-param token.
      const token = cookies['access_token'] || url.searchParams.get('token') || undefined;

      void this.handleUpgrade(req, socket, head, meetingId, token);
    });
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    meetingId: string,
    token: string | undefined,
  ): Promise<void> {
    let userId: string;
    try {
      if (!token) throw new Error('missing token');
      userId = this.security.decodeAccessToken(token).user_id;
      if (!userId) throw new Error('missing user_id'); // mirrors Python's KeyError
    } catch {
      // Complete the handshake far enough to close with 4401, matching
      // realtime.py's `await websocket.close(code=4401)`.
      this.wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401));
      return;
    }

    let name: string | undefined;
    try {
      const rows = await this.db.unscoped`SELECT name FROM users WHERE id = ${userId}`;
      name = rows[0]?.name as string | undefined;
    } catch (err) {
      // The Python version does this lookup on the raw pool before accepting; a
      // failure there aborts the handshake. Do the same rather than leak a socket.
      this.logger.error(`user lookup failed for ${userId}: ${String(err)}`);
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, meetingId, userId, name || 'User');
    });
  }

  private onConnection(ws: WebSocket, meetingId: string, userId: string, name: string): void {
    const room = this.roomFor(meetingId);
    room.set(ws, { userId, name });
    this.broadcast(meetingId, { type: 'presence', users: this.presence(meetingId) });

    ws.on('message', (raw: RawData) => {
      let data: { type?: string; index?: unknown; what?: unknown };
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // ignore non-JSON frames
      }
      const t = data.type;
      if (t === 'section') {
        this.broadcast(meetingId, { type: 'section', index: data.index ?? null });
      } else if (t === 'changed') {
        this.broadcast(meetingId, { type: 'refetch', what: data.what ?? null });
      }
      // ignore anything else
    });

    const leave = (): void => this.leave(meetingId, ws);
    ws.on('close', leave);
    ws.on('error', leave);
  }

  /** Remove a socket from its room and rebroadcast presence — once. */
  private leave(meetingId: string, ws: WebSocket): void {
    const room = this.rooms.get(meetingId);
    if (!room || !room.has(ws)) return; // guard against close+error firing twice
    room.delete(ws);
    this.broadcast(meetingId, { type: 'presence', users: this.presence(meetingId) });
  }

  private roomFor(meetingId: string): Room {
    let room = this.rooms.get(meetingId);
    if (!room) {
      room = new Map<WebSocket, Participant>();
      this.rooms.set(meetingId, room);
    }
    return room;
  }

  /** Dedupe presence by user_id, preserving insertion order (matches _presence). */
  private presence(meetingId: string): Array<{ id: string; name: string }> {
    const seen = new Map<string, string>();
    const room = this.rooms.get(meetingId);
    if (room) {
      for (const info of room.values()) seen.set(info.userId, info.name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }

  private broadcast(meetingId: string, message: unknown): void {
    const room = this.rooms.get(meetingId);
    if (!room) return;
    const text = JSON.stringify(message);
    for (const ws of [...room.keys()]) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
        else room.delete(ws);
      } catch {
        room.delete(ws);
      }
    }
  }
}
