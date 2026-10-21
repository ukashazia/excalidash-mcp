import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export const randomToken = (prefix = "") =>
  prefix + randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export class CredentialCipher {
  private key: Buffer;
  constructor(key: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(key))
      throw Error(
        "MCP_OAUTH_ENCRYPTION_KEY must be 32 random bytes encoded as 64 hex characters",
      );
    this.key = Buffer.from(key, "hex");
  }
  seal(value: string, grantId: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(grantId));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString("base64url"))
      .join(".");
  }
  open(value: string, grantId: string) {
    const [iv, tag, data] = value
      .split(".")
      .map((p) => Buffer.from(p, "base64url"));
    if (!iv || !tag || !data) throw Error("Invalid encrypted credential");
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(grantId));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString(
      "utf8",
    );
  }
  csrf(browser: string, context: string) {
    return createHmac("sha256", this.key)
      .update(browser + "\0" + context)
      .digest("base64url");
  }
}
