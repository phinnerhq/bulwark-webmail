import { randomInt } from 'node:crypto';
import { configManager } from '@/lib/admin/config-manager';
import { fetchJmapSession, postJmap } from '@/lib/stalwart/jmap-api';
import type { StalwartCredentials } from '@/lib/stalwart/credentials';
import { generateMaskLocalPart } from '@/lib/masked-addresses/words';

/**
 * Masked addresses: throwaway addresses on a dedicated domain
 * (MASKED_ADDRESS_DOMAIN) that deliver to the account that made them, for
 * signing up to services without handing out a real address.
 *
 * Each mask is an alias on the person's own Stalwart account, so it delivers,
 * can be sent from, and is turned off by disabling the alias. Stalwart's own
 * masked email is an Enterprise feature; aliases are not. A user cannot edit
 * their own aliases, so the changes go through a service account's API key
 * (MASKED_ADDRESS_API_KEY) limited to reading, finding and updating accounts.
 * Every change touches only the account the caller's own session belongs to.
 */

const STALWART_USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];
const DEFAULT_LIMIT = 100;
const MAX_LABEL_LENGTH = 100;
/** Fresh word pairs to try when the first ones are already taken. */
const CREATE_ATTEMPTS = 8;
/**
 * Description of a deleted mask. Deleting keeps the alias, disabled, so the
 * address can never be handed to someone else, who would then receive mail
 * meant for the person who gave it out.
 */
export const DELETED_MASK_MARK = '\u2063deleted';

export interface MaskedAddress {
  email: string;
  /** What the person noted it is for, e.g. the service it was given to. */
  label: string | null;
  /** A disabled mask is refused by the mail server. */
  enabled: boolean;
}

export interface MaskedAddressConfig {
  domain: string;
  apiKey: string;
  limit: number;
}

export class MaskedAddressError extends Error {
  constructor(readonly status: number, readonly code: string, message = code) {
    super(message);
    this.name = 'MaskedAddressError';
  }
}

/** The configuration, or null while masked addresses are not set up (or Stalwart features are off). */
export function getMaskedAddressConfig(): MaskedAddressConfig | null {
  const domain = process.env.MASKED_ADDRESS_DOMAIN?.trim().toLowerCase() ?? '';
  const apiKey = process.env.MASKED_ADDRESS_API_KEY?.trim() ?? '';
  if (!domain || !apiKey) return null;
  if (!configManager.get<boolean>('stalwartFeaturesEnabled', true)) return null;
  const limit = Number.parseInt(process.env.MASKED_ADDRESS_LIMIT ?? '', 10);
  return { domain, apiKey, limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT };
}

/** A label as stored: trimmed, at most MAX_LABEL_LENGTH characters, null when empty. */
export function normalizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Without the separator a label can never read as the deleted mark.
  const label = value.replace(/⁣/g, '').trim().slice(0, MAX_LABEL_LENGTH);
  return label || null;
}

type MethodCall = [string, Record<string, unknown>, string];
type MethodResponse = [string, Record<string, unknown>, string];

interface Alias {
  name: string;
  domainId: string;
  enabled: boolean;
  description: string | null;
}

/** Stalwart keeps aliases as a list; JMAP shows it as an object keyed by position. */
function aliasList(value: unknown): Alias[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, Partial<Alias>>)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, alias]) => ({
      name: String(alias.name ?? ''),
      domainId: String(alias.domainId ?? ''),
      enabled: alias.enabled !== false,
      description: typeof alias.description === 'string' ? alias.description : null,
    }));
}

function aliasMap(aliases: Alias[]): Record<string, Alias> {
  return Object.fromEntries(aliases.map((alias, index) => [String(index), alias]));
}

/** Talks to Stalwart as the masked-address service account. */
class ServiceClient {
  private accountId: Promise<string> | null = null;

  constructor(private readonly serverUrl: string, private readonly apiKey: string) {}

