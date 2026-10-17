// A single-realm OpenID provider that behaves like Keycloak where switching
// people matters, plus just enough JMAP for Bulwark to finish a sign-in.
//
// - One login session per browser (a cookie). Each client stands for an
//   identity provider the realm brokers to, signing in its own person; a
//   sign-in for someone other than the session's person is refused with
//   "already authenticated as different user", as Keycloak does.
// - RP-initiated logout follows Keycloak 26's LogoutEndpoint: id_token_hint
//   must match client_id; a browser session other than the hint's, or a
//   session without a hint, needs the user to confirm; no session, no hint,
//   a client and a registered redirect send the browser straight back.
// - Ending a session ends its ordinary refresh tokens; offline ones
//   (scope offline_access) outlive it.
//
// Served over https, as the webmail's CSP only lets the browser reach JMAP
// that way.
//
//   node scripts/idp-switch/mock-idp.mjs <port> <webmail-origin> <cert.pem> <key.pem>
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const [, , portArg, webmailArg, certPath, keyPath] = process.argv;
const port = Number(portArg ?? 3171);
const webmail = webmailArg ?? 'http://localhost:3170';
const base = `https://127.0.0.1:${port}`;
const issuer = `${base}/realms/mail`;

// The person each client's upstream provider signs in, unless a test says otherwise.
const people = { 'webmail-north': 'alice@example.com', 'webmail-south': 'bob@example.com' };
const nextPerson = {};

const sessions = new Map(); // sid -> { person, authTime, alive }
const codes = new Map();
const idTokens = new Map(); // token -> claims
const refreshTokens = new Map(); // token -> { person, client, sid, offline }
const accessTokens = new Map(); // token -> person
const events = [];
// auth_time counts in seconds; a test can freeze it to make sign-ins tie.
let frozenAuthTime = null;

const id = () => randomBytes(12).toString('hex');
const now = () => Math.floor(Date.now() / 1000);

