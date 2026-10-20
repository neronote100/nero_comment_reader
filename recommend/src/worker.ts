import { DAY, noteUrl, usernameValid, type Member } from "./domain";
import type { Env } from "./env";
import { Library } from "./application/library";
import { D1Repository } from "./infrastructure/repository";
import { NoteClient } from "./infrastructure/note";
import { GmailClient } from "./infrastructure/gmail";
import { OpenAIClient } from "./infrastructure/ai";
import { authenticated, callback, login, logout } from "./infrastructure/auth";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
export function services(env: Env) {
  const repo = new D1Repository(env.DB);
  return {
    repo,
    library: new Library(
      repo,
      new NoteClient(),
      new GmailClient(env),
      env.OPENAI_API_KEY
        ? new OpenAIClient(env.OPENAI_API_KEY, env.OPENAI_MODEL)
        : undefined,
      env.OPENAI_MODEL,
    ),
  };
}
class Invalid extends Error {}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Invalid("JSON形式で送信してください");
  const reader = request.body?.getReader();
  let text = "",
    size = 0;
  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32000) {
        await reader.cancel();
        throw new Invalid("入力が大きすぎます");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    const data = JSON.parse(text);
    if (!data || Array.isArray(data) || typeof data !== "object")
      throw new Error();
    return data;
  } catch {
    throw new Invalid("JSONが不正です");
  }
}
const string = (v: unknown, max = 500) => {
  if (typeof v !== "string" || v.length > max)
    throw new Invalid("入力項目を確認してください");
  return v.trim();
};
function inputDate(value: unknown) {
  const raw = string(value);
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)
    ? raw + ":00+09:00"
    : raw;
  const stamp = Date.parse(zoned);
  if (!Number.isFinite(stamp)) throw new Invalid("日時を確認してください");
  return new Date(stamp).toISOString();
}
function checkedNoteUrl(value: unknown) {
  try {
    return noteUrl(string(value, 300));
  } catch {
    throw new Invalid("note.com のHTTPS URLを入力してください");
  }
}
export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    p = url.pathname,
    method = request.method;
  if (p.startsWith("/auth/") || p.startsWith("/api/")) {
    if (url.origin !== env.APP_ORIGIN)
      return json({ error: "設定された管理画面からアクセスしてください" }, 403);
  }
  if (method === "GET" && p === "/auth/login") return login(env);
  if (method === "GET" && p === "/auth/callback") return callback(request, env);
  if (!p.startsWith("/api/"))
    return env.ASSETS
      ? env.ASSETS.fetch(request)
      : new Response("Not found", { status: 404 });
  if (!(await authenticated(request, env)))
    return json({ error: "Googleで管理者ログインしてください" }, 401);
  if (method !== "GET" && request.headers.get("origin") !== env.APP_ORIGIN)
    return json({ error: "Originが一致しません" }, 403);
  if (method === "POST" && p === "/api/logout") return logout(request, env);
  const { repo, library } = services(env);
  if (method === "GET" && p === "/api/dashboard")
    return json(await library.dashboard());
  if (method === "GET" && p === "/api/setup")
    return json({
      googleConnected: Boolean(
        await env.DB.prepare(
          "SELECT id FROM credentials WHERE id='google'",
        ).first(),
      ),
      aiConfigured: Boolean(env.OPENAI_API_KEY),
      discordConfigured: Boolean(env.DISCORD_WEBHOOK_URL),
      gmailSyncedAt: await repo.setting("gmailSyncedAt"),
      reportAt: await repo.setting("reportAt"),
      reportError: await repo.setting("reportError"),
    });
  if (method === "GET" && p === "/api/introductions")
    return json(
      await repo.rows(
        "SELECT i.*,m.name member_name,a.title article_title FROM introductions i JOIN members m ON m.id=i.member_id JOIN articles a ON a.id=i.article_id ORDER BY i.introduced_at DESC LIMIT 200",
      ),
    );
  if (method === "GET" && p.startsWith("/api/articles/")) {
    const a = await repo.article(
      decodeURIComponent(p.slice("/api/articles/".length)),
    );
    if (!a) return json({ error: "記事がありません" }, 404);
    return json(a);
  }
  if (method === "POST" && p === "/api/members") {
    const data = await body(request),
      now = new Date().toISOString();
    const name = string(data.name, 100),
      username = string(data.note_username || "", 80).toLowerCase();
    if (!name || (username && !usernameValid(username)))
      throw new Invalid("名前とnote IDを確認してください");
    const id = username ? "note:" + username : crypto.randomUUID();
    if (await repo.member(id))
      return json({ error: "登録済みのメンバーです" }, 409);
    const joined = data.joined_at ? inputDate(data.joined_at) : now;
    await repo.saveMember({
      id,
      name,
      note_username: username || null,
      profile_url: username ? "https://note.com/" + username : "",
      account_url: username ? "https://note.com/" + username : "",
      discord_name: "",
      tags: "[]",
      priority: 0,
      status: username ? "active" : "pending",
      received_at: now,
      joined_at: joined,
      last_event_at: now,
      last_status_at: now,
      last_introduced_at: null,
      plan: "",
      synced_at: null,
      sync_error: null,
      created_at: now,
    });
    return json({ ok: true, id }, 201);
  }
  if (method === "PATCH" && p.startsWith("/api/members/")) {
    const id = decodeURIComponent(p.slice("/api/members/".length)),
      m = await repo.member(id);
    if (!m) return json({ error: "メンバーがありません" }, 404);
    const data = await body(request),
      updated: Member = { ...m };
    for (const key of ["name", "discord_name", "plan"] as const)
      if (data[key] !== undefined) updated[key] = string(data[key], 150);
    if (!updated.name) throw new Invalid("名前を入力してください");
    if (data.note_username !== undefined) {
      const user = string(data.note_username, 80).toLowerCase();
      if (user && !usernameValid(user))
        throw new Invalid("note IDを確認してください");
      updated.note_username = user || null;
      updated.profile_url = updated.account_url = user
        ? "https://note.com/" + user
        : "";
      if (user !== m.note_username) {
        updated.synced_at = null;
        updated.sync_error = null;
      }
    }
    for (const key of ["profile_url", "account_url"] as const)
      if (data[key] !== undefined)
        updated[key] = data[key] ? checkedNoteUrl(data[key]) : "";
    if (data.tags !== undefined) {
      if (
        !Array.isArray(data.tags) ||
        data.tags.length > 20 ||
        data.tags.some((v) => typeof v !== "string" || v.length > 50)
      )
        throw new Invalid("タグは20個までです");
      updated.tags = JSON.stringify(data.tags);
    }
    if (data.priority !== undefined) {
      if (
        !Number.isInteger(data.priority) ||
        Number(data.priority) < 0 ||
        Number(data.priority) > 100
      )
        throw new Invalid("優先度は0〜100です");
      updated.priority = Number(data.priority);
    }
    if (data.status !== undefined) {
      if (!["active", "withdraw", "pending"].includes(String(data.status)))
        throw new Invalid("ステータスを確認してください");
      updated.status = data.status as Member["status"];
      if (updated.status !== m.status)
        updated.last_status_at = new Date().toISOString();
    }
    if (data.joined_at !== undefined)
      updated.joined_at = inputDate(data.joined_at);
    if (updated.status === "active" && !updated.note_username)
      throw new Invalid("activeにはnote IDが必要です");
    await repo.saveMember(updated);
    if (updated.note_username !== m.note_username)
      await repo.run("UPDATE articles SET available=0 WHERE member_id=?", m.id);
    return json({ ok: true });
  }
  if (method === "POST" && p === "/api/events/resolve") {
    const data = await body(request),
      eventId = string(data.event_id),
      memberId = string(data.member_id);
    const e = (await repo.pendingEvents()).find((x) => x.id === eventId),
      m = await repo.member(memberId);
    if (!e || !m?.note_username)
      throw new Invalid("確認待ち通知とメンバーを選択してください");
    const kind = string(data.kind);
    if (!["join", "withdraw", "plan"].includes(kind))
      throw new Invalid("通知の種別を選択してください");
    const plan = data.plan_name ? string(data.plan_name, 100) : e.plan_name;
    if (kind === "plan" && !plan)
      throw new Invalid("変更後のプラン名を入力してください");
    await repo.applyEvent({
      ...e,
      candidate_username: m.note_username,
      candidate_name: m.name,
      plan_name: plan,
      kind: kind as "join" | "withdraw" | "plan",
      status: "ready",
    });
    return json({ ok: true });
  }
  if (method === "POST" && p === "/api/sync") {
    const data = await body(request),
      batch = "manual:" + crypto.randomUUID();
    if (data.kind === "gmail")
      await repo.enqueue(batch + ":gmail", "gmail", JSON.stringify({ batch }));
    else if (data.kind === "articles") await library.scheduleCollection(batch);
    else throw new Invalid("同期種別を確認してください");
    return json({ ok: true, batch }, 202);
  }
  if (method === "POST" && p === "/api/jobs/run")
    return json(await library.process(1));
  if (method === "POST" && p === "/api/jobs/retry") {
    const data = await body(request),
      id = string(data.id);
    await repo.run(
      "UPDATE jobs SET state='queued',attempts=0,run_after=0,error=NULL WHERE id=? AND state='failed'",
      id,
    );
    return json({ ok: true });
  }
  if (method === "POST" && p === "/api/articles/flags") {
    const data = await body(request),
      id = string(data.id),
      a = await repo.article(id);
    if (!a) return json({ error: "記事がありません" }, 404);
    if (
      typeof data.favorite !== "boolean" ||
      typeof data.participated !== "boolean"
    )
      throw new Invalid("フラグを確認してください");
    await repo.run(
      "UPDATE articles SET favorite=?,participated=? WHERE id=?",
      Number(data.favorite),
      Number(data.participated),
      id,
    );
    return json({ ok: true });
  }
  if (method === "POST" && p === "/api/analyze") {
    const data = await body(request),
      a = await repo.article(string(data.id));
    if (!a?.body) throw new Invalid("公開本文を取得できていません");
    if (!env.OPENAI_API_KEY)
      return json({ error: "OPENAI_API_KEYを設定してください" }, 503);
    const m = await repo.member(a.member_id);
    if (m?.status !== "active")
      throw new Invalid("有効なメンバーの記事を選択してください");
    const existing = await env.DB.prepare(
      "SELECT data FROM analyses WHERE article_id=? AND body_hash=?",
    )
      .bind(a.id, a.body_hash)
      .first<{ data: string }>();
    if (existing)
      return json({
        ok: true,
        analysis: JSON.parse(existing.data),
        cached: true,
      });
    await repo.enqueue("ai:" + a.id + ":" + a.body_hash, "ai", a.id);
    return json({ ok: true, queued: true }, 202);
  }
  if (method === "POST" && p === "/api/introductions") {
    const data = await body(request),
      a = await repo.article(string(data.article_id));
    if (!a) throw new Invalid("記事を選択してください");
    const published = checkedNoteUrl(data.published_url);
    if (
      !/^https:\/\/note\.com\/[a-zA-Z0-9_-]+\/n\/n[a-f0-9]{12}$/i.test(
        published,
      )
    )
      throw new Invalid("掲載した紹介記事のURLを入力してください");
    await repo.introduce(a, published);
    return json({ ok: true }, 201);
  }
  return json({ error: "Not found" }, 404);
}
export async function report(env: Env) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const { repo, library } = services(env),
    day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  if ((await repo.setting("reportDay")) === day) return;
  const dashboard = await library.dashboard();
  const safe = (s: string) =>
    s
      .replace(/[@`*_~|<>\[\]\\]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 90);
  const lines = [
    "🏰 ネロ王立図書館｜朝の紹介候補",
    ...dashboard.recommendations.map(
      (a) =>
        `${safe(a.member_name)}｜${safe(a.title)}\n${a.url}\n${safe(a.analysis?.reason || "AI未分析：本文を確認してください")}`,
    ),
    "🌙 入会順・未紹介の候補",
    ...dashboard.rotation.map((a) => safe(a.member_name) + "｜" + a.url),
    "最近紹介していないメンバー：" +
      dashboard.overdue
        .map(
          (m) =>
            safe(m.name) +
            "（" +
            (m.days === null ? "未紹介" : m.days + "日") +
            "）",
        )
        .join("、"),
    env.APP_ORIGIN,
  ];
  const webhook = new URL(env.DISCORD_WEBHOOK_URL);
  if (
    webhook.protocol !== "https:" ||
    webhook.hostname !== "discord.com" ||
    !webhook.pathname.startsWith("/api/webhooks/")
  )
    throw new Error("Discord Webhook URLを確認してください");
  const result = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: lines.join("\n\n").slice(0, 1900),
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!result.ok) throw new Error("Discord HTTP " + result.status);
  await repo.setSetting("reportDay", day);
  await repo.setSetting("reportAt", new Date().toISOString());
  await repo.setSetting("reportError", "");
}
export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handle(request, env);
    } catch (e) {
      if (e instanceof Invalid || e instanceof RangeError)
        return json({ error: e.message }, 400);
      if (e instanceof Error && /UNIQUE constraint/.test(e.message))
        return json({ error: "同じnote IDは登録済みです" }, 409);
      // Never return upstream bodies, tokens, email contents, or D1 errors.
      console.error(
        "library request failed",
        e instanceof Error ? e.name : "Error",
      );
      return json(
        { error: "処理に失敗しました。設定とジョブ履歴を確認してください" },
        502,
      );
    }
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const { repo, library } = services(env),
      date = new Date(controller.scheduledTime + 9 * 3600000),
      hm = date.toISOString().slice(11, 16),
      batch = date.toISOString().slice(0, 16);
    ctx.waitUntil(
      (async () => {
        if (hm === "06:00" || hm === "18:00") {
          await library.scheduleCollection(batch);
          if (
            await env.DB.prepare(
              "SELECT id FROM credentials WHERE id='google'",
            ).first()
          )
            await repo.enqueue(
              batch + ":gmail",
              "gmail",
              JSON.stringify({ batch }),
            );
        }
        if (hm === "06:50" || hm === "18:50")
          await library.scheduleAI(batch, Number(env.AUTO_AI_LIMIT) || 0);
        // At most 6 network-heavy jobs per minute; each lease is claimed atomically.
        await library.process(6);
        if (hm === "07:00")
          try {
            await report(env);
          } catch (e) {
            await repo.setSetting(
              "reportError",
              e instanceof Error ? e.message : "通知失敗",
            );
          }
        // Remove expired auth data, old metrics and completed queue data once per day.
        if (hm === "03:00")
          await env.DB.batch([
            env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(
              Date.now(),
            ),
            env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(
              Date.now(),
            ),
            env.DB.prepare(
              "DELETE FROM article_snapshots WHERE sampled_at<?",
            ).bind(new Date(Date.now() - 90 * DAY).toISOString()),
            env.DB.prepare(
              "DELETE FROM jobs WHERE state='done' AND updated_at<?",
            ).bind(new Date(Date.now() - 30 * DAY).toISOString()),
          ]);
      })(),
    );
  },
};
