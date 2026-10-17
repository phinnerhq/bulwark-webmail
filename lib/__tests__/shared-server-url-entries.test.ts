// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Two JMAP_SERVERS entries for one Stalwart behind one issuer, told apart only
// by their OAuth client: each signs in, exchanges its code and refreshes
// with its own client, keyed on the entry id the browser picked and the slot
// cookie keeps, never on the shared URL.

const config: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config ? config[key] : fallback),
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/session-secret', () => ({ hasSessionSecret: () => true, getSessionSecret: () => 's'.repeat(64) }));

const ISSUER = 'https://sso.example.com/realms/mail';
const discovered: string[] = [];
vi.mock('@/lib/oauth/discovery', () => ({
  discoverOAuth: async (url: string) => {
    discovered.push(url);
    return {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
      token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    };
  },
}));

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));

const { POST: ssoStart } = await import('@/app/api/auth/sso/start/route');
const { buildOAuthParams, exchangeCodeForTokens, getRequiredConfig } = await import('@/lib/oauth/token-exchange');
const { decryptPayload } = await import('@/lib/auth/crypto');

const MAIL = 'https://mail.example.com';
const WEBMAIL = 'https://webmail.example.com';

beforeEach(() => {
  for (const key of Object.keys(config)) delete config[key];
  jar.clear();
  discovered.length = 0;
  config.oauthEnabled = true;
  config.oauthOnly = true;
  config.jmapServers = [
    { id: 'north', label: 'North', url: MAIL, oauth: { clientId: 'webmail-north', issuerUrl: ISSUER, clientSecret: 'north-secret' } },
    { id: 'south', label: 'South', url: MAIL, oauth: { clientId: 'webmail-south', issuerUrl: ISSUER, clientSecret: 'south-secret' } },
  ];
});

async function startSso(serverId: string) {
  const res = await ssoStart(new NextRequest(`${WEBMAIL}/api/auth/sso/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEBMAIL, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ redirect_uri: `${WEBMAIL}/fr/auth/callback`, locale: 'fr', server_id: serverId }),
  }));
  expect(res.status).toBe(200);
  return new URL((await res.json()).authorize_url);
}

describe('entries sharing one server URL', () => {
  it.each([['north', 'webmail-north'], ['south', 'webmail-south']])(
    'sends the %s button to the shared issuer with its own client',
    async (serverId, clientId) => {
      const url = await startSso(serverId);
      expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/protocol/openid-connect/auth`);
      expect(url.searchParams.get('client_id')).toBe(clientId);
      expect(discovered).toEqual([ISSUER]);
      // The pending login names the entry, for the code exchange on return.
      expect(decryptPayload(jar.get('sso_pending')!, 'sso-pending')).toMatchObject({ server_id: serverId });
    },
  );

  it('exchanges the code and refreshes with the entry the slot names', async () => {
    const sent: URLSearchParams[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), { status: 200 });
    }));
    await exchangeCodeForTokens('code', 'verifier', `${WEBMAIL}/fr/auth/callback`, 'south');
    const [body] = sent;
    expect(body.get('client_id')).toBe('webmail-south');
    expect(body.get('client_secret')).toBe('south-secret');
    vi.unstubAllGlobals();

    const refresh = buildOAuthParams({ grant_type: 'refresh_token', refresh_token: 'r' }, 'north');
    expect(refresh.get('client_id')).toBe('webmail-north');
    expect(refresh.get('client_secret')).toBe('north-secret');
    expect(getRequiredConfig('south')).toMatchObject({ clientId: 'webmail-south', serverUrl: MAIL, serverId: 'south' });
  });
});
