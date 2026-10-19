/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// The caller's session cookie: whose token it holds, and whether its server is
// an admin-configured one.
let caller: { token: string; trusted: boolean } | null = null;
let sameOrigin = true;
let stalwartFeatures = true;
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => (caller
    ? { serverUrl: 'https://mail.example.org', authHeader: `Bearer ${caller.token}`, username: 'claimed@example.org', hasSessionCookie: true, slot: 0, trusted: caller.trusted }
    : null),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key === 'stalwartFeaturesEnabled' ? stalwartFeatures : fallback),
  },
}));
vi.mock('@/lib/security/same-origin', async () => {
  const { NextResponse } = await import('next/server');
  return { rejectCrossOriginRequest: () => (sameOrigin ? null : NextResponse.json({}, { status: 403 })) };
});

import { GET, POST, PATCH, DELETE } from '../route';
import { DELETED_MASK_MARK } from '@/lib/masked-addresses/server';

const SERVICE_KEY = 'API_service-key';

interface FakeAlias { name: string; domainId: string; enabled: boolean; description: string | null }
interface FakeAccount { name: string; domainId: string; aliases: FakeAlias[] }

/** Just enough of Stalwart: sessions, domain and account lookups, alias writes with unique addresses. */
function fakeStalwart() {
  const domains: Record<string, string> = { a: 'example.org', f: 'anon.example.org' };
  const accounts: Record<string, FakeAccount> = {
    m: { name: 'alice', domainId: 'a', aliases: [{ name: 'old', domainId: 'a', enabled: true, description: null }] },
    n: { name: 'bob', domainId: 'a', aliases: [{ name: 'calm.otter', domainId: 'f', enabled: true, description: 'Shop' }] },
  };
  const users: Record<string, string> = { 'alice-token': 'alice@example.org', 'bob-token': 'bob@example.org' };
  const writes: string[] = [];
  const address = (name: string, domainId: string) => `${name}@${domains[domainId]}`;

  const handle = (name: string, args: Record<string, unknown>, results: Map<string, Record<string, unknown>>): [string, Record<string, unknown>] => {
    if (args.accountId !== 'svc') return ['error', { type: 'accountNotFound' }];
    const filter = (args.filter ?? {}) as Record<string, string>;
    switch (name) {
      case 'x:Domain/query':
        return [name, { ids: Object.keys(domains).filter((id) => domains[id] === filter.name) }];
      case 'x:Account/query':
        return [name, { ids: Object.keys(accounts).filter((id) => accounts[id].name === filter.name && accounts[id].domainId === filter.domainId) }];
      case 'x:Account/get': {
        const ref = args['#ids'] as { resultOf: string } | undefined;
        const ids = ref ? (results.get(ref.resultOf)?.ids as string[]) : (args.ids as string[]);
        return [name, {
          list: ids.map((id) => ({
            id,
            emailAddress: address(accounts[id].name, accounts[id].domainId),
            aliases: Object.fromEntries(accounts[id].aliases.map((alias, i) => [String(i), alias])),
          })),
        }];
      }
      case 'x:Account/set': {
        const [[id, patch]] = Object.entries(args.update as Record<string, { aliases: Record<string, FakeAlias> }>);
        const aliases = Object.values(patch.aliases);
        const taken = new Set(Object.entries(accounts).filter(([other]) => other !== id).flatMap(([, account]) => [
          address(account.name, account.domainId),
          ...account.aliases.map((alias) => address(alias.name, alias.domainId)),
        ]));
        if (aliases.some((alias) => taken.has(address(alias.name, alias.domainId)))) {
          return [name, { notUpdated: { [id]: { type: 'primaryKeyViolation' } } }];
        }
        accounts[id].aliases = aliases;
        writes.push(id);
        return [name, { updated: { [id]: null } }];
      }
      default:
        return ['error', { type: 'unknownMethod' }];
    }
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    const token = auth.replace(/^Bearer /, '');
    if (url.endsWith('/jmap/session')) {
      if (token === SERVICE_KEY) return Response.json({ username: 'webmail-masks@example.org', primaryAccounts: { 'urn:stalwart:jmap': 'svc' } });
      if (users[token]) return Response.json({ username: users[token], primaryAccounts: { 'urn:ietf:params:jmap:mail': 'u' } });
      return new Response('', { status: 401 });
    }
    if (url.endsWith('/jmap/') && token === SERVICE_KEY) {
      const { methodCalls } = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
      const results = new Map<string, Record<string, unknown>>();
      const methodResponses = methodCalls.map(([name, args, callId]) => {
        const [resultName, result] = handle(name, args, results);
        results.set(callId, result);
        return [resultName, result, callId];
      });
      return Response.json({ methodResponses });
    }
    return new Response('', { status: 404 });
  });

  return { accounts, writes, fetchMock };
}

let stalwart: ReturnType<typeof fakeStalwart>;

const url = 'http://localhost/api/account/masked-addresses';
const list = () => GET(new NextRequest(url));
const create = (label?: string) => POST(new NextRequest(url, { method: 'POST', body: JSON.stringify({ label }) }));
const update = (body: unknown) => PATCH(new NextRequest(url, { method: 'PATCH', body: JSON.stringify(body) }));
const remove = (email: string) => DELETE(new NextRequest(`${url}?email=${encodeURIComponent(email)}`, { method: 'DELETE' }));

