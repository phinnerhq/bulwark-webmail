import { apiFetch } from '@/lib/browser-navigation';
import { getActiveAccountSlotHeaders } from '@/lib/auth/active-account-slot';

/** A masked address, as /api/account/masked-addresses returns it. */
export interface MaskedAddress {
  email: string;
  label: string | null;
  enabled: boolean;
}

export interface MaskedAddressList {
  domain: string;
  limit: number;
  masks: MaskedAddress[];
}

/** Carries the route's error code (`limit_reached`, `session_expired`, …). */
export class MaskedAddressRequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'MaskedAddressRequestError';
  }
}

const ROUTE = '/api/account/masked-addresses';

/** For the active account, whose session cookie slot names the caller. */
async function request<T>(method: string, init: { query?: string; body?: unknown } = {}): Promise<T> {
  const response = await apiFetch(`${ROUTE}${init.query ?? ''}`, {
    method,
    headers: {
      ...getActiveAccountSlotHeaders(),
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new MaskedAddressRequestError(response.status, typeof data.error === 'string' ? data.error : 'internal_error');
  return data as T;
}

export function listMaskedAddresses(): Promise<MaskedAddressList> {
  return request<MaskedAddressList>('GET');
}

export async function createMaskedAddress(label: string): Promise<MaskedAddress> {
  return (await request<{ mask: MaskedAddress }>('POST', { body: { label } })).mask;
}

export async function updateMaskedAddress(
  email: string,
  changes: { enabled?: boolean; label?: string },
): Promise<MaskedAddress> {
  return (await request<{ mask: MaskedAddress }>('PATCH', { body: { email, ...changes } })).mask;
}

export async function deleteMaskedAddress(email: string): Promise<void> {
  await request('DELETE', { query: `?email=${encodeURIComponent(email)}` });
}
