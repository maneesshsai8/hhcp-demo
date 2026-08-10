/**
 * Contract parity runner (analysis §16). Runs every golden case against BOTH
 * backends and reports pass/fail. Exit code is non-zero if any case fails, so it
 * drops straight into CI ("run the full contract suite against both backends on
 * every PR", §9).
 *
 *   PY_BASE=http://localhost:8000 NODE_BASE=http://localhost:8001 \
 *   ADMIN_EMAIL=admin@hiddenharbor.com ADMIN_PASSWORD=Demo1234! \
 *   npm test -w @hhcp/contract-tests [-- --behavioral]
 *
 * Both backends must run in AUTH_PROVIDER=local and point at the same seeded DB.
 */
import { request, login, normalize, deepDiff, Resp } from './lib';
import { READ_CASES, SECURITY_CASES, behavioralCases, Case } from './golden';

const PY = process.env.PY_BASE ?? 'http://localhost:8000';
const NODE = process.env.NODE_BASE ?? 'http://localhost:8001';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@hiddenharbor.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Demo1234!';
const withBehavioral = process.argv.includes('--behavioral');

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function reachable(base: string): Promise<boolean> {
  try {
    const r = await request(base, { path: '/health' });
    return r.status === 200;
  } catch {
    return false;
  }
}

interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function runCase(
  c: Case,
  cookies: { admin: { py: string; node: string } },
): Promise<CaseResult> {
  const cookie = c.as === 'anon' ? undefined : { py: cookies.admin.py, node: cookies.admin.node };
  const common = { method: c.method, path: c.path, headers: c.headers, body: c.body };
  let py: Resp;
  let node: Resp;
  try {
    py = await request(PY, { ...common, cookie: cookie?.py });
    node = await request(NODE, { ...common, cookie: cookie?.node });
  } catch (e) {
    return { name: c.name, ok: false, detail: `request error: ${(e as Error).message}` };
  }

  // Status must always match between backends.
  if (py.status !== node.status) {
    return { name: c.name, ok: false, detail: `status Python ${py.status} ≠ Node ${node.status}` };
  }
  // Security cases: assert the exact expected status on both.
  if (c.expectStatus !== undefined && py.status !== c.expectStatus) {
    return { name: c.name, ok: false, detail: `expected ${c.expectStatus}, both returned ${py.status}` };
  }
  if (c.parity === 'status') {
    return { name: c.name, ok: true, detail: `both ${py.status}` };
  }
  // Body parity (default): diff normalized bodies.
  const diffs = deepDiff(normalize(py.body), normalize(node.body));
  if (diffs.length) {
    return {
      name: c.name,
      ok: false,
      detail: `${diffs.length} body diff(s):\n    ${diffs.slice(0, 8).join('\n    ')}${diffs.length > 8 ? '\n    …' : ''}`,
    };
  }
  return { name: c.name, ok: true, detail: `both ${py.status}, bodies identical` };
}

async function main(): Promise<void> {
  console.log(`Contract parity: Python=${PY}  Node=${NODE}\n`);
  const pyUp = await reachable(PY);
  const nodeUp = await reachable(NODE);
  if (!pyUp || !nodeUp) {
    console.log(RED('Cannot run: both backends must be reachable on /health.'));
    console.log(`  Python (${PY}): ${pyUp ? GREEN('up') : RED('DOWN')}`);
    console.log(`  Node   (${NODE}): ${nodeUp ? GREEN('up') : RED('DOWN')}`);
    console.log(DIM('\nStart both (AUTH_PROVIDER=local, same seeded DB) and re-run.'));
    process.exit(2);
  }

  let adminPy: string;
  let adminNode: string;
  try {
    adminPy = await login(PY, EMAIL, PASSWORD);
    adminNode = await login(NODE, EMAIL, PASSWORD);
  } catch (e) {
    console.log(RED(`Login failed: ${(e as Error).message}`));
    console.log(DIM('Both backends must be AUTH_PROVIDER=local with the seeded admin user.'));
    process.exit(2);
  }
  const cookies = { admin: { py: adminPy, node: adminNode } };

  const cases: Case[] = [
    ...READ_CASES,
    ...SECURITY_CASES,
    ...(withBehavioral ? behavioralCases() : []),
  ];
  if (withBehavioral && behavioralCases().length === 0) {
    console.log(DIM('(--behavioral set but no FIXTURE_TENANT_ID/FIXTURE_MEETING_ID provided; no behavioral cases to run)\n'));
  }

  let pass = 0;
  let fail = 0;
  for (const c of cases) {
    const r = await runCase(c, cookies);
    if (r.ok) {
      pass++;
      console.log(`${GREEN('✓')} ${r.name} ${DIM(r.detail)}`);
    } else {
      fail++;
      console.log(`${RED('✗')} ${r.name}\n    ${RED(r.detail)}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${cases.length} total`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('harness crashed:', e);
  process.exit(2);
});