  private get authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }

  /** The service account's own id, which names the account every management call acts as. */
  private serviceAccountId(): Promise<string> {
    this.accountId ??= fetchJmapSession(this.serverUrl, this.authHeader, { trusted: true }).then((session) => {
      const id = session?.primaryAccounts?.['urn:stalwart:jmap'];
      if (!id) throw new MaskedAddressError(503, 'service_unavailable', 'The masked-address service account cannot sign in');
      return id;
    });
    return this.accountId.catch((error) => {
      this.accountId = null;
      throw error;
    });
  }

  async call(build: (accountId: string) => MethodCall[]): Promise<MethodResponse[]> {
    const accountId = await this.serviceAccountId();
    const response = await postJmap(
      `${this.serverUrl}/jmap/`,
      this.authHeader,
      JSON.stringify({ using: STALWART_USING, methodCalls: build(accountId) }),
      { trusted: true },
    );
    if (!response.ok) {
      throw new MaskedAddressError(502, 'upstream_error', `Mail server answered ${response.status}`);
    }
    const body = await response.json() as { methodResponses?: MethodResponse[] };
    const responses = body.methodResponses ?? [];
    const failed = responses.find(([name]) => name === 'error');
    if (failed) {
      throw new MaskedAddressError(502, 'upstream_error', String(failed[1].description ?? failed[1].type ?? 'JMAP error'));
    }
    return responses;
  }

  /** The id Stalwart gives the domain called `name`, or null when it does not host it. */
  async domainId(name: string): Promise<string | null> {
    const [[, result]] = await this.call((accountId) => [['x:Domain/query', { accountId, filter: { name } }, '0']]);
    const ids = result.ids as string[] | undefined;
    return ids?.[0] ?? null;
  }

  /** The account whose own address is `email`, with its aliases. */
  async accountByEmail(email: string): Promise<{ id: string; aliases: Alias[] } | null> {
    const at = email.lastIndexOf('@');
    if (at <= 0) return null;
    const domainId = await this.domainId(email.slice(at + 1));
    if (!domainId) return null;
    const [, [, got]] = await this.call((accountId) => [
      ['x:Account/query', { accountId, filter: { name: email.slice(0, at), domainId } }, '0'],
      ['x:Account/get', {
        accountId,
        '#ids': { resultOf: '0', name: 'x:Account/query', path: '/ids' },
        properties: ['emailAddress', 'aliases'],
      }, '1'],
    ]);
    // The name filter is a keyword match: confirm it is this exact address.
    const account = (got.list as Array<{ id: string; emailAddress?: string; aliases?: unknown }> | undefined)
      ?.find((candidate) => candidate.emailAddress?.toLowerCase() === email.toLowerCase());
    return account ? { id: account.id, aliases: aliasList(account.aliases) } : null;
  }

  /** Writes the account's whole alias list; resolves to the set error's type when Stalwart refuses it. */
  async writeAliases(id: string, aliases: Alias[]): Promise<string | null> {
    const [[, result]] = await this.call((accountId) => [
      ['x:Account/set', { accountId, update: { [id]: { aliases: aliasMap(aliases) } } }, '0'],
    ]);
    const refused = (result.notUpdated as Record<string, { type?: string }> | undefined)?.[id];
    return refused ? (refused.type ?? 'refused') : null;
  }
}

const clients = new Map<string, ServiceClient>();

function serviceClient(serverUrl: string, apiKey: string): ServiceClient {
  const key = `${serverUrl}\n${apiKey}`;
  let client = clients.get(key);
  if (!client) {
    client = new ServiceClient(serverUrl, apiKey);
    clients.set(key, client);
  }
  return client;
}

/**
 * Changes to one account's aliases run one at a time: each reads the whole
 * list and writes it back, and Stalwart has no compare-and-set for it.
 */
const accountLocks = new Map<string, Promise<unknown>>();

