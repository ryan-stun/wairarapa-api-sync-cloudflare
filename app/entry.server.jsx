import { renderToReadableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

const ABORT_DELAY = 5000;

export default async function handleRequest(request, responseStatusCode, responseHeaders, remixContext) {
  addDocumentResponseHeaders(request, responseHeaders);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ABORT_DELAY);

  const body = await renderToReadableStream(
    <RemixServer context={remixContext} url={request.url} abortDelay={ABORT_DELAY} />,
    { signal: controller.signal, onError(error) { console.error(error); responseStatusCode = 500; } },
  );

  if (isbot(request.headers.get("user-agent") ?? "")) await body.allReady;
  clearTimeout(timeout);
  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