beforeEach(() => {
  stalwart = fakeStalwart();
  vi.stubGlobal('fetch', stalwart.fetchMock);
  vi.stubEnv('MASKED_ADDRESS_DOMAIN', 'anon.example.org');
  vi.stubEnv('MASKED_ADDRESS_API_KEY', SERVICE_KEY);
  vi.stubEnv('MASKED_ADDRESS_LIMIT', '3');
  caller = { token: 'alice-token', trusted: true };
  sameOrigin = true;
  stalwartFeatures = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('/api/account/masked-addresses', () => {
  it('makes a word-pair mask on the caller\'s own account, keeping their other aliases', async () => {
    const res = await create('  Netflix ');
    expect(res.status).toBe(200);
    const { mask } = await res.json();
    expect(mask).toEqual({ email: expect.stringMatching(/^[a-z]+\.[a-z]+@anon\.example\.org$/), label: 'Netflix', enabled: true });

    expect(stalwart.accounts.m.aliases).toEqual([
      { name: 'old', domainId: 'a', enabled: true, description: null },
      { name: mask.email.split('@')[0], domainId: 'f', enabled: true, description: 'Netflix' },
    ]);
    expect(stalwart.writes).toEqual(['m']);
    const listed = await (await list()).json();
    expect(listed).toEqual({ domain: 'anon.example.org', limit: 3, masks: [mask] });
  });

  it('identifies the caller by their live session, not by the username their cookie claims', async () => {
    caller = { token: 'bob-token', trusted: true };
    const { masks } = await (await list()).json();
    expect(masks.map((m: { email: string }) => m.email)).toEqual(['calm.otter@anon.example.org']);
  });

  it('tries another pair when one is already someone else\'s', async () => {
    // Words are picked as indexes; the first pair drawn is Bob's calm.otter.
    const { ADJECTIVES, NOUNS } = await import('@/lib/masked-addresses/words');
    const picks = [ADJECTIVES.indexOf('calm'), NOUNS.indexOf('otter'), ADJECTIVES.indexOf('swift'), NOUNS.indexOf('heron')];
    const { createMaskedAddress, resolveMaskedAddressContext, getMaskedAddressConfig } = await import('@/lib/masked-addresses/server');
    const ctx = await resolveMaskedAddressContext(
      { serverUrl: 'https://mail.example.org', authHeader: 'Bearer alice-token', username: 'x', hasSessionCookie: true, slot: 0, trusted: true },
      getMaskedAddressConfig()!,
    );
    const mask = await createMaskedAddress(ctx, null, () => picks.shift()!);
    expect(mask.email).toBe('swift.heron@anon.example.org');
    expect(stalwart.accounts.n.aliases).toHaveLength(1);
  });

  it('stops at the limit', async () => {
    for (let i = 0; i < 3; i++) expect((await create()).status).toBe(200);
    const res = await create();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'limit_reached' });
  });

  it('turns a mask off and relabels it', async () => {
    const { mask } = await (await create('Shop')).json();
    const res = await update({ email: mask.email, enabled: false, label: 'Old shop' });
    expect(await res.json()).toEqual({ mask: { email: mask.email, label: 'Old shop', enabled: false } });
    expect(stalwart.accounts.m.aliases[1]).toMatchObject({ enabled: false, description: 'Old shop' });
  });

  it("cannot touch someone else's mask", async () => {
    const res = await update({ email: 'calm.otter@anon.example.org', enabled: false });
    expect(res.status).toBe(404);
    expect((await remove('calm.otter@anon.example.org')).status).toBe(404);
    expect(stalwart.accounts.n.aliases[0].enabled).toBe(true);
    expect(stalwart.writes).toEqual([]);
  });

  it('only manages addresses on the mask domain', async () => {
    const res = await update({ email: 'old@example.org', enabled: false });
    expect(res.status).toBe(400);
    expect(stalwart.accounts.m.aliases[0].enabled).toBe(true);
  });

  it('retires a deleted mask: it stops delivering, leaves the list and frees a slot, but is never reused', async () => {
    const { mask } = await (await create('Shop')).json();
    expect((await remove(mask.email)).status).toBe(200);

    expect(stalwart.accounts.m.aliases[1]).toEqual({ name: mask.email.split('@')[0], domainId: 'f', enabled: false, description: DELETED_MASK_MARK });
    expect((await (await list()).json()).masks).toEqual([]);
    expect((await update({ email: mask.email, enabled: true })).status).toBe(404);
    for (let i = 0; i < 3; i++) expect((await create()).status).toBe(200);
  });

  it('keeps a typed label from reading as the deleted mark', async () => {
    const { mask } = await (await create(DELETED_MASK_MARK)).json();
    expect(mask.label).toBe('deleted');
    expect((await (await list()).json()).masks).toHaveLength(1);
  });

  it('never sends the service key to a server the caller chose themselves', async () => {
    caller = { token: 'alice-token', trusted: false };
    const res = await list();
    expect(res.status).toBe(403);
    expect(stalwart.fetchMock.mock.calls.some(([, init]) => new Headers(init?.headers).get('authorization') === `Bearer ${SERVICE_KEY}`)).toBe(false);
  });

  it('asks for a fresh session when the token in the cookie no longer works', async () => {
    caller = { token: 'expired', trusted: true };
    const res = await list();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'session_expired' });
  });

  it('does not exist until a domain and a service key are configured', async () => {
    vi.stubEnv('MASKED_ADDRESS_API_KEY', '');
    expect((await list()).status).toBe(404);
    vi.stubEnv('MASKED_ADDRESS_API_KEY', SERVICE_KEY);
    stalwartFeatures = false;
    expect((await list()).status).toBe(404);
  });

  it('refuses changes from another site', async () => {
    sameOrigin = false;
    expect((await create()).status).toBe(403);
    expect(stalwart.writes).toEqual([]);
  });

  it('runs one change at a time per account, so concurrent ones do not overwrite each other', async () => {
    const results = await Promise.all([create('a'), create('b'), create('c')]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(stalwart.accounts.m.aliases.filter((alias) => alias.domainId === 'f').map((alias) => alias.description).sort()).toEqual(['a', 'b', 'c']);
  });
});