function idToken(claims) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.mock`;
  idTokens.set(token, claims);
  return token;
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k));
}

function browserSession(req) {
  const sid = cookies(req).MOCK_SESSION;
  const session = sid && sessions.get(sid);
  return session?.alive ? { sid, ...session } : null;
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, { 'content-type': json ? 'application/json' : 'text/html', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

const page = (title, body) => `<!doctype html><title>${title}</title><h1>${title}</h1>${body}`;

function endSession(sid) {
  const session = sessions.get(sid);
  if (!session) return;
  session.alive = false;
  for (const [token, grant] of refreshTokens) if (grant.sid === sid && !grant.offline) refreshTokens.delete(token);
}

function logout(req, res, url) {
  const q = url.searchParams;
  const hint = q.get('id_token_hint');
  const clientId = q.get('client_id');
  const back = q.get('post_logout_redirect_uri');
  if (back && !hint && !clientId) return send(res, 400, page('Missing parameter', ''));
  let claims = null;
  if (hint) {
    claims = idTokens.get(hint);
    if (!claims) return send(res, 400, page('Invalid parameter: id_token_hint', ''));
    if (clientId && clientId !== claims.azp) return send(res, 400, page('Invalid parameter: id_token_hint', ''));
  }
  const client = clientId ?? claims?.azp;
  if (back && (!(client in people) || !back.startsWith(`${webmail}/`))) return send(res, 400, page('Invalid redirect uri', ''));
  const session = browserSession(req);
  let confirm = !claims || !!(session && claims.sid !== session.sid);
  if (!session && !hint && client in people && back) confirm = false;
  const ticket = id();
  pendingLogouts.set(ticket, { sid: session?.sid ?? claims?.sid, back });
  if (confirm) {
    events.push({ type: 'logout_confirmation' });
    return send(res, 200, page('Do you want to log out?', `<a id="confirm-logout" href="${base}/realms/mail/logout/confirm?ticket=${ticket}">Log out</a>`));
  }
  return finishLogout(res, ticket);
}

const pendingLogouts = new Map();

function finishLogout(res, ticket) {
  const pending = pendingLogouts.get(ticket);
  pendingLogouts.delete(ticket);
  if (!pending) return send(res, 400, page('Logout expired', ''));
  if (pending.sid) endSession(pending.sid);
  events.push({ type: 'logout' });
  const clear = { 'set-cookie': 'MOCK_SESSION=; Path=/; Max-Age=0' };
  if (pending.back) return redirect(res, pending.back, clear);
  return send(res, 200, page('You are logged out', ''), clear);
}

function authorize(req, res, url) {
  const q = url.searchParams;
  const client = q.get('client_id');
  const redirectUri = q.get('redirect_uri') ?? '';
  if (!(client in people) || !redirectUri.startsWith(`${webmail}/`)) return send(res, 400, page('Invalid client or redirect', ''));
  const person = nextPerson[client] ?? people[client];
  let session = browserSession(req);
  if (session && session.person !== person) {
    events.push({ type: 'different_user_authenticated', client, person, sessionPerson: session.person });
    return send(res, 400, page('We are sorry...', `<p id="error">You are already authenticated as different user '${session.person}' in this session. Please sign out first.</p>`));
  }
  if (!session) {
    const sid = id();
    sessions.set(sid, { person, authTime: frozenAuthTime ?? now(), alive: true });
    session = { sid, ...sessions.get(sid) };
  }
  const code = id();
  codes.set(code, { client, person, sid: session.sid, authTime: session.authTime, scope: q.get('scope') ?? '' });
  events.push({ type: 'login', client, person });
  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  if (q.get('state')) back.searchParams.set('state', q.get('state'));
  redirect(res, back.toString(), { 'set-cookie': `MOCK_SESSION=${session.sid}; Path=/; HttpOnly; Secure; SameSite=Lax` });
}

function tokens(grant, client) {
  const access = id();
  accessTokens.set(access, grant.person);
  const t = now();
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: 300,
    refresh_token: grant.refresh,
    id_token: idToken({ iss: issuer, aud: client, azp: client, sub: grant.person, email: grant.person, sid: grant.sid, auth_time: grant.authTime, iat: t, exp: t + 300 }),
  };
}

async function token(req, res) {
  const body = new URLSearchParams(await read(req));
  const grantType = body.get('grant_type');
  if (grantType === 'authorization_code') {
    const code = codes.get(body.get('code'));
    codes.delete(body.get('code'));
    if (!code) return send(res, 400, { error: 'invalid_grant' });
    const refresh = id();
    const offline = code.scope.split(/\s+/).includes('offline_access');
    refreshTokens.set(refresh, { person: code.person, client: code.client, sid: code.sid, authTime: code.authTime, offline });
    return send(res, 200, tokens({ ...code, refresh }, code.client));
  }
  if (grantType === 'refresh_token') {
    const refresh = body.get('refresh_token');
    const grant = refreshTokens.get(refresh);
    if (!grant) {
      events.push({ type: 'refresh_refused' });
      return send(res, 400, { error: 'invalid_grant', error_description: 'Session not active' });
    }
    return send(res, 200, tokens({ ...grant, refresh }, grant.client));
  }
  send(res, 400, { error: 'unsupported_grant_type' });
}

function read(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

// --- JMAP: one account per person, an empty inbox ---------------------------

function jmapPerson(req) {
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') ? accessTokens.get(auth.slice(7)) : undefined;
}

function jmapSession(person) {
  const accountId = `acc-${person}`;
  return {
    capabilities: {
      'urn:ietf:params:jmap:core': { maxSizeUpload: 50000000, maxConcurrentUpload: 4, maxSizeRequest: 10000000, maxConcurrentRequests: 4, maxCallsInRequest: 16, maxObjectsInGet: 500, maxObjectsInSet: 500, collationAlgorithms: [] },
      'urn:ietf:params:jmap:mail': {},
    },
    accounts: { [accountId]: { name: person, isPersonal: true, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } } },
    primaryAccounts: { 'urn:ietf:params:jmap:mail': accountId },
    username: person,
    apiUrl: `${base}/jmap/api`,
    downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${base}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${base}/jmap/events`,
    state: '1',
  };
}

