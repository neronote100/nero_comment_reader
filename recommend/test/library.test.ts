import { test } from "node:test";
import assert from "node:assert/strict";
import { database, member, article, authenticatedEnv } from "./helpers";
import {
  DAY,
  score,
  validateAnalysis,
  plainText,
  noteUrl,
  type Analysis,
  type MembershipEvent,
} from "../src/domain";
import { Library } from "../src/application/library";
import {
  parseNotification,
  resolveProfileLink,
} from "../src/infrastructure/gmail";
import { NoteClient } from "../src/infrastructure/note";
import {
  encrypt,
  decrypt,
  randomToken,
  hash,
} from "../src/infrastructure/security";
import worker, { report } from "../src/worker";
const analysis: Analysis = {
  overview: "概要",
  summary: "要約",
  charms: ["読者との出会い"],
  goodPoints: ["具体的な体験"],
  recommendedPoints: ["実践"],
  audience: "交流したい人",
  aiRating: 4,
  reason: "具体例がある",
  introductionPoints: ["出会い"],
  quotes: ["読者との出会い", "存在しない引用"],
  introduction: "紹介文です🌙",
  comment: "出会いを大切にするところが好きでした🌙",
};
const event = (
  id: string,
  kind: MembershipEvent["kind"],
  stamp: string,
  username = "writer",
): MembershipEvent => ({
  id,
  member_id: null,
  kind,
  status: "ready",
  received_at: stamp,
  candidate_username: username,
  candidate_name: "作者",
  plan_name: null,
  subject: "王子の城下町 通知",
  reason: null,
});
const dummyNote = {
  list: async () => ({ rows: [], last: true }),
  detail: async () => article(),
};
const dummyMail = { page: async () => ({ events: [] }) };
test("スコア式とAI評価の範囲", () => {
  assert.equal(
    score({ likes: 10, comments: 5, participated: 1, favorite: 1 }, 4),
    235,
  );
  assert.equal(
    score({ likes: 0, comments: 0, participated: 0, favorite: 0 }, 99),
    100,
  );
});
test("原文にない引用を除外し、本文中のHTMLをテキスト化する", () => {
  assert.deepEqual(validateAnalysis(analysis, article().body).quotes, [
    "読者との出会い",
  ]);
  assert.equal(
    plainText("<p>こんにちは<br>世界 &amp; 月</p><script>alert(1)</script>"),
    "こんにちは\n世界 & 月",
  );
  assert.throws(() => validateAnalysis({ ...analysis, aiRating: 6 }, "x"));
  assert.throws(() => noteUrl("https://note.com.evil.test/writer"));
});
test("入退会通知は古い順・新しい順のどちらでも最新状態を保持する", async () => {
  for (const reverse of [false, true]) {
    const { repo } = database();
    const events = [
      event("join", "join", "2026-10-05T00:00:00.000Z"),
      event("withdraw", "withdraw", "2026-10-10T00:00:00.000Z"),
    ];
    for (const e of reverse ? events.reverse() : events)
      await repo.applyEvent(e);
    const m = await repo.member("note:writer");
    assert.equal(m?.status, "withdraw");
    assert.equal(m?.joined_at, "2026-10-05T00:00:00.000Z");
  }
});
test("同一メールの再処理は冪等", async () => {
  const { repo } = database();
  const e = event("id1", "join", "2026-10-05T00:00:00.000Z");
  await repo.applyEvent(e);
  await repo.applyEvent(e);
  assert.equal((await repo.members()).length, 1);
  assert.equal((await repo.rows("SELECT * FROM membership_events")).length, 1);
});
test("プラン通知が先に届いても後の同期で入会を認識する", async () => {
  const { repo } = database();
  await repo.applyEvent({
    ...event("plan", "plan", "2026-10-10T00:00:00.000Z"),
    plan_name: "新プラン",
  });
  assert.equal((await repo.member("note:writer"))?.status, "pending");
  await repo.applyEvent(event("join", "join", "2026-10-05T00:00:00.000Z"));
  const m = await repo.member("note:writer");
  assert.equal(m?.status, "active");
  assert.equal(m?.plan, "新プラン");
});
test("再入会はactiveになり、初回入会順を保持", async () => {
  const { repo } = database();
  await repo.applyEvent(event("j", "join", "2026-10-05T00:00:00.000Z"));
  await repo.applyEvent(event("w", "withdraw", "2026-10-10T00:00:00.000Z"));
  await repo.applyEvent(event("j2", "join", "2026-10-15T00:00:00.000Z"));
  assert.equal((await repo.member("note:writer"))?.status, "active");
  assert.equal(
    (await repo.member("note:writer"))?.joined_at,
    "2026-10-05T00:00:00.000Z",
  );
});
test("曖昧な通知は会員を勝手に作らない", async () => {
  const { repo } = database();
  await repo.applyEvent({
    ...event("unknown", "unknown", "2026-10-01T00:00:00.000Z"),
    candidate_username: null,
  });
  assert.equal((await repo.members()).length, 0);
  assert.equal((await repo.pendingEvents()).length, 1);
});
function mail(subject: string, body: string, from = "note <noreply@note.com>") {
  return {
    id: "mail1",
    internalDate: String(Date.now()),
    payload: {
      mimeType: "text/html",
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
      ],
      body: { data: Buffer.from(body).toString("base64url") },
    },
  };
}
test("Gmail通知から単一note IDと入会・退会を読む", () => {
  let parsed = parseNotification(
    mail(
      "王子の城下町に新しいメンバーが参加しました",
      '<p>作者さんが参加しました</p><a href="https://note.com/writer">作者</a>',
    ),
    "王子の城下町",
    "nero_notelover",
    "noreply@note.com",
  );
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.kind, "join");
  assert.equal(parsed.candidate_username, "writer");
  assert.equal(parsed.candidate_name, "作者");
  parsed = parseNotification(
    mail("王子の城下町：退会のお知らせ", "https://note.com/writer"),
    "王子の城下町",
    "nero_notelover",
    "noreply@note.com",
  );
  assert.equal(parsed.kind, "withdraw");
});
test("別コミュニティ・複数ID・偽送信元・不明プランは確認待ち", () => {
  for (const fixture of [
    mail("別の城に参加しました", "https://note.com/writer"),
    mail(
      "王子の城下町に参加しました",
      "https://note.com/writer https://note.com/another",
    ),
    mail(
      "王子の城下町に参加しました",
      "https://note.com/writer",
      "evil@example.test",
    ),
    mail("王子の城下町：プランを変更しました", "https://note.com/writer"),
  ])
    assert.equal(
      parseNotification(
        fixture,
        "王子の城下町",
        "nero_notelover",
        "noreply@note.com",
      ).status,
      "pending",
    );
  const p = parseNotification(
    mail(
      "王子の城下町：プランを変更しました",
      "プラン：プレミアム\nhttps://note.com/writer",
    ),
    "王子の城下町",
    "nero_notelover",
    "noreply@note.com",
  );
  assert.equal(p.plan_name, "プレミアム");
  assert.equal(p.status, "ready");
});
test("日次スナップショットは同日更新し、約7日前の実測と比較する", async () => {
  const { repo } = database();
  await repo.saveMember(member());
  const a = article();
  await repo.saveArticle({
    ...a,
    likes: 2,
    comments: 1,
    collected_at: new Date(Date.now() - 7 * DAY - 10000).toISOString(),
  });
  await repo.saveArticle(a);
  await repo.saveArticle({ ...a, likes: 12 });
  const [result] = await repo.candidates();
  assert.equal(result.growth?.likes, 10);
  assert.equal(result.growth?.comments, 1);
  assert.equal(result.growth?.likeRate, 5);
  assert.equal((await repo.rows("SELECT * FROM article_snapshots")).length, 2);
});
test("ゼロ基準と記録なしの増加率を捏造しない", async () => {
  const { repo } = database();
  await repo.saveMember(member());
  const a = article();
  await repo.saveArticle(a);
  assert.equal((await repo.candidates())[0].growth, null);
  await repo.saveArticle({
    ...a,
    likes: 0,
    comments: 0,
    collected_at: new Date(Date.now() - 7 * DAY - 10000).toISOString(),
  });
  const g = (await repo.candidates())[0].growth;
  assert.equal(g?.likeRate, null);
  assert.equal(g?.commentRate, null);
});
test("AI分析は本文ハッシュ変更で失効、収集で手動フラグを消さない", async () => {
  const { repo } = database();
  await repo.saveMember(member());
  const a = article("n123456789abc", { favorite: 1, participated: 1 });
  await repo.saveArticle(a);
  await repo.saveAnalysis(a, analysis, "test");
  assert.ok((await repo.candidates())[0].analysis);
  await repo.saveArticle({
    ...a,
    body: "別の本文",
    body_hash: "v2",
    favorite: 0,
    participated: 0,
  });
  const item = (await repo.candidates())[0];
  assert.equal(item.analysis, undefined);
  assert.equal(item.favorite, 1);
  assert.equal(item.participated, 1);
});
test("分析しても紹介済みにしない。掲載URL登録で初めて履歴と日付を更新", async () => {
  const { repo } = database();
  await repo.saveMember(member());
  const a = article();
  await repo.saveArticle(a);
  await repo.saveAnalysis(a, analysis, "test");
  assert.equal((await repo.member("note:writer"))?.last_introduced_at, null);
  await repo.introduce(a, "https://note.com/nero_notelover/n/nabcdef123456");
  assert.ok((await repo.member("note:writer"))?.last_introduced_at);
  assert.equal((await repo.candidates())[0].introduced, true);
});
test("候補は1人1記事・入会順、30日未紹介と退会者除外", async () => {
  const { repo } = database();
  await repo.saveMember(member());
  await repo.saveMember(
    member("early", {
      joined_at: "2025-01-01T00:00:00.000Z",
      last_introduced_at: new Date(Date.now() - 31 * DAY).toISOString(),
    }),
  );
  await repo.saveMember(
    member("recent", {
      last_introduced_at: new Date(Date.now() - 29 * DAY).toISOString(),
    }),
  );
  await repo.saveMember(member("gone", { status: "withdraw" }));
  for (const [i, m] of [
    "writer",
    "writer",
    "early",
    "recent",
    "gone",
  ].entries())
    await repo.saveArticle(
      article("n" + String(i).padStart(12, "0"), {
        member_id: "note:" + m,
        url: "https://note.com/" + m + "/n/n" + String(i).padStart(12, "0"),
      }),
    );
  const lib = new Library(repo, dummyNote, dummyMail);
  const d = await lib.dashboard();
  assert.equal(d.rotation.length, 3);
  assert.equal(new Set(d.rotation.map((a) => a.member_id)).size, 3);
  assert.ok(d.overdue.some((m) => m.id === "note:early"));
  assert.ok(!d.overdue.some((m) => m.id === "note:recent"));
  assert.ok(!d.articles.some((a) => a.member_id === "note:gone"));
  assert.ok(!("body" in d.articles[0]));
});
test("ジョブは一意に予約・原子的取得・3回失敗で停止", async () => {
  const { repo } = database();
  await repo.enqueue("a", "list", "{}");
  await repo.enqueue("a", "list", "{}");
  const first = await repo.claim();
  assert.ok(first);
  assert.equal(await repo.claim(), null);
  await repo.finish({ ...first, attempts: 3 }, "失敗");
  assert.equal(((await repo.jobs()) as { state: string }[])[0].state, "failed");
  assert.equal(await repo.claim(), null);
});
test("失効リースを回収し、最終試行で停止した処理をfailedにする", async () => {
  const { repo } = database();
  await repo.enqueue("a", "list", "{}");
  await repo.run("UPDATE jobs SET state='running',attempts=3,locked_until=0");
  assert.equal(await repo.claim(), null);
  assert.equal(((await repo.jobs()) as { state: string }[])[0].state, "failed");
});
test("定期処理の外部呼出しをジョブ数で制限、継続ページを保存", async () => {
  const { repo } = database();
  await repo.saveMember(member());
  let calls = 0;
  const note = {
    ...dummyNote,
    list: async () => {
      calls++;
      return { rows: [{ key: "n123456789abc" }], last: false };
    },
  };
  const lib = new Library(repo, note, dummyMail);
  await lib.scheduleCollection("batch");
  await lib.process(1);
  assert.equal(calls, 1);
  assert.equal(
    (await repo.rows("SELECT * FROM jobs WHERE state='queued'")).length,
    2,
  );
});
test("認証・Origin・型・不正URLの境界をAPIで検証", async () => {
  const { db } = database();
  const { env, request } = await authenticatedEnv(db);
  assert.equal(
    (
      await worker.fetch(
        request("/api/dashboard", undefined, { cookie: "" }),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await worker.fetch(
        request(
          "/api/members",
          { name: "作者", note_username: "writer" },
          { origin: "https://evil.test" },
        ),
        env,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await worker.fetch(
        request("/api/members", { name: "作者", note_username: "../bad" }),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request("/api/members", {
          name: "作者",
          note_username: "writer",
          joined_at: "2026-10-05T09:00",
        }),
        env,
      )
    ).status,
    201,
  );
  const m = await db
    .prepare("SELECT * FROM members")
    .first<{ joined_at: string }>();
  assert.equal(m?.joined_at, "2026-10-05T00:00:00.000Z");
  assert.equal(
    (
      await worker.fetch(
        request(
          "/api/members/note%3Awriter",
          { priority: "100" },
          { method: "PATCH" },
        ),
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        request(
          "/api/members/note%3Awriter",
          { profile_url: "https://evil.test" },
          { method: "PATCH" },
        ),
        env,
      )
    ).status,
    400,
  );
});
test("note ID変更で旧アカウント記事を候補から外す", async () => {
  const { db, repo } = database();
  await repo.saveMember(member());
  await repo.saveArticle(article());
  const { env, request } = await authenticatedEnv(db);
  const r = await worker.fetch(
    request(
      "/api/members/note%3Awriter",
      { note_username: "another" },
      { method: "PATCH" },
    ),
    env,
  );
  assert.equal(r.status, 200);
  assert.equal((await repo.candidates()).length, 0);
});
test("保存済みAI分析を再利用し、AI未設定は503", async () => {
  const { db, repo } = database();
  await repo.saveMember(member());
  await repo.saveArticle(article());
  const { env, request } = await authenticatedEnv(db);
  assert.equal(
    (await worker.fetch(request("/api/analyze", { id: article().id }), env))
      .status,
    503,
  );
  env.OPENAI_API_KEY = "test";
  await repo.saveAnalysis(article(), analysis, "test");
  const r = await worker.fetch(
    request("/api/analyze", { id: article().id }),
    env,
  );
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { cached: boolean }).cached, true);
  assert.equal((await repo.jobs()).length, 0);
});
test("OAuthのstate欠落・Cookie不一致はトークン交換前に拒否", async () => {
  const { db } = database();
  const { env, request } = await authenticatedEnv(db);
  assert.equal(
    (await worker.fetch(request("/auth/callback?state=wrong&code=code"), env))
      .status,
    400,
  );
  const login = await worker.fetch(request("/auth/login"), env);
  assert.equal(login.status, 302);
  const url = new URL(login.headers.get("Location")!);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("scope")?.includes("gmail.readonly"));
});
test("セッショントークンはハッシュ、Googleトークンは暗号化して復元できる", async () => {
  const key = randomToken(),
    encrypted = await encrypt("refresh-secret", key);
  assert.ok(!encrypted.includes("refresh-secret"));
  assert.equal(await decrypt(encrypted, key), "refresh-secret");
  await assert.rejects(() => decrypt(encrypted, randomToken()));
  assert.notEqual(await hash("session"), "session");
});
test("note記事は投稿者を確認し、有料記事を公開プレビュー扱いにする", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({
        data: {
          name: "限定記事",
          user: { urlname: "writer" },
          body: "<p>無料部分</p>",
          price: 500,
          publishAt: "2026-10-10T00:00:00Z",
          likeCount: 3,
          commentCount: 1,
        },
      });
    const a = await new NoteClient().detail(member(), { key: "n123456789abc" });
    assert.equal(a.body_status, "preview");
    assert.equal(a.body, "無料部分");
    await assert.rejects(() =>
      new NoteClient().detail(member("another"), { key: "n123456789abc" }),
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("Discord朝レポートは同日再送を避け、メンションを無効にする", async () => {
  const { db, repo } = database();
  await repo.saveMember(member());
  await repo.saveArticle(article());
  const { env } = await authenticatedEnv(db);
  env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/test/token";
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      calls++;
      const data = JSON.parse(String(init?.body));
      assert.deepEqual(data.allowed_mentions, { parse: [] });
      assert.ok(data.content.length <= 2000);
      return new Response(null, { status: 204 });
    };
    await report(env);
    await report(env);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

// Synthetic layout matching note notification markup; no real email data or tracking token.
test("転送URLのプロフィールだけを解決し、複数行の入会通知を解析する", async () => {
  const html = `<p>王子 さん<br>テスト作者 さんが「<br>王子の城下町<br>」スタンダード へ参加しました。</p><td class="card__body card__body--userProfile"><a href="https://link.note.com/ls/click?upn=fake"><img class="avatar"></a></td><a href="https://note.com/unsubscribe_mails?key=example">配信停止</a>`;
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).hostname, "link.note.com");
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://note.com/test_writer" },
      });
    };
    const profile = await resolveProfileLink(html);
    const e = parseNotification(
      mail("王子の城下町に参加者が増えました！", html),
      "王子の城下町",
      "nero_notelover",
      "noreply@note.com",
      profile,
    );
    assert.equal(e.status, "ready");
    assert.equal(e.kind, "join");
    assert.equal(e.candidate_username, "test_writer");
    assert.equal(e.candidate_name, "テスト作者");
    assert.equal(e.plan_name, "スタンダード");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("プロフィール転送は外部サイトを辿らず、配信停止リンクにアクセスしない", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1/private" },
      });
    };
    assert.equal(
      await resolveProfileLink(
        `<td class="card__body--userProfile"><a href="https://link.note.com/ls/click?upn=fake">profile</a></td>`,
      ),
      undefined,
    );
    assert.equal(calls, 1);
    assert.equal(
      await resolveProfileLink(
        `<a href="https://link.note.com/ls/click?upn=unsubscribe">配信停止</a>`,
      ),
      undefined,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
