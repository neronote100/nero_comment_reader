import { plainText, type Article, type Member } from "../domain";
import type { NoteProvider } from "../ports";
import { hash, jsonFetch } from "./security";
const number = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
export class NoteClient implements NoteProvider {
  async list(username: string, page: number) {
    const payload = await jsonFetch<{
      data: { contents: Record<string, unknown>[]; isLastPage: boolean };
    }>(
      `https://note.com/api/v2/creators/${encodeURIComponent(username)}/contents?kind=note&disabled_pinned=true&page=${page}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "NeroRoyalLibrary/1.0",
        },
      },
    );
    if (!Array.isArray(payload.data?.contents))
      throw new Error("note記事一覧の形式が変わりました");
    return {
      rows: payload.data.contents,
      last:
        Boolean(payload.data.isLastPage) || payload.data.contents.length === 0,
    };
  }
  async detail(member: Member, row: Record<string, unknown>): Promise<Article> {
    const id = String(row.key || row.noteKey || row.note_key || "");
    if (!/^n[a-f0-9]{12}$/i.test(id)) throw new Error("note記事キーが不正です");
    const payload = await jsonFetch<{ data: Record<string, unknown> }>(
      `https://note.com/api/v3/notes/${id}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "NeroRoyalLibrary/1.0",
        },
      },
    );
    const d = payload.data;
    if (!d || typeof d.name !== "string")
      throw new Error("note記事本文の形式が変わりました");
    const user = d.user as { urlname?: string } | undefined;
    if (
      !user?.urlname ||
      user.urlname.toLowerCase() !== member.note_username?.toLowerCase()
    )
      throw new Error("記事の投稿者が一致しません");
    const body = plainText(typeof d.body === "string" ? d.body : "").slice(
      0,
      100000,
    );
    const paid =
      Number(d.price || row.price || 0) > 0 ||
      Boolean(
        d.is_limited ||
        d.isLimited ||
        d.isPaid ||
        row.isLimited ||
        d.can_read === false,
      );
    const rawDate = String(
      d.publish_at ||
        d.publishAt ||
        d.publishedAt ||
        row.publishAt ||
        row.publishedAt ||
        "",
    );
    const published_at = new Date(rawDate).toISOString();
    const rawTags = d.hashtag_notes || d.hashtags || row.hashtags;
    const tags = Array.isArray(rawTags)
      ? rawTags
          .map((t) => {
            if (typeof t === "string") return t;
            const tag = t as {
              hashtag?: string | { name?: string };
              name?: string;
            };
            return typeof tag?.hashtag === "string"
              ? tag.hashtag
              : tag?.hashtag?.name || tag?.name || "";
          })
          .filter(Boolean)
      : [];
    const thumbnail = String(d.eyecatch || row.eyecatch || "");
    return {
      id,
      member_id: member.id,
      title: d.name.slice(0, 500),
      url: `https://note.com/${member.note_username}/n/${id}`,
      published_at,
      likes: number(d.likeCount ?? d.like_count ?? row.likeCount),
      comments: number(d.commentCount ?? d.comment_count ?? row.commentCount),
      tags: JSON.stringify(tags),
      thumbnail: /^https:\/\/assets\.st-note\.com\//.test(thumbnail)
        ? thumbnail
        : "",
      body,
      body_hash: await hash(body),
      body_status: body ? (paid ? "preview" : "public") : "unavailable",
      collected_at: new Date().toISOString(),
      participated: 0,
      favorite: 0,
      available: 1,
    };
  }
}
