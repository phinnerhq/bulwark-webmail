import { defineConfig } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Signing in as someone else at a provider that keeps one session per browser
// (Keycloak): switching between the login page's providers, and adding an
// account at another one. Runs a production build against the mock provider
// in mock-idp.mjs, which also serves the JMAP accounts.
//
//   npx next build
//   npm run test:idp-switch
const webmailPort = 3170;
const idpPort = 3171;
const webmail = `http://localhost:${webmailPort}`;
const idp = `https://127.0.0.1:${idpPort}`;
const workDir = mkdtempSync(join(tmpdir(), "idp-switch-"));

// The provider serves https with a certificate made for this run: the webmail
// server trusts it through NODE_EXTRA_CA_CERTS, the browser ignores it.
const cert = join(workDir, "cert.pem");
const key = join(workDir, "key.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
  "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  "-keyout", key, "-out", cert,
], { stdio: "ignore" });

const server = (id: string, label: string) => ({
  id,
  label,
  url: idp,
  oauth: { clientId: `webmail-${id}`, issuerUrl: `${idp}/realms/mail` },
});

export default defineConfig({
  testDir: ".",
  testMatch: /idp-switch\.spec\.ts$/,
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: webmail, locale: "en-US", ignoreHTTPSErrors: true },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      command: `node scripts/idp-switch/mock-idp.mjs ${idpPort} ${webmail} ${cert} ${key}`,
      url: `${idp}/realms/mail/.well-known/openid-configuration`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      cwd: process.cwd(),
    },
    {
      command: `npx next start -p ${webmailPort}`,
      url: `${webmail}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      cwd: process.cwd(),
      env: {
        OAUTH_ENABLED: "true",
        OAUTH_ONLY: "true",
        // Accounts outlive the provider session ended for the next sign-in.
        OAUTH_EXTRA_SCOPES: "offline_access",
        OAUTH_POST_LOGOUT_REDIRECT_URI: `${webmail}/`,
        OAUTH_ALLOW_PRIVATE_ENDPOINTS: "true",
        JMAP_SERVER_URL: idp,
        JMAP_SERVERS: JSON.stringify([server("north", "North"), server("south", "South")]),
        SESSION_SECRET: "idp-switch-session-secret-0123456789abcdef",
        NODE_EXTRA_CA_CERTS: cert,
        ADMIN_CONFIG_DIR: join(workDir, "config"),
        ADMIN_STATE_DIR: join(workDir, "state"),
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
