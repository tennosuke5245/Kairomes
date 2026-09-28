import { randomBytes, timingSafeEqual } from "node:crypto";
import { KairomesError } from "@kairomes/protocol";

const secret = () => randomBytes(32).toString("hex");
const equal = (a: string, b: string) =>
  /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const PAIRING_LIFETIME_MS = 2 * 60_000;
const PAIRING_RENEWAL_WINDOW_MS = 30 * 60_000;
const PANEL_GRANT_LIFETIME_MS = 12 * 60 * 60_000;

type PairingCode = {
  expiresAt: number;
  renewableUntil: number;
};

/** A local-admin-issued code delegates approval only to the configured extension. */
export class PanelPairing {
  private codes = new Map<string, PairingCode>();
  private grants = new Map<string, number>();
  private attempts = 0;
  private attemptWindow = 0;
  constructor(
    readonly extensionId: string | undefined,
    private readonly now = Date.now,
  ) {}

  create(extensionId: string) {
    if (!this.extensionId || extensionId !== this.extensionId)
      throw new KairomesError(
        "EXTENSION_MISMATCH",
        "請先使用這個 Extension ID 重新啟動 app，再產生配對碼。",
      );
    this.prune();
    if (this.codes.size >= 8)
      throw new KairomesError("PAIRING_LIMIT", "配對碼尚未使用，請稍候兩分鐘再試。");
    const code = secret();
    const issuedAt = this.now();
    this.codes.set(code, {
      expiresAt: issuedAt + PAIRING_LIFETIME_MS,
      renewableUntil: issuedAt + PAIRING_RENEWAL_WINDOW_MS,
    });
    return code;
  }
  redeem(code: string) {
    this.prune();
    this.countAttempt();
    const match = this.findCode(code);
    if (!match)
      throw new KairomesError("PAIRING_INVALID", "配對碼無效或已使用，請確認貼上完整連結。");
    const record = this.codes.get(match);
    if (!record) throw new KairomesError("PAIRING_INVALID", "配對碼無效，請重新取得。");
    if (this.now() >= record.expiresAt)
      throw new KairomesError(
        "PAIRING_EXPIRED",
        "配對連結已過期；Kairomes Extension 可以安全換新一次。",
      );
    this.codes.delete(match);
    return this.createGrant();
  }
  renew(code: string) {
    this.prune();
    this.countAttempt();
    const match = this.findCode(code);
    if (!match)
      throw new KairomesError(
        "PAIRING_RENEWAL_UNAVAILABLE",
        "這個配對連結無法換新，請在本機重新產生。",
      );
    const record = this.codes.get(match);
    if (!record) throw new KairomesError("PAIRING_RENEWAL_UNAVAILABLE", "無法換新配對連結。");
    if (this.now() < record.expiresAt)
      throw new KairomesError("PAIRING_NOT_EXPIRED", "目前配對連結仍可直接使用。");
    if (this.now() >= record.renewableUntil) {
      this.codes.delete(match);
      throw new KairomesError(
        "PAIRING_RENEWAL_UNAVAILABLE",
        "配對連結已超過安全換新期限，請在本機重新產生。",
      );
    }
    this.codes.delete(match);
    if (!this.extensionId)
      throw new KairomesError("EXTENSION_MISMATCH", "工作台未綁定 Kairomes Extension。");
    return this.create(this.extensionId);
  }
  private countAttempt() {
    if (this.now() >= this.attemptWindow) {
      this.attemptWindow = this.now() + 60_000;
      this.attempts = 0;
    }
    if (++this.attempts > 30)
      throw new KairomesError("PAIRING_LIMIT", "配對嘗試過於頻繁，請一分鐘後再試。");
  }
  private findCode(code: string) {
    return [...this.codes.keys()].find((item) => equal(item, code));
  }
  private createGrant() {
    if (this.grants.size >= 8)
      throw new KairomesError(
        "PAIRING_LIMIT",
        "已達側欄配對數量上限，請解除舊配對或重新啟動 app。",
      );
    const token = secret();
    this.grants.set(token, this.now() + PANEL_GRANT_LIFETIME_MS);
    return token;
  }
  valid(token: string) {
    this.prune();
    return [...this.grants.keys()].some((item) => equal(item, token));
  }
  revoke(token: string) {
    this.grants.delete(token);
  }
  private prune() {
    for (const [key, record] of this.codes)
      if (this.now() >= record.renewableUntil) this.codes.delete(key);
    for (const [key, expires] of this.grants) if (this.now() >= expires) this.grants.delete(key);
  }
  close() {
    this.codes.clear();
    this.grants.clear();
  }
}
