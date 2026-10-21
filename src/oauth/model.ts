import OAuth2Server from "@node-oauth/oauth2-server";
import { hash, randomToken } from "./crypto.js";
import type { Repository, Entry } from "./store.js";

export const SCOPES = ["drawings:read", "drawings:write"];
export const toolScope = (name: string) =>
  ["create_drawing", "update_drawing"].includes(name)
    ? "drawings:write"
    : "drawings:read";
export const ACCESS_MS = 10 * 60_000;
export const GRANT_MS = 30 * 24 * 60 * 60_000;
export const pendingMs = 10 * 60_000;
export async function grant(
  repo: Repository,
  id: string,
): Promise<Entry | null> {
  const g = await repo.get("grant", id);
  return g && !g.revokedAt && g.expiresAt > Date.now() ? g : null;
}
export async function revokeGrant(repo: Repository, g: Entry) {
  await repo.put(
    "grant",
    g.id,
    { ...g, revokedAt: Date.now(), encryptedKey: "" },
    g.expiresAt,
  );
}

export function oauthModel(
  repo: Repository,
  resource: string,
  requestClient?: string,
) {
  const getClient = async (id: string, secret?: string) => {
    if (secret) return false;
    const c = await repo.get("client", id);
    return c
      ? {
          id,
          redirectUris: c.redirect_uris,
          grants: ["authorization_code", "refresh_token"],
        }
      : false;
  };
  const getGrant = (id: string) => grant(repo, id);
  return {
    getClient,
    generateAccessToken: async () => randomToken("mcp_at_"),
    generateRefreshToken: async () => randomToken("mcp_rt_"),
    generateAuthorizationCode: async () => randomToken("mcp_code_"),
    validateScope: async (
      user: OAuth2Server.User,
      _client: OAuth2Server.Client,
      scopes?: string[],
    ) => {
      const g = await getGrant(user.grantId);
      return g &&
        scopes?.length &&
        scopes.every((s) => SCOPES.includes(s) && g.scopes.includes(s))
        ? scopes
        : false;
    },
    saveAuthorizationCode: async (
      code: Pick<
        OAuth2Server.AuthorizationCode,
        | "authorizationCode"
        | "expiresAt"
        | "redirectUri"
        | "scope"
        | "codeChallenge"
        | "codeChallengeMethod"
      >,
      client: OAuth2Server.Client,
      user: OAuth2Server.User,
    ) => {
      await repo.put(
        "code",
        hash(code.authorizationCode),
        {
          redirectUri: code.redirectUri,
          scope: code.scope,
          codeChallenge: code.codeChallenge,
          codeChallengeMethod: code.codeChallengeMethod,
          expiresAt: code.expiresAt.getTime(),
          clientId: client.id,
          grantId: user.grantId,
          used: false,
          resource,
        },
        code.expiresAt.getTime(),
      );
      return { ...code, client, user };
    },
    getAuthorizationCode: async (value: string) => {
      const c = await repo.get("code", hash(value), true);
      if (!c || c.clientId !== requestClient || c.resource !== resource)
        return false;
      const g = await getGrant(c.grantId);
      if (!g) return false;
      if (c.used) {
        await revokeGrant(repo, g);
        return false;
      }
      const client = await getClient(c.clientId);
      if (!client) return false;
      return {
        ...c,
        authorizationCode: value,
        redirectUri: c.redirectUri,
        expiresAt: new Date(c.expiresAt),
        client,
        user: { grantId: g.id },
      } as OAuth2Server.AuthorizationCode;
    },
    revokeAuthorizationCode: async (code: OAuth2Server.AuthorizationCode) => {
      const c = await repo.get("code", hash(code.authorizationCode), true);
      if (!c || c.used) return false;
      await repo.put(
        "code",
        hash(code.authorizationCode),
        { ...c, used: true },
        c.expiresAt,
      );
      return true;
    },
    saveToken: async (
      token: Omit<OAuth2Server.Token, "client" | "user">,
      client: OAuth2Server.Client,
      user: OAuth2Server.User,
    ) => {
      const g = await getGrant(user.grantId);
      if (!g)
        throw new OAuth2Server.InvalidGrantError(
          "Connection revoked or expired",
        );
      const accessTokenExpiresAt = new Date(
        Math.min(token.accessTokenExpiresAt!.getTime(), g.expiresAt),
      );
      const refreshTokenExpiresAt = new Date(
        Math.min(token.refreshTokenExpiresAt!.getTime(), g.expiresAt),
      );
      const common = {
        clientId: client.id,
        grantId: g.id,
        scope: token.scope,
        resource,
      };
      await repo.put(
        "access",
        hash(token.accessToken),
        { ...common, expiresAt: accessTokenExpiresAt.getTime() },
        accessTokenExpiresAt.getTime(),
      );
      await repo.put(
        "refresh",
        hash(token.refreshToken!),
        { ...common, used: false, expiresAt: refreshTokenExpiresAt.getTime() },
        refreshTokenExpiresAt.getTime(),
      );
      return {
        ...token,
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        client,
        user,
      } as OAuth2Server.Token;
    },
    getAccessToken: async () => false as const,
    getRefreshToken: async (value: string) => {
      const t = await repo.get("refresh", hash(value), true);
      if (!t || t.clientId !== requestClient || t.resource !== resource)
        return false;
      const g = await getGrant(t.grantId);
      if (!g) return false;
      if (t.used) {
        await revokeGrant(repo, g);
        return false;
      }
      const client = await getClient(t.clientId);
      if (!client) return false;
      return {
        ...t,
        refreshToken: value,
        refreshTokenExpiresAt: new Date(t.expiresAt),
        client,
        user: { grantId: g.id },
      } as OAuth2Server.RefreshToken;
    },
    revokeToken: async (token: OAuth2Server.RefreshToken) => {
      const t = await repo.get("refresh", hash(token.refreshToken), true);
      if (!t || t.used) return false;
      await repo.put(
        "refresh",
        hash(token.refreshToken),
        { ...t, used: true },
        t.expiresAt,
      );
      return true;
    },
  };
}
export const oauthServer = (
  repo: Repository,
  resource: string,
  client?: string,
) =>
  new OAuth2Server({
    model: oauthModel(repo, resource, client),
    requirePKCE: true,
    accessTokenLifetime: ACCESS_MS / 1000,
    refreshTokenLifetime: GRANT_MS / 1000,
    authorizationCodeLifetime: 120,
    alwaysIssueNewRefreshToken: true,
    requireClientAuthentication: {
      authorization_code: false,
      refresh_token: false,
    },
  });
