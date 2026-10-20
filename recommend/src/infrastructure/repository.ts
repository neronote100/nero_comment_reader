import {
  DAY,
  score,
  type Analysis,
  type Article,
  type Candidate,
  type Job,
  type Member,
  type MembershipEvent,
} from "../domain";
import type { Repository } from "../ports";
export class D1Repository implements Repository {
  db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }
  async rows<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    return (
      await this.db
        .prepare(sql)
        .bind(...args)
        .all<T>()
    ).results;
  }
  async run(sql: string, ...args: unknown[]) {
    return this.db
      .prepare(sql)
      .bind(...args)
      .run();
  }
  async members() {
    return this.rows<Member>("SELECT * FROM members ORDER BY joined_at,id");
  }
  async member(id: string) {
    return this.db
      .prepare("SELECT * FROM members WHERE id=?")
      .bind(id)
      .first<Member>();
  }
  async saveMember(m: Member) {
    const keys = Object.keys(m) as (keyof Member)[];
    await this.run(
      `INSERT INTO members (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${keys
        .filter((k) => k !== "id")
        .map((k) => `${k}=excluded.${k}`)
        .join(",")}`,
      ...keys.map((k) => m[k]),
    );
  }
  async event(e: MembershipEvent) {
    await this.run(
      "INSERT OR IGNORE INTO membership_events (id,member_id,received_at,kind,status,subject,candidate_username,candidate_name,plan_name,reason) VALUES (?,?,?,?,?,?,?,?,?,?)",
      e.id,
      e.member_id,
      e.received_at,
      e.kind,
      e.status,
      e.subject,
      e.candidate_username,
      e.candidate_name,
      e.plan_name,
      e.reason,
    );
  }
  async pendingEvents() {
    return this.rows<MembershipEvent>(
      "SELECT * FROM membership_events WHERE status='pending' ORDER BY received_at,id",
    );
  }
  async resolveEvent(id: string, memberId: string) {
    await this.run(
      "UPDATE membership_events SET member_id=?,status='applied',resolved_at=? WHERE id=? AND status='pending'",
      memberId,
      new Date().toISOString(),
      id,
    );
  }
  async applyEvent(e: MembershipEvent) {
    // D1 batch is transactional: notification replay cannot partially update membership state.
    const existing = await this.db
      .prepare("SELECT status FROM membership_events WHERE id=?")
      .bind(e.id)
      .first<{ status: string }>();
    if (existing?.status === "applied") return;
    if (!e.candidate_username || e.kind === "unknown") {
      await this.event({ ...e, status: "pending" });
      return;
    }
    const id = "note:" + e.candidate_username;
    const status =
      e.kind === "join"
        ? "active"
        : e.kind === "withdraw"
          ? "withdraw"
          : "pending";
    const now = new Date().toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO members (id,name,note_username,profile_url,account_url,status,received_at,joined_at,last_event_at,last_status_at,created_at,plan)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(note_username) DO UPDATE SET
        status=CASE WHEN excluded.last_status_at>=members.last_status_at AND ?!='plan' THEN excluded.status ELSE members.status END,
        last_status_at=MAX(members.last_status_at,excluded.last_status_at),
        received_at=CASE WHEN excluded.last_event_at>=members.last_event_at THEN excluded.received_at ELSE members.received_at END,
        joined_at=CASE WHEN ?='join' THEN MIN(members.joined_at,excluded.joined_at) ELSE members.joined_at END,
        plan=CASE WHEN excluded.last_event_at>=members.last_event_at AND excluded.plan!='' THEN excluded.plan ELSE members.plan END,
        last_event_at=MAX(members.last_event_at,excluded.last_event_at)`,
        )
        .bind(
          id,
          e.candidate_name || e.candidate_username,
          e.candidate_username,
          "https://note.com/" + e.candidate_username,
          "https://note.com/" + e.candidate_username,
          status,
          e.received_at,
          e.received_at,
          e.received_at,
          e.kind === "plan" ? "" : e.received_at,
          now,
          e.plan_name || "",
          e.kind,
          e.kind,
        ),
      this.db
        .prepare(
          `INSERT INTO membership_events (id,member_id,received_at,kind,status,subject,candidate_username,candidate_name,plan_name,reason,resolved_at)
        VALUES (?,(SELECT id FROM members WHERE note_username=?),?,?,'applied',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='applied',member_id=excluded.member_id,plan_name=excluded.plan_name,resolved_at=excluded.resolved_at`,
        )
        .bind(
          e.id,
          e.candidate_username,
          e.received_at,
          e.kind,
          e.subject,
          e.candidate_username,
          e.candidate_name,
          e.plan_name,
          e.reason,
          now,
        ),
    ]);
  }
  async candidates(): Promise<Candidate[]> {
    const baseline = new Date(Date.now() - 7 * DAY).toISOString();
    const earliest = new Date(Date.now() - 9 * DAY).toISOString();
    const rows = await this.rows<
      Article & {
        member_name: string;
        joined_at: string;
        priority: number;
        last_introduced_at: string | null;
        analysis_json: string | null;
        introduced: number;
        old_likes: number | null;
        old_comments: number | null;
        baseline_at: string | null;
      }
    >(
      `
      SELECT a.*,m.name member_name,m.joined_at,m.priority,m.last_introduced_at,
      CASE WHEN x.body_hash=a.body_hash THEN x.data ELSE NULL END analysis_json,
      EXISTS(SELECT 1 FROM introductions i WHERE i.article_id=a.id) introduced,
      s.likes old_likes,s.comments old_comments,s.sampled_at baseline_at
      FROM articles a JOIN members m ON m.id=a.member_id LEFT JOIN analyses x ON x.article_id=a.id
      LEFT JOIN article_snapshots s ON s.article_id=a.id AND s.day=(SELECT s2.day FROM article_snapshots s2 WHERE s2.article_id=a.id AND s2.sampled_at<=? AND s2.sampled_at>=? ORDER BY s2.sampled_at DESC LIMIT 1)
      WHERE m.status='active' AND a.available=1 ORDER BY a.published_at DESC LIMIT 2000`,
      baseline,
      earliest,
    );
    return rows.map(
      ({ analysis_json, old_likes, old_comments, baseline_at, ...a }) => {
        const analysis = analysis_json
          ? (JSON.parse(analysis_json) as Analysis)
          : undefined;
        return {
          ...a,
          introduced: Boolean(a.introduced),
          analysis,
          score: score(a, analysis?.aiRating),
          growth:
            old_likes === null || old_comments === null || !baseline_at
              ? null
              : {
                  likes: a.likes - old_likes,
                  comments: a.comments - old_comments,
                  likeRate:
                    old_likes > 0 ? (a.likes - old_likes) / old_likes : null,
                  commentRate:
                    old_comments > 0
                      ? (a.comments - old_comments) / old_comments
                      : null,
                  baselineAt: baseline_at,
                },
        };
      },
    );
  }
  async article(id: string) {
    return this.db
      .prepare("SELECT * FROM articles WHERE id=?")
      .bind(id)
      .first<Article>();
  }
  async saveArticle(a: Article) {
    const keys = Object.keys(a) as (keyof Article)[];
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO articles (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${keys
            .filter((k) => !["id", "participated", "favorite"].includes(k))
            .map((k) => `${k}=excluded.${k}`)
            .join(",")}`,
        )
        .bind(...keys.map((k) => a[k])),
      this.db
        .prepare(
          `INSERT INTO article_snapshots (article_id,day,likes,comments,sampled_at) VALUES (?,?,?,?,?) ON CONFLICT(article_id,day) DO UPDATE SET likes=excluded.likes,comments=excluded.comments,sampled_at=excluded.sampled_at`,
        )
        .bind(
          a.id,
          a.collected_at.slice(0, 10),
          a.likes,
          a.comments,
          a.collected_at,
        ),
    ]);
  }
  async saveAnalysis(a: Article, data: Analysis, model: string) {
    await this.run(
      "INSERT INTO analyses (article_id,body_hash,data,model,created_at) VALUES (?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET body_hash=excluded.body_hash,data=excluded.data,model=excluded.model,created_at=excluded.created_at",
      a.id,
      a.body_hash,
      JSON.stringify(data),
      model,
      new Date().toISOString(),
    );
  }
  async introduce(a: Article, publishedUrl: string) {
    const now = new Date().toISOString();
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO introductions (id,member_id,article_id,published_url,introduced_at) VALUES (?,?,?,?,?)",
        )
        .bind(crypto.randomUUID(), a.member_id, a.id, publishedUrl, now),
      this.db
        .prepare("UPDATE members SET last_introduced_at=? WHERE id=?")
        .bind(now, a.member_id),
    ]);
  }
  async setting(key: string) {
    return (
      (
        await this.db
          .prepare("SELECT value FROM settings WHERE key=?")
          .bind(key)
          .first<{ value: string }>()
      )?.value ?? null
    );
  }
  async setSetting(key: string, value: string) {
    await this.run(
      "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
  }
  async enqueue(id: string, kind: string, target = "") {
    const now = new Date().toISOString();
    await this.run(
      "INSERT OR IGNORE INTO jobs (id,kind,target,created_at,updated_at) VALUES (?,?,?,?,?)",
      id,
      kind,
      target,
      now,
      now,
    );
  }
  async claim() {
    await this.run(
      "UPDATE jobs SET state='failed',error='実行期限切れ（最大試行回数）' WHERE state='running' AND locked_until<? AND attempts>=3",
      Date.now(),
    );
    return this.db
      .prepare(
        `UPDATE jobs SET state='running',attempts=attempts+1,locked_until=?,updated_at=? WHERE id=(SELECT id FROM jobs WHERE (state='queued' AND run_after<=?) OR (state='running' AND locked_until<? AND attempts<3) ORDER BY created_at,id LIMIT 1) RETURNING *`,
      )
      .bind(
        Date.now() + 5 * 60000,
        new Date().toISOString(),
        Date.now(),
        Date.now(),
      )
      .first<Job>();
  }
  async finish(job: Job, error?: string) {
    await this.run(
      "UPDATE jobs SET state=?,error=?,run_after=?,locked_until=0,updated_at=? WHERE id=?",
      error ? (job.attempts >= 3 ? "failed" : "queued") : "done",
      error?.slice(0, 300) || null,
      Date.now() + 60000 * job.attempts,
      new Date().toISOString(),
      job.id,
    );
  }
  async jobs() {
    return this.rows(
      "SELECT id,kind,state,attempts,error,updated_at FROM jobs ORDER BY updated_at DESC LIMIT 30",
    );
  }
}