function jmapCall([name, args, callId], person) {
  const accountId = args?.accountId ?? `acc-${person}`;
  const [, method] = name.split('/');
  if (name === 'Identity/get') return [name, { accountId, state: '1', notFound: [], list: [{ id: 'identity', name: person, email: person, mayDelete: false }] }, callId];
  if (name === 'Mailbox/get') {
    const rights = { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true };
    return [name, { accountId, state: '1', notFound: [], list: [{ id: 'inbox', name: 'Inbox', parentId: null, role: 'inbox', sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: rights, isSubscribed: true }] }, callId];
  }
  if (method === 'get') return [name, { accountId, state: '1', notFound: [], list: [] }, callId];
  if (method === 'query') return [name, { accountId, queryState: '1', canCalculateChanges: false, position: 0, total: 0, ids: [] }, callId];
  if (method === 'changes') return [name, { accountId, oldState: '1', newState: '1', hasMoreChanges: false, created: [], updated: [], destroyed: [] }, callId];
  if (method === 'set') return [name, { accountId, oldState: '1', newState: '1', created: {}, updated: {}, destroyed: [] }, callId];
  return ['error', { type: 'unknownMethod' }, callId];
}

async function jmap(req, res, url) {
  const cors = {
    'access-control-allow-origin': req.headers.origin ?? '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') return send(res, 204, '', cors);
  const person = jmapPerson(req);
  if (!person) return send(res, 401, { type: 'unauthorized' }, cors);
  if (url.pathname === '/.well-known/jmap' || url.pathname === '/jmap/session') return send(res, 200, jmapSession(person), cors);
  if (url.pathname === '/jmap/api') {
    const request = JSON.parse(await read(req) || '{}');
    return send(res, 200, { sessionState: '1', methodResponses: (request.methodCalls ?? []).map((call) => jmapCall(call, person)) }, cors);
  }
  send(res, 404, { type: 'notFound' }, cors);
}

// --- routes ------------------------------------------------------------------

https.createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, async (req, res) => {
  const url = new URL(req.url, base);
  const path = url.pathname;
  try {
    if (path === '/realms/mail/.well-known/openid-configuration') {
      return send(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
      });
    }
    if (path === '/realms/mail/protocol/openid-connect/auth') return authorize(req, res, url);
    if (path === '/realms/mail/protocol/openid-connect/token') return token(req, res);
    if (path === '/realms/mail/protocol/openid-connect/logout') return logout(req, res, url);
    if (path === '/realms/mail/logout/confirm') return finishLogout(res, url.searchParams.get('ticket'));
    if (path === '/.well-known/jmap' || path.startsWith('/jmap/')) return jmap(req, res, url);
    // Test controls.
    if (path === '/__events') return send(res, 200, events);
    if (path === '/__reset') {
      events.length = 0;
      for (const key of Object.keys(nextPerson)) delete nextPerson[key];
      frozenAuthTime = null;
      return send(res, 200, { ok: true });
    }
    if (path === '/__freeze-auth-time') {
      frozenAuthTime = now();
      return send(res, 200, { ok: true });
    }
    if (path === '/__next-person') {
      nextPerson[url.searchParams.get('client')] = url.searchParams.get('person');
      return send(res, 200, { ok: true });
    }
    send(res, 404, page('Not found', ''));
  } catch (error) {
    send(res, 500, { error: String(error) });
  }
}).listen(port, '127.0.0.1', () => console.log(`mock IdP on ${base}, webmail at ${webmail}`));
