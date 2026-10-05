# Wairarapa API Sync — Cloudflare deployment

This copy is configured for Cloudflare Workers + D1.

## Architecture

- Cloudflare Worker: hosts the embedded Remix Shopify app.
- Worker Static Assets: serves the Vite client build.
- Cloudflare D1: stores Shopify authentication sessions only.
- Tourism NZ / Eventfinda data is not stored in D1.
- Syncs run inside the initiating HTTP request. This deliberately avoids detached Node background work that is unsafe on a serverless Worker.

## Before the first deployment

1. In Cloudflare, create a D1 database named `wairarapa-api-sync-db`.
2. Copy its Database ID into `wrangler.jsonc`, replacing the all-zero placeholder.
3. In the D1 console, execute the SQL in `migrations/0001_sessions.sql` once.
4. Commit and push the Cloudflare-ready project to GitHub.

## Cloudflare Worker secrets / variables

Set these as encrypted secrets in the Worker settings:

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `TOURISM_NZ_BEARER_TOKEN`
- `EVENTFINDA_API_USERNAME`
- `EVENTFINDA_API_PASSWORD`

Set these as variables:

- `SCOPES=read_product_listings,read_products,write_products` (already present in `wrangler.jsonc`)
- `SHOPIFY_APP_URL=https://YOUR-PRODUCTION-HOSTNAME`

Do not commit `.env` or `.env.local`.

## Build / deploy commands

Cloudflare build command:

    npm run build

Cloudflare deploy command:

    npx wrangler deploy

For a manual deployment from your own machine:

    npm install
    npm run build
    npx wrangler deploy

## Shopify URL configuration

After the Worker has a permanent hostname, replace the development tunnel URL in `shopify.app.toml`:

    application_url = "https://YOUR-PRODUCTION-HOSTNAME"

and use the same host for all three redirect URLs. Then run:

    npm run deploy:shopify

This updates Shopify's app configuration; it does not deploy the Worker.

## D1 session schema

The only D1 table is `Session`. It contains Shopify OAuth/session credentials and should not be exposed publicly.

## Local development

The original `shopify app dev` workflow is retained. The Cloudflare dev proxy reads `wrangler.jsonc`; create/apply a local D1 migration before testing auth locally with the Cloudflare runtime:

    npx wrangler d1 migrations apply wairarapa-api-sync-db --local
    npm run dev

The production D1 database is separate from the local emulated D1 database.

## Important sync behavior change

The old app returned immediately and continued syncing through `setImmediate()`. Cloudflare Workers cannot safely rely on that Node-server behavior. In this version the request stays open until the sync and any product deletions finish. The UI displays a syncing state during the request and reports completion afterward.
