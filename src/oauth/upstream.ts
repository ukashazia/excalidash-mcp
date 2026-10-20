import type { IncomingMessage } from "node:http";
export type User = {
  id: string;
  name?: string;
  email?: string;
  mustResetPassword?: boolean;
};
export class UpstreamError extends Error {
  constructor(readonly status: number) {
    super("ExcaliDash request failed");
  }
}
export function cookies(req: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const key = part.slice(0, i).trim(),
      value = part.slice(i + 1).trim();
    if (result[key] !== undefined) throw new UpstreamError(400);
    result[key] = value;
  }
  return result;
}
export class ExcaliDashAccounts {
  readonly base: string;
  constructor(
    url: string,
    readonly origin: string,
    readonly proxyProto?: "https",
  ) {
    const base = url.replace(/\/+$/, "");
    this.base = base.endsWith("/api") ? base : base + "/api";
  }
  private cookie(req: IncomingMessage) {
    const all = cookies(req);
    return ["excalidash-access-token", "excalidash-csrf-client"]
      .filter((k) => all[k])
      .map((k) => `${k}=${all[k]}`)
      .join("; ");
  }
  private async call(path: string, cookie: string, init: RequestInit = {}) {
    return fetch(this.base + path, {
      ...init,
      headers: {
        Accept: "application/json",
        Cookie: cookie,
        Origin: this.origin,
        ...(this.proxyProto ? { "X-Forwarded-Proto": this.proxyProto } : {}),
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  }
  async user(req: IncomingMessage): Promise<User | null> {
    const cookie = this.cookie(req);
    if (!cookie.includes("excalidash-access-token=")) return null;
    const r = await this.call("/auth/me", cookie);
    if ([401, 403].includes(r.status)) {
      await r.body?.cancel();
      return null;
    }
    if (!r.ok) throw new UpstreamError(503);
    const { user } = (await r.json()) as { user?: User };
    if (!user?.id || user.mustResetPassword) return null;
    return user;
  }
  private async csrf(req: IncomingMessage) {
    let cookie = this.cookie(req);
    const r = await this.call("/csrf-token", cookie);
    if (!r.ok) throw new UpstreamError(503);
    const data = (await r.json()) as { token: string; header: string };
    const set = r.headers
      .getSetCookie()
      .find((s) => s.startsWith("excalidash-csrf-client="));
    if (set)
      cookie = cookie
        .split("; ")
        .filter((s) => !s.startsWith("excalidash-csrf-client="))
        .concat(set.split(";")[0]!)
        .join("; ");
    if (!data.token || data.header.toLowerCase() !== "x-csrf-token")
      throw new UpstreamError(503);
    return { cookie, token: data.token };
  }
  async createKey(req: IncomingMessage, name: string, scopes: string[]) {
    const { cookie, token } = await this.csrf(req);
    const r = await this.call("/auth/api-keys", cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": token },
      body: JSON.stringify({ name, scopes }),
    });
    if (!r.ok) throw new UpstreamError(r.status === 403 ? 403 : 503);
    const data = (await r.json()) as { token: string; apiKey: { id: string } };
    if (!/^exd_[A-Za-z0-9_-]+$/.test(data.token) || !data.apiKey?.id)
      throw new UpstreamError(503);
    return { token: data.token, id: data.apiKey.id };
  }
  async revokeKey(req: IncomingMessage, keyId: string) {
    const { cookie, token } = await this.csrf(req);
    const r = await this.call(
      "/auth/api-keys/" + encodeURIComponent(keyId),
      cookie,
      { method: "DELETE", headers: { "x-csrf-token": token } },
    );
    await r.body?.cancel();
    if (!r.ok && r.status !== 404) throw new UpstreamError(503);
  }
  async keyValid(key: string) {
    const r = await fetch(this.base + "/drawings?limit=1&offset=0", {
      headers: {
        Authorization: "Bearer " + key,
        ...(this.proxyProto ? { "X-Forwarded-Proto": this.proxyProto } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 403) {
      const detail = (await r.json()) as { error?: string; message?: string };
      return (
        detail.error === "Forbidden" &&
        detail.message === "API key is not authorized for this route"
      );
    }
    await r.arrayBuffer();
    if (r.ok) return true;
    if (r.status === 401) return false;
    throw new UpstreamError(503);
  }
}
