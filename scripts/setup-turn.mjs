#!/usr/bin/env node
/**
 * Provision a Cloudflare Realtime TURN key and store it as Worker secrets.
 *
 * Why this is not automatic: the OAuth token `wrangler login` grants does not
 * include the Realtime scope, so a key cannot be created with the credentials
 * the CLI already has. One API token has to be made by hand; everything after
 * that is handled here.
 *
 *   1. https://dash.cloudflare.com/profile/api-tokens -> Create Token
 *      -> Custom token, permission: Account | Cloudflare Realtime | Edit
 *   2. CLOUDFLARE_API_TOKEN=xxx npm run setup:turn
 *
 * Existing TURN_KEY_ID / TURN_KEY_API_TOKEN secrets are left alone unless
 * --force is passed, so re-running is safe.
 */
import { execFileSync } from "node:child_process";

const API = "https://api.cloudflare.com/client/v4";
const token = process.env.CLOUDFLARE_API_TOKEN;
const force = process.argv.includes("--force");

function die(message, hint) {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
}

if (!token) {
  die(
    "CLOUDFLARE_API_TOKEN is not set.",
    "Create one with Account > Cloudflare Realtime > Edit, then:\n" +
      "    CLOUDFLARE_API_TOKEN=xxx npm run setup:turn",
  );
}

async function cf(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!body.success) {
    const reason = body.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || res.status;
    throw new Error(reason);
  }
  return body.result;
}

console.log("\n  Looking up your account...");
const accounts = await cf("/accounts?per_page=50").catch((e) =>
  die(`Could not list accounts (${e.message}).`, "Is the token valid, with Account read access?"),
);

if (accounts.length === 0) die("No accounts are visible to this token.");
if (accounts.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("\n  Several accounts are visible. Pick one and re-run with:");
  for (const a of accounts) console.error(`    CLOUDFLARE_ACCOUNT_ID=${a.id}   # ${a.name}`);
  process.exit(1);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? accounts[0].id;
console.log(`  Account: ${accountId}`);

console.log("  Creating a TURN key...");
const key = await cf(`/accounts/${accountId}/calls/turn_keys`, {
  method: "POST",
  body: JSON.stringify({ name: "talkspace" }),
}).catch((e) =>
  die(
    `Could not create the TURN key (${e.message}).`,
    "The token needs the 'Cloudflare Realtime: Edit' permission on this account.",
  ),
);

// The field names have varied across API revisions; accept either shape.
const keyId = key.uid ?? key.id;
const keySecret = key.key ?? key.secret ?? key.api_token;

if (!keyId || !keySecret) {
  die(`Unexpected API response: ${JSON.stringify(key).slice(0, 200)}`);
}
console.log(`  TURN key created: ${keyId}`);

function putSecret(name, value) {
  execFileSync("npx", ["wrangler", "secret", "put", name, ...(force ? [] : [])], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

console.log("\n  Storing secrets on the Worker...");
putSecret("TURN_KEY_ID", keyId);
putSecret("TURN_KEY_API_TOKEN", keySecret);

console.log(`
  Done. Redeploy for it to take effect:

      npm run deploy

  Then confirm with:

      curl -s https://<your-worker>/api/ice | grep hasTurn

  Cost: TURN egress is billed at $0.05/GB after a free 1,000 GB per month.
  Only the minority of connections that cannot go direct use the relay at
  all, so typical usage stays inside the free allowance.
`);
