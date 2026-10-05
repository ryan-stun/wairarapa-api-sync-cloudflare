import { authenticate } from "../shopify.server";
import { sessionStorage } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, shop, session, admin } = await authenticate.webhook(request);

  switch (topic) {
    case "APP_UNINSTALLED":
      await sessionStorage.deleteSessionsForShop(shop);

      break;
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};
