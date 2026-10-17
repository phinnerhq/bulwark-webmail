import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '@/locales/en/common.json';
import { createConfig } from '@/lib/__tests__/fixtures/config';
import type { ConfigData } from '@/hooks/use-config';
import type { PublicJmapServerEntry } from '@/lib/admin/jmap-servers';

// The login page with OAUTH_ONLY and several servers: one button per identity
// provider, each starting the server-side SSO for its own entry on a click.
// Everywhere else the page keeps its server menu.

// The real English strings, so buttons and groups are found by what users read.
vi.mock('next-intl', () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, string>) => {
    const text = `${namespace}.${key}`.split('.').reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      messages,
    );
    if (typeof text !== 'string') return key;
    return text.replace(/\{(\w+)\}/g, (_, name: string) => values?.[name] ?? `{${name}}`);
  },
}));

let config: ConfigData;
vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({ ...config, isLoading: false, error: null }),
}));

let search = '';
vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const { default: LoginPage } = await import('@/app/(main)/[locale]/login/page');
const { LAST_IDP_KEY } = await import('@/components/auth/idp-sign-in-list');

// Two providers: one mail server, one issuer, a client each.
const SERVERS: PublicJmapServerEntry[] = [
  {
    id: 'north',
    label: 'North',
    url: 'https://mail.example.com',
    domains: [],
    icon: 'https://north.example/icon.svg',
    oauth: { clientId: 'webmail-north', issuerUrl: 'https://sso.example.com/realms/mail' },
  },
  {
    id: 'south',
    label: 'South',
    url: 'https://mail.example.com',
    domains: [],
    oauth: { clientId: 'webmail-south', issuerUrl: 'https://sso.example.com/realms/mail' },
  },
];

const ssoStarts: Array<Record<string, unknown>> = [];
let ssoStartStatus = 200;

beforeEach(() => {
  search = '';
  ssoStarts.length = 0;
  ssoStartStatus = 200;
  localStorage.clear();
  sessionStorage.clear();
  config = createConfig({
    jmapServerUrl: '',
    oauthEnabled: true,
    oauthOnly: true,
    jmapServers: SERVERS,
    loginShowVersion: false,
  });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/auth/sso/start')) {
      ssoStarts.push(JSON.parse(String(init?.body)));
      // A same-document URL, so jsdom can follow it.
      return new Response(JSON.stringify({ authorize_url: '#authorize' }), { status: ssoStartStatus });
    }
    if (url.includes('/api/auth/oauth/metadata')) {
      return new Response(JSON.stringify({ issuer: 'https://idp.example', authorization_endpoint: 'https://idp.example/auth', token_endpoint: 'https://idp.example/token' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

function renderPage() {
  return render(<LoginPage />);
}

const providerButtons = () =>
  within(screen.getByRole('group', { name: 'Choose how to sign in' })).getAllByRole('button');
const providerOrder = () => providerButtons().map((b) => b.lastElementChild?.textContent);

describe('login with several identity providers', () => {
  it('shows a named button per provider, icon first, in place of the server menu', () => {
    renderPage();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in with SSO' })).toBeNull();

    const [north, south] = providerButtons();
    expect(north).toHaveAccessibleName('North');
    expect(south).toHaveAccessibleName('South');
    // The icon is decoration: the label names the button.
    const icon = north.querySelector('img');
    expect(icon).toHaveAttribute('src', 'https://north.example/icon.svg');
    expect(icon).toHaveAttribute('alt', '');
    expect(north.firstElementChild).toBe(icon);
    // Without an icon: the label's initial.
    expect(south.firstElementChild).toHaveTextContent('S');
    expect(south.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('starts the SSO for the clicked provider in one click, and remembers it', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'South' }));

    await waitFor(() => expect(window.location.hash).toBe('#authorize'));
    expect(ssoStarts).toHaveLength(1);
    expect(ssoStarts[0]).toMatchObject({ server_id: 'south', locale: 'en' });
    expect(localStorage.getItem(LAST_IDP_KEY)).toBe('south');
  });

  it('is reachable from the keyboard', () => {
    renderPage();
    for (const button of providerButtons()) {
      // Native, enabled buttons in the tab order: Tab reaches them, Enter and Space press them.
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveAttribute('type', 'button');
      expect(button).toBeEnabled();
      expect(button.tabIndex).toBe(0);
    }
  });

  it('keeps config order, with no primary before a choice', () => {
    renderPage();
    expect(providerOrder()).toEqual(['North', 'South']);
    expect(providerButtons().some((b) => b.hasAttribute('data-primary'))).toBe(false);
  });

  it('gives the last choice the primary style, in config order', async () => {
    localStorage.setItem(LAST_IDP_KEY, 'south');
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'South' })).toHaveAttribute('data-primary', 'true'));
    expect(providerOrder()).toEqual(['North', 'South']);
    expect(screen.getByRole('button', { name: 'North' })).not.toHaveAttribute('data-primary');
    // Remembered, not chosen: nothing starts on its own.
    expect(ssoStarts).toHaveLength(0);
  });

  it('ignores a remembered provider that is no longer configured', async () => {
    localStorage.setItem(LAST_IDP_KEY, 'gone');
    renderPage();
    await act(async () => {});
    expect(providerButtons().some((b) => b.hasAttribute('data-primary'))).toBe(false);
  });

  it('says so when the sign-in could not start, and lets the user pick again', async () => {
    ssoStartStatus = 502;
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'North' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't start signing in with North. Try again.");
    expect(screen.getByRole('button', { name: 'South' })).toBeEnabled();
  });
});

describe('login pages that keep the server menu', () => {
  const expectServerMenu = async () => {
    expect(await screen.findByRole('combobox', { name: 'Server' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Choose how to sign in' })).toBeNull();
  };

  it('password sign-in (OAUTH_ONLY off)', async () => {
    config = { ...config, oauthOnly: false };
    renderPage();
    await expectServerMenu();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('adding an account', async () => {
    search = 'mode=add-account';
    renderPage();
    await expectServerMenu();
  });

  it('the mobile hand-off', async () => {
    search = 'mobile_redirect_uri=bulwarkmobile%3A%2F%2Fauth%2Fcallback&mobile_state=s';
    renderPage();
    await expectServerMenu();
  });

  it('a single server, signed in with the one SSO button', async () => {
    config = { ...config, jmapServers: [SERVERS[0]] };
    renderPage();
    expect(await screen.findByRole('button', { name: 'Sign in with SSO' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Choose how to sign in' })).toBeNull();
  });

  it('auto-SSO with a single server still signs in on its own', async () => {
    config = { ...config, jmapServers: [SERVERS[0]], autoSsoEnabled: true };
    await act(async () => { renderPage(); });
    await waitFor(() => expect(ssoStarts[0]).toMatchObject({ server_id: 'north' }));
  });
});
