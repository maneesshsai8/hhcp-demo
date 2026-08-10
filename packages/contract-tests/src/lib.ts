/**
 * Contract-test primitives: login, request, response normalization, and a deep
 * diff. Both backends read the SAME PostgreSQL, so a GET returns byte-identical
 * rows (same ids, same timestamps) — we can diff full response bodies, only
 * normalizing the handful of fields computed at request time (server clocks,
 * fan-out timings, "is it overdue today" booleans).
 */

export interface Resp {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Volatile keys computed per-request (not from the shared DB) — normalized before diff. */
const VOLATILE_KEYS = new Set([
  'fanout_ms',
  'server_time',
  'now',
  'elapsed_seconds',
  'elapsed',
  'timer',
  'accumulated_paused_seconds', // moves while a meeting is live
  'is_overdue', // depends on wall-clock "today"
  'seconds_remaining',
]);

export async function request(
  base: string,
  opts: { method?: string; path: string; cookie?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Resp> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${opts.path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const headerObj: Record<string, string> = {};
  res.headers.forEach((v, k) => (headerObj[k] = v));
  return { status: res.status, headers: headerObj, body };
}

/** Log in via the local provider and return the Cookie header to reuse. */
export async function login(base: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed on ${base}: HTTP ${res.status}`);
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`login on ${base} returned no cookies`);
  return cookie;
}

/** Recursively replace volatile values with a sentinel so the diff ignores them. */
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = VOLATILE_KEYS.has(k) ? '<volatile>' : normalize(v);
    }
    return out;
  }
  return value;
}

/** Return a list of human-readable difference paths between two normalized values. */
export function deepDiff(a: unknown, b: unknown, path = ''): string[] {
  const diffs: string[] = [];
  if (typeof a !== typeof b) {
    diffs.push(`${path || '<root>'}: type ${typeof a} ≠ ${typeof b}`);
    return diffs;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) diffs.push(`${path}: array length ${a.length} ≠ ${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    return diffs;
  }
  if (a && b && typeof a === 'object') {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    const allKeys = new Set([...ak, ...bk]);
    for (const k of allKeys) {
      const inA = k in (a as object);
      const inB = k in (b as object);
      if (!inA) diffs.push(`${path}.${k}: missing in Python`);
      else if (!inB) diffs.push(`${path}.${k}: missing in Node`);
      else diffs.push(...deepDiff((a as any)[k], (b as any)[k], `${path}.${k}`));
    }
    return diffs;
  }
  if (a !== b) diffs.push(`${path || '<root>'}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  return diffs;
}
