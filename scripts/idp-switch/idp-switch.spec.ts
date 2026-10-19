import { expect, test, type Page } from "@playwright/test";

// The provider (mock-idp.mjs) keeps one session per browser and refuses to
// sign in someone other than its person, like Keycloak. North signs in Alice,
// South signs in Bob.

const idp = "https://127.0.0.1:3171";

interface IdpEvent {
  type: string;
  person?: string;
}

async function idpEvents(page: Page): Promise<IdpEvent[]> {
  return (await page.request.get(`${idp}/__events`)).json();
}

async function signInWith(page: Page, provider: "North" | "South") {
  await page.goto("/en/login");
  await page.getByRole("group", { name: "Choose how to sign in" }).getByRole("button", { name: provider }).click();
}

async function expectMailView(page: Page) {
  await expect(page.getByTestId("account-switcher").first()).toBeVisible({ timeout: 30_000 });
}

async function addAccountWith(page: Page, provider: "North" | "South") {
  await page.goto("/en/login?mode=add-account");
  await page.getByRole("combobox", { name: "Server" }).selectOption({ label: provider });
  await page.getByRole("button", { name: "Sign in with SSO" }).click();
}

/** Refreshes a signed-in slot's token the way the app does; true when the provider still honours it. */
async function refreshes(page: Page, slot: number): Promise<boolean> {
  return page.evaluate(async (s) => (await fetch(`/api/auth/token?slot=${s}&force=true`, { method: "PUT" })).ok, slot);
}

test.beforeEach(async ({ page }) => {
  await page.request.get(`${idp}/__reset`);
});

test("another provider, while the provider still holds the last person's session", async ({ page, context }) => {
  await signInWith(page, "North");
  await expectMailView(page);

  // The webmail forgot the sign-in, the provider did not: a sign-out that never
  // reached it. Only which provider was used last is left on this browser.
  await page.evaluate(() => {
    const last = localStorage.getItem("login_last_server_id");
    localStorage.clear();
    sessionStorage.clear();
    if (last) localStorage.setItem("login_last_server_id", last);
  });
  await context.clearCookies({ domain: "localhost" });

  await signInWith(page, "South");
  // No id token is left to name the session, so the provider asks once.
  await page.locator("#confirm-logout").click();
  await expectMailView(page);

  const events = await idpEvents(page);
  expect(events.filter((e) => e.type === "different_user_authenticated")).toEqual([]);
  expect(events.filter((e) => e.type === "login").map((e) => e.person)).toEqual(["alice@example.com", "bob@example.com"]);
});

test("sign-out ends the provider session without a provider page, then the other provider signs in", async ({ page }) => {
  await signInWith(page, "North");
  await expectMailView(page);

  await page.getByTestId("account-switcher").first().click();
  await page.getByRole("menuitem", { name: "Sign out of alice@example.com" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });

  await signInWith(page, "South");
  await expectMailView(page);

  const events = await idpEvents(page);
  expect(events.filter((e) => e.type === "logout_confirmation")).toEqual([]);
  expect(events.filter((e) => e.type === "different_user_authenticated")).toEqual([]);
  expect(events.filter((e) => e.type === "login").map((e) => e.person)).toEqual(["alice@example.com", "bob@example.com"]);
});

test("adding an account at the other provider keeps the first one signed in", async ({ page }) => {
  await signInWith(page, "North");
  await expectMailView(page);

  await addAccountWith(page, "South");
  await expectMailView(page);

  const events = await idpEvents(page);
  expect(events.filter((e) => e.type === "different_user_authenticated")).toEqual([]);
  expect(events.filter((e) => e.type === "logout_confirmation")).toEqual([]);
  expect(events.filter((e) => e.type === "login").map((e) => e.person)).toEqual(["alice@example.com", "bob@example.com"]);
  // Alice's session at the provider ended for Bob's sign-in; her offline
  // refresh token outlives it.
  expect(await refreshes(page, 0)).toBe(true);
  expect(await refreshes(page, 1)).toBe(true);
});

