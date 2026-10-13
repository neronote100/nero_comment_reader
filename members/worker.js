import html from "./site.html";
import css from "./site.css";
import script from "./site-script.txt";

const NOTE = "https://note.com";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const validOwner = value => /^[a-zA-Z0-9_-]{2,80}$/.test(value);
const safeText = value => String(value ?? "").trim();
const MAX_ARTICLES = 5000;
const AUDIT_DAYS = 7;

function parseRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.comments)) return payload.data.comments;
  if (Array.isArray(payload?.comments)) return payload.comments;
  return [];
}
function flatten(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return String(node.value ?? node.text ?? "");
  const content = (Array.isArray(node.children) ? node.children : []).map(flatten).join("");
  return ["p", "div", "li"].includes(node.tag_name) ? content + "\n" : content;
}
function norm(comment) {
  const user = comment.user || comment.author || {};
  return {
    key: String(comment.key || comment.comment_key || ""),
    parentKey: String(comment.parent_key || ""),
    authorUrlname: String(user.urlname || comment.urlname || "").toLowerCase(),
    authorName: String(user.nickname || user.name || ""),
    body: safeText(flatten(comment.comment ?? comment.body ?? comment.content ?? "")),
    publishedAt: String(comment.published_at || comment.created_at || ""),
    replyCount: Number(comment.reply_count ?? comment.replyCount ?? 0),
    isRoot: comment.is_root !== false,
    creatorLiked: Boolean(comment.is_creator_liked ?? comment.isCreatorLiked ?? false),
    creatorReplied: Boolean(comment.is_creator_replied ?? comment.isCreatorReplied ?? false)
  };
}
async function noteJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14000);
  try {
    const res = await fetch(NOTE + path, {
      headers: { Accept: "application/json", "User-Agent": "NeroCommentReader/Member" },
      signal: controller.signal,
      cf: { cacheTtl: 0 }
    });
    if (!res.ok) throw new Error("note API HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}
async function fetchArticles(owner) {
  const map = new Map();
  for (let page = 1; page <= 100; page++) {
    const params = new URLSearchParams({ kind: "note", disabled_pinned: "true", page: String(page) });
    const data = await noteJson("/api/v2/creators/" + encodeURIComponent(owner) + "/contents?" + params);
    const rows = data?.data?.contents || data?.contents || [];
    for (const row of rows) {
      const key = String(row.key || row.noteKey || row.note_key || "");
      if (!key) continue;
      map.set(key, {
        key,
        title: String(row.name || row.title || ""),
        commentCount: Number(row.commentCount ?? row.comment_count ?? 0),
        publishedAt: String(row.publishAt || row.publishedAt || ""),
        url: NOTE + "/" + owner + "/n/" + key
      });
    }
    if (map.size >= MAX_ARTICLES) throw new Error("記事数が上限を超えています");
    if (Boolean(data?.data?.isLastPage ?? data?.isLastPage ?? false) || !rows.length) break;
  }
  return [...map.values()];
}
async function fetchComments(articleKey, parentKey = "") {
  const comments = [];
  for (let page = 1; page <= 40; page++) {
    const params = new URLSearchParams({ order: "oldest", per_page: "100", page: String(page) });
    if (parentKey) params.set("parent_key", parentKey);
    const data = await noteJson("/api/v3/notes/" + encodeURIComponent(articleKey) + "/note_comments?" + params);
    const rows = parseRows(data);
    comments.push(...rows.map(norm));
    const next = data.next_page ?? data.nextPage ?? data.data?.next_page ?? data.data?.nextPage;
    if (!next || !rows.length) return comments;
    if (page === 40) throw new Error("コメントのページ上限に到達");
  }
  return comments;
}
function unresolvedForThread(root, replies, owner) {
  const all = [root, ...replies].filter(x => x.key)
    .sort((a, b) => (Date.parse(a.publishedAt) || 0) - (Date.parse(b.publishedAt) || 0));
  let lastOwner = -1;
  for (let i = 0; i < all.length; i++) if (all[i].authorUrlname === owner) lastOwner = i;
  const pending = all.slice(lastOwner + 1).filter(x => x.authorUrlname && x.authorUrlname !== owner && !x.creatorLiked);
  if (!pending.length) return [];
  const current = pending[pending.length - 1];
  return [{ ...current, rootKey: root.key, rootBody: root.body, pendingCount: pending.length,
    pendingBodies: pending.map(x => x.body).filter(Boolean) }];
}
async function scanArticle(article, owner) {
  const roots = (await fetchComments(article.key)).filter(x => x.isRoot);
  const only = article.scanMode === "pending_only" &&
    new Set((article.previousUnresolved || []).map(x => x.rootKey || x.key)).size > 0;
  const keys = new Set((article.previousUnresolved || []).map(x => x.rootKey || x.key));
  const unresolved = [];
  for (const root of roots) {
    if (!root.authorUrlname || root.authorUrlname === owner) continue;
    if (only && !keys.has(root.key)) continue;
    if (root.replyCount <= 0) {
      if (!root.creatorLiked) unresolved.push({ ...root, rootKey: root.key,
        rootBody: root.body, pendingCount: 1, pendingBodies: [root.body] });
      continue;
    }
    // 返信が1件でも、作者以外の返信の可能性があるのでスレッド単位で確認する。
    const replies = (await fetchComments(article.key, root.key)).filter(x => !x.isRoot);
    unresolved.push(...unresolvedForThread(root, replies, owner));
  }
  return unresolved;
}
function publicItem(article, comment) {
  return { id: article.key + ":" + comment.key, articleTitle: article.title,
    articleUrl: article.url, articleKey: article.key, commentKey: comment.key,
    authorName: comment.authorName, authorUrlname: comment.authorUrlname,
    body: comment.body, publishedAt: comment.publishedAt,
    rootBody: comment.rootBody, pendingCount: comment.pendingCount,
    pendingBodies: comment.pendingBodies };
}
export class MemberStateStore {
  constructor(state) { this.storage = state.storage; }
  async finalize(scan) {
    const failures = new Set(scan.failed.map(x => x.key));
    const items = [];
    for (const article of scan.articles) {
      if (failures.has(article.key)) continue;
      for (const comment of scan.states[article.key]?.unresolved || []) items.push(publicItem(article, comment));
    }
    items.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
    const snapshot = { owner: scan.owner, updatedAt: new Date().toISOString(),
      articleCount: scan.articles.length, scannedArticles: scan.index,
      candidateArticles: scan.candidates.length, failedArticles: scan.failed.length,
      failedArticleKeys: scan.failed, items, unresolvedCount: items.length };
    await this.storage.put("articles", scan.states);
    await this.storage.put("latest", snapshot);
    await this.storage.delete("scan");
    return snapshot;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/state") {
      return respond({ ok: true, owner: await this.storage.get("owner") || "",
        latest: await this.storage.get("latest") || null });
    }
    if (request.method === "POST" && url.pathname === "/profile") {
      const { owner } = await request.json();
      const id = String(owner || "").toLowerCase();
      if (!validOwner(id)) return respond({ ok: false, error: "noteユーザー名が不正です" }, 400);
      if ((await this.storage.get("owner")) !== id) {
        await this.storage.put("owner", id);
        await this.storage.delete("articles");
        await this.storage.delete("latest");
        await this.storage.delete("scan");
      }
      return respond({ ok: true, owner: id });
    }
    if (request.method === "POST" && url.pathname === "/start") {
      const { owner, articles } = await request.json();
      if (owner !== await this.storage.get("owner")) return respond({ ok: false, error: "Profile changed" }, 409);
      if (!Array.isArray(articles) || articles.length > MAX_ARTICLES) return respond({ ok: false, error: "Invalid article list" }, 400);
      const oldStates = await this.storage.get("articles") || {};
      const states = {};
      const candidates = [];
      const day = Math.floor(Date.now() / 86400000);
      for (const article of articles) {
        const old = oldStates[article.key];
        states[article.key] = old ? { ...old, ...article } : { ...article, unresolved: [], checkedAt: 0 };
        if (article.commentCount <= 0) {
          states[article.key] = { ...article, unresolved: [], checkedAt: Date.now() };
          continue;
        }
        let hash = 0;
        for (const c of article.key) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
        const countChanged = !old || Number(old.commentCount || 0) !== Number(article.commentCount || 0);
        const pending = Boolean(old?.unresolved?.length);
        const failed = !old || old.error || !Number(old.checkedAt);
        const audit = !pending && old?.checkedAt && Date.now() - old.checkedAt > AUDIT_DAYS * 86400000 && hash % 7 === day % 7;
        if (countChanged || pending || failed || audit) {
          candidates.push({ ...article, previousUnresolved: old?.unresolved || [],
            scanMode: pending && !countChanged && !failed && !audit ? "pending_only" : "full" });
        }
      }
      const scan = { id: crypto.randomUUID(), owner, articles, candidates, states,
        index: 0, failed: [], startedAt: Date.now() };
      if (!candidates.length) return respond({ ok: true, done: true, ...await this.finalize(scan) });
      await this.storage.put("scan", scan);
      return respond({ ok: true, done: false, scanId: scan.id, scannedArticles: 0, candidateArticles: candidates.length });
    }
    if (request.method === "GET" && url.pathname === "/peek") {
      const scan = await this.storage.get("scan");
      const id = url.searchParams.get("scan_id");
      if (!scan || scan.id !== id || Date.now() - scan.startedAt > 3600000) return respond({ ok: false, error: "Scan expired" }, 409);
      return respond({ ok: true, index: scan.index, article: scan.candidates[scan.index] || null, owner: scan.owner });
    }
    if (request.method === "POST" && url.pathname === "/commit") {
      const { scanId, index, unresolved, error } = await request.json();
      const scan = await this.storage.get("scan");
      if (!scan || scan.id !== scanId || scan.index !== index) return respond({ ok: false, error: "Scan conflict" }, 409);
      const article = scan.candidates[scan.index];
      if (!article) return respond({ ok: false, error: "No article" }, 409);
      if (error) {
        scan.failed.push({ key: article.key, title: article.title, error: String(error) });
        scan.states[article.key] = { ...scan.states[article.key], error: true, checkedAt: 0 };
      } else {
        scan.states[article.key] = { ...article, unresolved, checkedAt: Date.now(), error: false };
      }
      scan.index++;
      if (scan.index === scan.candidates.length) return respond({ ok: true, done: true, ...await this.finalize(scan) });
      await this.storage.put("scan", scan);
      return respond({ ok: true, done: false, scanId: scan.id, scannedArticles: scan.index,
        candidateArticles: scan.candidates.length, failedArticles: scan.failed.length });
    }
    return respond({ ok: false, error: "Not Found" }, 404);
  }
}
export default {
  async fetch(request, env, ctx) {
    // fail closed: never trust a client-supplied email or auth header
    if (!ctx.access) return respond({ ok: false, error: "Cloudflare Access protection is required" }, 403);
    const identity = await ctx.access.getIdentity();
    const email = String(identity?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return respond({ ok: false, error: "Verified email required" }, 403);
    if (!env.MEMBER_STATE) return respond({ ok: false, error: "Member storage unavailable" }, 503);
    const stub = env.MEMBER_STATE.get(env.MEMBER_STATE.idFromName(email));
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === "/") return new Response(html, { headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' https://assets.st-note.com data:; base-uri 'none'; frame-ancestors 'none'"
    } });
    if (request.method === "GET" && path === "/site.css") return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } });
    if (request.method === "GET" && path === "/site.js") return new Response(script, { headers: { "content-type": "application/javascript; charset=utf-8" } });
    if (request.method === "GET" && path === "/api/me") {
      const response = await stub.fetch("https://member-state/state");
      const state = await response.json();
      return respond({ ...state, email });
    }
    if (request.method === "POST" && path === "/api/profile") {
      return stub.fetch(new Request("https://member-state/profile", request));
    }
    if (request.method === "POST" && path === "/api/sync/start") {
      try {
        const state = await (await stub.fetch("https://member-state/state")).json();
        if (!validOwner(state.owner)) return respond({ ok: false, error: "noteユーザー名を先に登録してください" }, 400);
        const articles = await fetchArticles(state.owner);
        return stub.fetch("https://member-state/start", { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: state.owner, articles }) });
      } catch (error) { return respond({ ok: false, error: String(error?.message || error) }, 502); }
    }
    if (request.method === "POST" && path === "/api/sync/next") {
      try {
        const { scanId } = await request.json();
        if (!/^[0-9a-f-]{36}$/i.test(String(scanId))) return respond({ ok: false, error: "Invalid scan" }, 400);
        const peekResponse = await stub.fetch("https://member-state/peek?scan_id=" + encodeURIComponent(scanId));
        if (!peekResponse.ok) return respond({ ok: false, error: "Scan expired" }, 409);
        const { article, owner, index } = await peekResponse.json();
        let unresolved = [];
        let error = "";
        try { unresolved = await scanArticle(article, owner); }
        catch (caught) { error = String(caught?.message || caught); }
        return stub.fetch("https://member-state/commit", { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scanId, index, unresolved, error }) });
      } catch (error) { return respond({ ok: false, error: String(error?.message || error) }, 502); }
    }
    return respond({ ok: false, error: "Not found" }, 404);
  }
};
