import { plainText, usernameValid, type MembershipEvent } from "../domain";
import type { MailProvider } from "../ports";
import type { Env } from "../env";
import { decrypt, jsonFetch } from "./security";
interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: Array<{ name: string; value: string }>;
}
interface Mail {
  id: string;
  internalDate: string;
  payload: Part;
}
function decode(data: string) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(data.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ),
  );
}
function parts(p: Part): string[] {
  return [
    ...(p.body?.data && ["text/plain", "text/html"].includes(p.mimeType || "")
      ? [decode(p.body.data)]
      : []),
    ...(p.parts || []).flatMap(parts),
  ];
}
export function parseNotification(
  mail: Mail,
  membership: string,
  owner: string,
  from: string,
  resolvedProfile?: string,
): MembershipEvent {
  const headers = mail.payload.headers || [];
  const get = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name)?.value || "";
  const subject = get("subject");
  const raw = parts(mail.payload).join("\n");
  const body = plainText(raw);
  const sender = get("from")
    .match(/<?([^<>\s]+@[^<>\s]+)>?$/)?.[1]
    ?.toLowerCase();
  const event: MembershipEvent = {
    id: mail.id,
    member_id: null,
    received_at: new Date(Number(mail.internalDate)).toISOString(),
    kind: "unknown",
    status: "pending",
    subject: subject.slice(0, 500),
    candidate_username: null,
    candidate_name: null,
    plan_name: null,
    reason: null,
  };
  const links = [
    ...(resolvedProfile || raw).matchAll(
      /https:\/\/note\.com\/([a-zA-Z0-9_-]{2,80})(?=[/?#\s"'<>]|$)/g,
    ),
  ]
    .map((m) => m[1].toLowerCase())
    .filter(
      (s) =>
        usernameValid(s) &&
        ![
          owner.toLowerCase(),
          "info",
          "settings",
          "notifications",
          "membership",
          "login",
          "signup",
          "terms",
          "privacy",
          "help",
          "api",
          "unsubscribe_mails",
        ].includes(s),
    );
  const candidates = [...new Set(links)];
  if (candidates.length === 1) event.candidate_username = candidates[0];
  const name = body.match(/(?:^|\n)[ \t]*([^\n]{1,100}?)\s*さんが/)?.[1];
  if (name) event.candidate_name = name.trim();
  event.plan_name =
    body.match(/(?:変更後の)?プラン[：:]\s*([^\n]{1,100})/)?.[1]?.trim() ||
    body.match(/」\s*([^\n]{1,100}?)\s*へ(?:参加|入会)/)?.[1]?.trim() ||
    null;
  if (
    /退会(?:しました|されました|通知)|退会のお知らせ/.test(
      subject + "\n" + body,
    )
  )
    event.kind = "withdraw";
  else if (/プラン.{0,30}変更/.test(subject + "\n" + body)) event.kind = "plan";
  else if (
    /(?:参加|入会)(?:しました|されました)|新しいメンバーが/.test(
      subject + "\n" + body,
    )
  )
    event.kind = "join";
  if (sender !== from.toLowerCase()) event.reason = "送信元が一致しません";
  else if (!membership || !(subject + "\n" + body).includes(membership))
    event.reason = "対象メンバーシップを確認できません";
  else if (candidates.length !== 1)
    event.reason = "noteアカウントを一意に特定できません";
  else if (event.kind === "unknown")
    event.reason = "入会・退会・プラン変更を判定できません";
  else if (event.kind === "plan" && !event.plan_name)
    event.reason = "変更後のプラン名を確認してください";
  else event.status = "ready";
  return event;
}
export async function resolveProfileLink(
  html: string,
): Promise<string | undefined> {
  // Only the profile-card's first link, never footer/unsubscribe or tracking pixels.
  const card = html.match(
    /<td\b[^>]*class=["'][^"']*\bcard__body--userProfile\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
  )?.[1];
  const href = card
    ?.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1]
    ?.replace(/&amp;/g, "&");
  if (!href) return undefined;
  let target = new URL(href);
  for (let i = 0; i < 3; i++) {
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port
    )
      return undefined;
    if (
      target.hostname === "note.com" &&
      /^\/[a-zA-Z0-9_-]{2,80}\/?$/.test(target.pathname)
    )
      return target.origin + target.pathname;
    if (
      i === 2 ||
      target.hostname !== "link.note.com" ||
      target.pathname !== "/ls/click"
    )
      return undefined;
    const r = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const location = r.headers.get("Location");
    await r.body?.cancel();
    if (r.status < 300 || r.status >= 400 || !location) return undefined;
    target = new URL(location, target);
  }
  return undefined;
}
export class GmailClient implements MailProvider {
  env: Env;
  token?: string;
  constructor(env: Env) {
    this.env = env;
  }
  async accessToken() {
    if (this.token) return this.token;
    const credential = await this.env.DB.prepare(
      "SELECT encrypted_token FROM credentials WHERE id='google'",
    ).first<{ encrypted_token: string }>();
    if (!credential)
      throw new Error("管理画面でGoogle・Gmailを接続してください");
    const refresh = await decrypt(
      credential.encrypted_token,
      this.env.TOKEN_ENCRYPTION_KEY,
    );
    const t = await jsonFetch<{ access_token: string }>(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.env.GOOGLE_CLIENT_ID,
          client_secret: this.env.GOOGLE_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refresh,
        }),
      },
    );
    this.token = t.access_token;
    return this.token;
  }
  async page(pageToken?: string) {
    const token = await this.accessToken();
    if (!this.env.MEMBERSHIP_NAME.trim())
      throw new Error("MEMBERSHIP_NAMEを設定してください");
    const q = `from:(${this.env.GMAIL_FROM}) "${this.env.MEMBERSHIP_NAME.replace(/["\\]/g, "")}"`;
    const params = new URLSearchParams({ q, maxResults: "2" });
    if (pageToken) params.set("pageToken", pageToken);
    const headers = { Authorization: "Bearer " + token };
    const list = await jsonFetch<{
      messages?: { id: string }[];
      nextPageToken?: string;
    }>("https://gmail.googleapis.com/gmail/v1/users/me/messages?" + params, {
      headers,
    });
    const events: MembershipEvent[] = [];
    for (const item of list.messages || []) {
      // Notification IDs are stable; scan all matching mail to reconcile old notifications safely.
      const old = await this.env.DB.prepare(
        "SELECT id FROM membership_events WHERE id=?",
      )
        .bind(item.id)
        .first();
      if (old) continue;
      const mail = await jsonFetch<Mail>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`,
        { headers },
      );
      let event = parseNotification(
        mail,
        this.env.MEMBERSHIP_NAME,
        this.env.NOTE_OWNER,
        this.env.GMAIL_FROM,
      );
      if (event.reason === "noteアカウントを一意に特定できません") {
        // Authenticated Gmail + expected sender/community checked before resolving any link.
        try {
          const profile = await resolveProfileLink(
            parts(mail.payload).join("\n"),
          );
          if (profile)
            event = parseNotification(
              mail,
              this.env.MEMBERSHIP_NAME,
              this.env.NOTE_OWNER,
              this.env.GMAIL_FROM,
              profile,
            );
        } catch {
          event.reason =
            "プロフィール転送先を取得できません。note IDを手動確認してください";
        }
      }
      events.push(event);
    }
    return { events, next: list.nextPageToken };
  }
}
