import { Session } from "@shopify/shopify-api";

function database() {
  const db = globalThis.__CLOUDFLARE_DB__;
  if (!db) {
    throw new Error("Cloudflare D1 binding DB is not available for this request");
  }
  return db;
}

export class D1SessionStorage {
  async storeSession(session) {
    const params = session.toObject();
    const userId = params.onlineAccessInfo?.associated_user?.id ?? null;
    await database().prepare(`
      INSERT INTO Session (id, shop, state, isOnline, scope, expires, accessToken, userId)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        shop=excluded.shop, state=excluded.state, isOnline=excluded.isOnline,
        scope=excluded.scope, expires=excluded.expires,
        accessToken=excluded.accessToken, userId=excluded.userId
    `).bind(
      session.id, session.shop, session.state, session.isOnline ? 1 : 0,
      session.scope ?? null, session.expires?.getTime() ?? null,
      session.accessToken ?? "", userId != null ? String(userId) : null,
    ).run();
    return true;
  }

  async loadSession(id) {
    const row = await database().prepare("SELECT * FROM Session WHERE id = ?").bind(id).first();
    return row ? this.rowToSession(row) : undefined;
  }

  async deleteSession(id) {
    await database().prepare("DELETE FROM Session WHERE id = ?").bind(id).run();
    return true;
  }

  async deleteSessions(ids) {
    if (!ids?.length) return true;
    await database().batch(ids.map((id) => database().prepare("DELETE FROM Session WHERE id = ?").bind(id)));
    return true;
  }

  async deleteSessionsForShop(shop) {
    await database().prepare("DELETE FROM Session WHERE shop = ?").bind(shop).run();
    return true;
  }

  async findSessionsByShop(shop) {
    const result = await database().prepare(
      "SELECT * FROM Session WHERE shop = ? ORDER BY expires DESC LIMIT 25"
    ).bind(shop).all();
    return (result.results ?? []).map((row) => this.rowToSession(row));
  }

  rowToSession(row) {
    const session = new Session({
      id: row.id,
      shop: row.shop,
      state: row.state,
      isOnline: Boolean(row.isOnline),
      scope: row.scope ?? undefined,
      expires: row.expires ? new Date(Number(row.expires)) : undefined,
      accessToken: row.accessToken || undefined,
    });
    return session;
  }
}