test("adding an account ends the session of the latest sign-in, not of the active account", async ({ page }) => {
  // Sign-ins within the same second, which auth_time alone cannot order.
  await page.request.get(`${idp}/__freeze-auth-time`);
  await signInWith(page, "North");
  await expectMailView(page);
  await addAccountWith(page, "South");
  await expectMailView(page);

  // Back to Alice, then add Carol at North: the provider's session is Bob's.
  await page.getByTestId("account-switcher").first().click();
  await page.getByTestId("account-option").filter({ hasText: "alice@example.com" }).click();
  await page.request.get(`${idp}/__next-person?client=webmail-north&person=carol@example.com`);
  await addAccountWith(page, "North");
  await expectMailView(page);

  const events = await idpEvents(page);
  expect(events.filter((e) => e.type === "logout_confirmation")).toEqual([]);
  expect(events.filter((e) => e.type === "different_user_authenticated")).toEqual([]);
  expect(events.filter((e) => e.type === "login").map((e) => e.person)).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
});

test("adding an account the mail server refuses leaves the first one as it was", async ({ page }) => {
  await signInWith(page, "North");
  await expectMailView(page);

  // Bob signs in at the provider, but the mail server hosts no mailbox for him.
  await page.request.get(`${idp}/__no-mailbox?person=bob@example.com`);
  await addAccountWith(page, "South");
  await expect(page.getByText("the mail server has no mailbox for this account")).toBeVisible({ timeout: 30_000 });

  // Alice was not signed in again in Bob's place, nor moved to his slot.
  const accounts = await page.evaluate(() => JSON.parse(localStorage.getItem("account-registry") ?? "null")?.state?.accounts ?? []);
  expect(accounts.map((a: { username: string; cookieSlot: number }) => [a.username, a.cookieSlot])).toEqual([["alice@example.com", 0]]);

  await page.getByRole("button", { name: "Back to mail" }).click();
  await expectMailView(page);
  await expect(page.getByText("alice@example.com").first()).toBeVisible();
  expect(await refreshes(page, 0)).toBe(true);
});

test("a sign-in left unfinished in the browser does not claim the next one's return", async ({ page }) => {
  // What a failed or abandoned browser-side sign-in (adding an account) leaves.
  await page.goto("/en/login");
  await page.evaluate(() => {
    sessionStorage.setItem("oauth_state", "left-behind");
    sessionStorage.setItem("oauth_code_verifier", "left-behind");
    sessionStorage.setItem("oauth_server_url", "https://127.0.0.1:3171");
  });

  await signInWith(page, "South");
  await expectMailView(page);
});

test("masked addresses: make one, turn it off and delete it from Settings", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInWith(page, "North");
  await expectMailView(page);
  const stored = async () => (await page.request.get(`${idp}/__aliases?person=alice@example.com`)).json();

  await page.goto("/settings/masked_addresses");
  await page.getByTestId("masked-address-label").fill("Netflix");
  await page.getByTestId("masked-address-create").click();

  const row = page.getByTestId("masked-address");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Netflix");
  const email = (await row.locator(".font-mono").textContent()) ?? "";
  expect(email).toMatch(/^[a-z]+\.[a-z]+@anon\.example\.com$/);
  // A new mask is copied, ready to paste into the sign-up form.
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(email);
  expect(await stored()).toEqual([{ name: email.split("@")[0], domainId: "f", enabled: true, description: "Netflix" }]);

  await row.getByTestId("masked-address-toggle").click();
  await expect(row.getByTestId("masked-address-toggle")).toHaveAttribute("aria-checked", "false");
  expect((await stored())[0].enabled).toBe(false);

  await row.getByRole("button", { name: `Delete ${email}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  // Kept, switched off, so the address is never handed to anyone else.
  expect((await stored())[0]).toMatchObject({ name: email.split("@")[0], enabled: false });
});
