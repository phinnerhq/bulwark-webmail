import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

const account = (username: string) => ({
  label: username, serverUrl: 'https://mail.example.org', username, authMode: 'oauth' as const,
  rememberMe: true, displayName: username, email: username, lastLoginAt: 0,
  isConnected: true, hasError: false, isDefault: false,
});

/** Answers each slot's renewal with its own token, or `status` for the slots in `refused`. */
function stubTokenRoute(refused: number[] = [], status = 401) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const slot = Number(new URL(url, 'http://localhost').searchParams.get('slot'));
    if (url.includes('/api/auth/token') && refused.includes(slot)) {
      return { ok: false, status, json: async () => ({ error: 'Refresh failed' }) };
    }
    return { ok: true, status: 200, json: async () => ({ access_token: `token-${slot}`, expires_in: 3600 }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

let alice: string;
let bob: string;

beforeEach(() => {
  vi.useFakeTimers();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  alice = useAccountStore.getState().addAccount(account('alice@example.org'));
  bob = useAccountStore.getState().addAccount(account('bob@example.org'));
  useAccountStore.getState().updateAccount(alice, { cookieSlot: 0 });
  useAccountStore.getState().updateAccount(bob, { cookieSlot: 1 });
  useAuthStore.setState({ isAuthenticated: true, activeAccountId: alice, authMode: 'oauth', accessToken: 'alice-old' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('refreshAccessToken for an account other than the active one', () => {
  it("renews that account's slot and leaves the active session alone", async () => {
    const fetchMock = stubTokenRoute();

    await expect(useAuthStore.getState().refreshAccessToken({ accountId: bob })).resolves.toBe('token-1');

    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/api/auth/token'))).toEqual([
      expect.stringContaining('slot=1'),
    ]);
    expect(useAuthStore.getState().accessToken).toBe('alice-old');
  });

  it('marks only that account as needing a sign-in when its renewal is refused', async () => {
    stubTokenRoute([1]);

    await expect(useAuthStore.getState().refreshAccessToken({ accountId: bob })).resolves.toBeNull();

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().activeAccountId).toBe(alice);
    expect(useAccountStore.getState().getAccountById(bob)).toMatchObject({ isConnected: false, hasError: true });
  });

  it('renews nothing for an account still signing in', async () => {
    const fetchMock = stubTokenRoute();

    await expect(useAuthStore.getState().refreshAccessToken({ accountId: 'not-registered-yet' })).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
