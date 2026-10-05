import { createRequestHandler } from "@remix-run/cloudflare";

let handleRemixRequest;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isAsset = url.pathname.startsWith("/assets/") || /\.[a-zA-Z0-9]{2,8}$/.test(url.pathname);

    if (isAsset && env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) return assetResponse;
    }

    // Remix 2 / Wrangler 3 compatibility: expose bindings before the server
    // bundle is first evaluated. The Shopify app is created at module load time.
    globalThis.__CLOUDFLARE_DB__ = env.DB;
    globalThis.process ??= { env: {} };
    globalThis.process.env ??= {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") globalThis.process.env[key] = value;
    }
    globalThis.process.env.NODE_ENV = "production";

    if (!handleRemixRequest) {
      const build = await import("../build/server/index.js");
      handleRemixRequest = createRequestHandler(build, "production");
    }

    return handleRemixRequest(request, { cloudflare: { env, ctx } });
  },
};