async function withAccountLock<T>(accountId: string, run: () => Promise<T>): Promise<T> {
  const previous = accountLocks.get(accountId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  accountLocks.set(accountId, next);
  try {
    return await next;
  } finally {
    if (accountLocks.get(accountId) === next) accountLocks.delete(accountId);
  }
}

export interface MaskedAddressContext {
  config: MaskedAddressConfig;
  /** The caller's own address, as their live session names it. */
  email: string;
  service: ServiceClient;
}

/**
 * Who is asking, proven by their current session rather than by anything in
 * the request. The service key only ever goes to an admin-configured server.
 */
export async function resolveMaskedAddressContext(
  creds: StalwartCredentials,
  config: MaskedAddressConfig,
): Promise<MaskedAddressContext> {
  if (!creds.trusted) throw new MaskedAddressError(403, 'server_not_supported');
  const session = await fetchJmapSession(creds.serverUrl, creds.authHeader, { trusted: true });
  const email = session?.username?.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new MaskedAddressError(401, 'session_expired');
  return { config, email, service: serviceClient(creds.serverUrl, config.apiKey) };
}

async function loadState(ctx: MaskedAddressContext) {
  const [maskDomainId, account] = await Promise.all([
    ctx.service.domainId(ctx.config.domain),
    ctx.service.accountByEmail(ctx.email),
  ]);
  if (!maskDomainId) throw new MaskedAddressError(503, 'domain_missing', `${ctx.config.domain} is not set up on the mail server`);
  if (!account) throw new MaskedAddressError(404, 'account_not_found');
  return { maskDomainId, account };
}

function isLiveMask(alias: Alias, maskDomainId: string): boolean {
  return alias.domainId === maskDomainId && alias.description !== DELETED_MASK_MARK;
}

function toMasks(aliases: Alias[], maskDomainId: string, domain: string): MaskedAddress[] {
  return aliases
    .filter((alias) => isLiveMask(alias, maskDomainId))
    .map((alias) => ({ email: `${alias.name}@${domain}`, label: alias.description, enabled: alias.enabled }))
    // Newest first: new ones are appended to the list.
    .reverse();
}

/** The local part of a mask on this domain, or null for any other address. */
function maskLocalPart(email: unknown, domain: string): string | null {
  if (typeof email !== 'string') return null;
  const lower = email.trim().toLowerCase();
  const suffix = `@${domain}`;
  return lower.endsWith(suffix) && lower.length > suffix.length ? lower.slice(0, -suffix.length) : null;
}

export async function listMaskedAddresses(ctx: MaskedAddressContext): Promise<MaskedAddress[]> {
  const { maskDomainId, account } = await loadState(ctx);
  return toMasks(account.aliases, maskDomainId, ctx.config.domain);
}

export async function createMaskedAddress(
  ctx: MaskedAddressContext,
  label: string | null,
  random: (n: number) => number = randomInt,
): Promise<MaskedAddress> {
  const { maskDomainId, account } = await loadState(ctx);
  return withAccountLock(account.id, async () => {
    // Re-read inside the lock: another request may have changed the list.
    const current = (await ctx.service.accountByEmail(ctx.email))?.aliases ?? account.aliases;
    if (toMasks(current, maskDomainId, ctx.config.domain).length >= ctx.config.limit) {
      throw new MaskedAddressError(409, 'limit_reached');
    }
    // Deleted masks included: their addresses are never given out again.
    const ownNames = new Set(current.filter((alias) => alias.domainId === maskDomainId).map((alias) => alias.name));
    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      const name = generateMaskLocalPart(random);
      if (ownNames.has(name)) continue;
      const mask: Alias = { name, domainId: maskDomainId, enabled: true, description: label };
      const refused = await ctx.service.writeAliases(account.id, [...current, mask]);
      // Taken by someone else's mask: try another pair.
      if (refused === 'primaryKeyViolation') continue;
      if (refused) throw new MaskedAddressError(502, 'upstream_error', `Mail server refused the mask (${refused})`);
      return { email: `${name}@${ctx.config.domain}`, label, enabled: true };
    }
    throw new MaskedAddressError(503, 'no_free_address');
  });
}

export async function updateMaskedAddress(
  ctx: MaskedAddressContext,
  email: unknown,
  changes: { enabled?: boolean; label?: string | null },
): Promise<MaskedAddress> {
  return changeMask(ctx, email, (alias) => ({
    ...alias,
    ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
    ...(changes.label !== undefined ? { description: changes.label } : {}),
  }));
}

/** Retires a mask for good: it stops delivering and is never given out again. */
export async function deleteMaskedAddress(ctx: MaskedAddressContext, email: unknown): Promise<void> {
  await changeMask(ctx, email, (alias) => ({ ...alias, enabled: false, description: DELETED_MASK_MARK }));
}

/** Replaces one of the caller's live masks. */
async function changeMask(
  ctx: MaskedAddressContext,
  email: unknown,
  change: (alias: Alias) => Alias,
): Promise<MaskedAddress> {
  const name = maskLocalPart(email, ctx.config.domain);
  if (!name) throw new MaskedAddressError(400, 'invalid_address');
  const { maskDomainId, account } = await loadState(ctx);
  return withAccountLock(account.id, async () => {
    const current = (await ctx.service.accountByEmail(ctx.email))?.aliases ?? account.aliases;
    const index = current.findIndex((alias) => isLiveMask(alias, maskDomainId) && alias.name === name);
    // Only the caller's own aliases are ever looked at, so another person's
    // mask is as unknown here as one that does not exist.
    if (index < 0) throw new MaskedAddressError(404, 'not_found');
    const next = change(current[index]);
    const refused = await ctx.service.writeAliases(account.id, current.map((alias, i) => (i === index ? next : alias)));
    if (refused) throw new MaskedAddressError(502, 'upstream_error', `Mail server refused the change (${refused})`);
    return { email: `${next.name}@${ctx.config.domain}`, label: next.description, enabled: next.enabled };
  });
}
