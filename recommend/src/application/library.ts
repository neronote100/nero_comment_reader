import { DAY, daysSince, type Candidate } from "../domain";
import type {
  AIProvider,
  MailProvider,
  NoteProvider,
  Repository,
} from "../ports";
export class Library {
  repo: Repository;
  note: NoteProvider;
  ai?: AIProvider;
  mail: MailProvider;
  model: string;
  constructor(
    repo: Repository,
    note: NoteProvider,
    mail: MailProvider,
    ai?: AIProvider,
    model = "",
  ) {
    this.repo = repo;
    this.note = note;
    this.mail = mail;
    this.ai = ai;
    this.model = model;
  }
  async dashboard() {
    const [members, articles, jobs, pendingEvents] = await Promise.all([
      this.repo.members(),
      this.repo.candidates(),
      this.repo.jobs(),
      this.repo.pendingEvents(),
    ]);
    const active = members.filter((m) => m.status === "active");
    const overdue = active
      .filter(
        (m) =>
          !m.last_introduced_at || (daysSince(m.last_introduced_at) ?? 0) >= 30,
      )
      .sort(
        (a, b) =>
          (a.last_introduced_at || "").localeCompare(
            b.last_introduced_at || "",
          ) || a.joined_at.localeCompare(b.joined_at),
      )
      .map((m) => ({ ...m, days: daysSince(m.last_introduced_at) }));
    const weekly = articles.filter(
      (a) => Date.parse(a.published_at) >= Date.now() - 7 * DAY,
    );
    const sort = (key: "likes" | "comments" | "score") =>
      [...weekly].sort((a, b) => b[key] - a[key]).slice(0, 20);
    const rising = articles
      .filter((a) => a.growth)
      .sort(
        (a, b) =>
          b.growth!.likes +
          3 * b.growth!.comments -
          (a.growth!.likes + 3 * a.growth!.comments),
      )
      .slice(0, 20);
    const eligible = articles.filter(
      (a) => !a.introduced && a.body_status !== "unavailable",
    );
    const ranked = [...eligible].sort(
      (a, b) => b.priority - a.priority || b.score - a.score,
    );
    // At most one article per creator so a prolific author cannot fill the whole report.
    const recommend = uniqueMembers(ranked).slice(0, 6);
    const rotation = uniqueMembers(
      [...eligible].sort(
        (a, b) =>
          (a.last_introduced_at || "").localeCompare(
            b.last_introduced_at || "",
          ) ||
          a.joined_at.localeCompare(b.joined_at) ||
          b.published_at.localeCompare(a.published_at),
      ),
    ).slice(0, 6);
    // Article bodies are only returned by the explicit detail endpoint.
    const compact = (a: Candidate) => {
      const { body, ...rest } = a;
      return rest;
    };
    return {
      members,
      overdue,
      pendingEvents,
      jobs,
      counts: {
        active: active.length,
        articles: articles.length,
        unintroduced: overdue.length,
      },
      recommendations: recommend.map(compact),
      rotation: rotation.map(compact),
      articles: articles.map(compact),
      weekly: {
        likes: sort("likes").map(compact),
        comments: sort("comments").map(compact),
        combined: sort("score").map(compact),
      },
      rising: rising.map(compact),
    };
  }
  async scheduleCollection(batch: string) {
    for (const m of await this.repo.members())
      if (m.status === "active" && m.note_username)
        await this.repo.enqueue(
          `${batch}:list:${m.id}:1`,
          "list",
          JSON.stringify({ memberId: m.id, page: 1, batch }),
        );
  }
  async scheduleAI(batch: string, limit: number) {
    if (!this.ai) return;
    const d = await this.dashboard();
    for (const a of d.rotation
      .filter((a) => !a.analysis)
      .slice(0, Math.max(0, Math.min(20, limit))))
      await this.repo.enqueue(`${batch}:ai:${a.id}`, "ai", a.id);
  }
  async process(limit = 6) {
    let count = 0;
    // Gmail page: 1 list + 2 messages + up to 4 trusted redirect hops.
    // Six jobs plus one cached token exchange use at most 43 external calls.
    for (; count < limit; count++) {
      const job = await this.repo.claim();
      if (!job) break;
      try {
        if (job.kind === "gmail") {
          const { pageToken, batch } = JSON.parse(job.target || "{}") as {
            pageToken?: string;
            batch: string;
          };
          const result = await this.mail.page(pageToken);
          // Older notifications must be reconciled by timestamp, not fetch order.
          for (const e of result.events)
            if (e.status === "ready") await this.repo.applyEvent(e);
            else await this.repo.event(e);
          if (result.next)
            await this.repo.enqueue(
              `${batch}:gmail:${result.next}`,
              "gmail",
              JSON.stringify({ pageToken: result.next, batch }),
            );
          else {
            await this.repo.setSetting(
              "gmailSyncedAt",
              new Date().toISOString(),
            );
            await this.scheduleCollection(batch);
          }
        } else if (job.kind === "list") {
          const { memberId, page, batch } = JSON.parse(job.target) as {
            memberId: string;
            page: number;
            batch: string;
          };
          const m = await this.repo.member(memberId);
          if (m?.status === "active" && m.note_username) {
            const result = await this.note.list(m.note_username, page);
            for (const row of result.rows) {
              const key = String(row.key || row.noteKey || row.note_key || "");
              await this.repo.enqueue(
                `${batch}:article:${m.id}:${key}`,
                "article",
                JSON.stringify({ memberId, row }),
              );
            }
            if (!result.last) {
              if (page >= 200)
                throw new Error(
                  "記事一覧が200ページを超えました。上限の見直しが必要です",
                );
              await this.repo.enqueue(
                `${batch}:list:${m.id}:${page + 1}`,
                "list",
                JSON.stringify({ memberId, page: page + 1, batch }),
              );
            } else
              await this.repo.saveMember({
                ...m,
                synced_at: new Date().toISOString(),
                sync_error: null,
              });
          }
        } else if (job.kind === "article") {
          const { memberId, row } = JSON.parse(job.target) as {
            memberId: string;
            row: Record<string, unknown>;
          };
          const m = await this.repo.member(memberId);
          if (m?.status === "active" && m.note_username)
            await this.repo.saveArticle(await this.note.detail(m, row));
        } else if (job.kind === "ai") {
          const a = await this.repo.article(job.target);
          const m = a ? await this.repo.member(a.member_id) : null;
          if (a && m?.status === "active") {
            if (!this.ai) throw new Error("OPENAI_API_KEYを設定してください");
            await this.repo.saveAnalysis(
              a,
              await this.ai.analyze(a),
              this.model,
            );
          }
        } else throw new Error("不明なジョブ種別です");
        await this.repo.finish(job);
      } catch (e) {
        await this.repo.finish(
          job,
          e instanceof Error ? e.message : "処理に失敗しました",
        );
      }
    }
    return { processed: count };
  }
}
function uniqueMembers(articles: Candidate[]) {
  const seen = new Set<string>();
  return articles.filter((a) => {
    if (seen.has(a.member_id)) return false;
    seen.add(a.member_id);
    return true;
  });
}
