export type MemberStatus = "active" | "withdraw" | "pending";
export interface Member {
  id: string;
  name: string;
  note_username: string | null;
  profile_url: string;
  account_url: string;
  discord_name: string;
  tags: string;
  priority: number;
  status: MemberStatus;
  received_at: string;
  joined_at: string;
  last_event_at: string;
  last_status_at: string;
  last_introduced_at: string | null;
  plan: string;
  synced_at: string | null;
  sync_error: string | null;
  created_at: string;
}
export interface Article {
  id: string;
  member_id: string;
  title: string;
  url: string;
  published_at: string;
  likes: number;
  comments: number;
  tags: string;
  thumbnail: string;
  body: string;
  body_hash: string;
  body_status: "public" | "preview" | "unavailable";
  collected_at: string;
  participated: number;
  favorite: number;
  available: number;
}
export interface Analysis {
  overview: string;
  summary: string;
  charms: string[];
  goodPoints: string[];
  recommendedPoints: string[];
  audience: string;
  aiRating: number;
  reason: string;
  introductionPoints: string[];
  quotes: string[];
  introduction: string;
  comment: string;
}
export interface Candidate extends Article {
  member_name: string;
  joined_at: string;
  priority: number;
  last_introduced_at: string | null;
  analysis?: Analysis;
  score: number;
  introduced: boolean;
  growth: {
    likes: number;
    comments: number;
    likeRate: number | null;
    commentRate: number | null;
    baselineAt: string;
  } | null;
}
export interface MembershipEvent {
  id: string;
  member_id: string | null;
  received_at: string;
  kind: "join" | "withdraw" | "plan" | "unknown";
  status: "ready" | "pending" | "applied";
  subject: string;
  candidate_username: string | null;
  candidate_name: string | null;
  plan_name: string | null;
  reason: string | null;
}
export interface Job {
  id: string;
  kind: string;
  target: string;
  state: string;
  attempts: number;
}
export const DAY = 86400000;
export const usernameValid = (s: string) => /^[a-zA-Z0-9_-]{2,80}$/.test(s);
export function noteUrl(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.hostname !== "note.com" ||
    u.username ||
    u.password ||
    u.port
  )
    throw new Error("note.com のHTTPS URLを入力してください");
  return u.origin + u.pathname;
}
export function daysSince(
  value: string | null,
  now = Date.now(),
): number | null {
  return value
    ? Math.max(0, Math.floor((now - Date.parse(value)) / DAY))
    : null;
}
export function score(
  a: Pick<Article, "likes" | "comments" | "participated" | "favorite">,
  rating = 0,
): number {
  return (
    a.likes +
    a.comments * 3 +
    Math.max(0, Math.min(5, rating)) * 20 +
    a.participated * 30 +
    a.favorite * 100
  );
}
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, v: string) => {
      const n =
        v[0].toLowerCase() === "x" ? parseInt(v.slice(1), 16) : Number(v);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}
export function validateAnalysis(value: unknown, body: string): Analysis {
  if (!value || typeof value !== "object") throw new Error("AI出力が不正です");
  const a = value as Record<string, unknown>;
  for (const key of [
    "overview",
    "summary",
    "audience",
    "reason",
    "introduction",
    "comment",
  ])
    if (
      typeof a[key] !== "string" ||
      !(a[key] as string).trim() ||
      (a[key] as string).length > 3000
    )
      throw new Error("AI出力項目が不正です: " + key);
  for (const key of [
    "charms",
    "goodPoints",
    "recommendedPoints",
    "introductionPoints",
    "quotes",
  ])
    if (
      !Array.isArray(a[key]) ||
      (a[key] as unknown[]).length > 10 ||
      (a[key] as unknown[]).some(
        (x) => typeof x !== "string" || x.length > 1000,
      )
    )
      throw new Error("AI出力配列が不正です: " + key);
  if (
    typeof a.aiRating !== "number" ||
    !Number.isFinite(a.aiRating) ||
    a.aiRating < 0 ||
    a.aiRating > 5
  )
    throw new Error("AI評価は0〜5です");
  // 引用は原文一致かつ総計80文字以下。創作・不正な引用は採用しない。
  const quotes: string[] = [];
  let size = 0;
  for (const q of a.quotes as string[])
    if (q && body.includes(q) && size + q.length <= 80) {
      quotes.push(q);
      size += q.length;
    }
  return { ...a, quotes } as unknown as Analysis;
}
