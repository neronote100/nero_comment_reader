const DEFAULT_INBOX_URL = "https://neronote100.github.io/nero_comment_reader/data/inbox.json";
const MCP_PROTOCOL_VERSION = "2025-06-18";

export class CommentSnapshotStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/latest") {
      const latest = await this.state.storage.get("latest");
      return new Response(JSON.stringify(latest || null), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/append") {
      const payload = await request.json();
      const scanId = String(payload?.scanId || "");
      const result = payload?.result;
      const start = Boolean(payload?.start);
      if (!scanId || !result || typeof result !== "object") {
        return new Response(JSON.stringify({ ok: false, error: "invalid payload" }), { status: 400 });
      }

      const scanKey = "scan:" + scanId;
      let scan = start ? null : await this.state.storage.get(scanKey);

      if (start) {
        if (Number(result.offset || 0) !== 0) {
          return new Response(JSON.stringify({ ok: false, error: "scan must start at offset 0" }), { status: 409 });
        }
        scan = {
          scanId,
          startedAt: new Date().toISOString(),
          articleCount: Number(result.articleCount || 0),
          candidateArticles: Number(result.candidateArticles || 0),
          expectedOffset: 0,
          failedArticles: 0,
          failedArticleKeys: [],
          items: [],
        };
      } else if (!scan) {
        return new Response(JSON.stringify({ ok: false, error: "scan not found" }), { status: 409 });
      }

      if (Number(result.offset || 0) !== Number(scan.expectedOffset || 0)) {
        return new Response(JSON.stringify({
          ok: false,
          error: "unexpected scan offset",
          gotOffset: Number(result.offset || 0),
          expectedOffset: Number(scan.expectedOffset || 0),
          scanId,
        }), { status: 409 });
      }

      const merged = new Map(
        (Array.isArray(scan.items) ? scan.items : []).map(item => [String(item?.id || ""), item])
      );
      for (const item of Array.isArray(result.items) ? result.items : []) {
        if (item?.id) merged.set(String(item.id), item);
      }

      scan.items = [...merged.values()];
      scan.articleCount = Number(result.articleCount || scan.articleCount || 0);
      scan.candidateArticles = Number(result.candidateArticles || scan.candidateArticles || 0);
      scan.failedArticles = Number(scan.failedArticles || 0) + Number(result.failedArticles || 0);
      scan.failedArticleKeys = [
        ...(Array.isArray(scan.failedArticleKeys) ? scan.failedArticleKeys : []),
        ...(Array.isArray(result.failedArticleKeys) ? result.failedArticleKeys : []),
      ];
      scan.expectedOffset = result.nextOffset;
      scan.updatedAt = result.updatedAt || new Date().toISOString();

      if (result.nextOffset === null || result.nextOffset === undefined) {
        scan.items.sort((a, b) => (Date.parse(b?.publishedAt) || 0) - (Date.parse(a?.publishedAt) || 0));
        const latest = {
          version: 4,
          source: "manual_live_scan",
          owner: NOTE_OWNER,
          updatedAt: scan.updatedAt,
          articleCount: scan.articleCount,
          unresolvedCount: scan.items.length,
          candidateArticles: scan.candidateArticles,
          scannedArticles: scan.candidateArticles,
          failedArticles: scan.failedArticles,
          failedArticleKeys: scan.failedArticleKeys,
          items: scan.items,
        };
        await this.state.storage.put("latest", latest);
        await this.state.storage.delete(scanKey);
        return new Response(JSON.stringify({ ok: true, finalized: true }), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      await this.state.storage.put(scanKey, scan);
      return new Response(JSON.stringify({ ok: true, finalized: false }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}


const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, accept, mcp-session-id, authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function rpcResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return json({ jsonrpc: "2.0", id: id ?? null, error }, 200);
}

async function loadInbox(env) {
  const url = env?.INBOX_URL || DEFAULT_INBOX_URL;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cf: { cacheTtl: 15, cacheEverything: true },
  });
  if (!response.ok) throw new Error("Comment Reader data returned HTTP " + response.status);
  const data = await response.json();
  return {
    version: Number(data?.version || 1),
    owner: String(data?.owner || "nero_notelover"),
    updatedAt: data?.updatedAt || null,
    articleCount: Number(data?.articleCount || 0),
    unresolvedCount: Number(data?.unresolvedCount || 0),
    failedArticles: Number(data?.failedArticles || 0),
    items: Array.isArray(data?.items) ? data.items : [],
  };
}

function publicComment(item) {
  return {
    id: String(item?.id || ""),
    authorName: String(item?.authorName || ""),
    authorUrlname: String(item?.authorUrlname || ""),
    body: String(item?.body || ""),
    publishedAt: item?.publishedAt || null,
    articleTitle: String(item?.articleTitle || ""),
    articleUrl: String(item?.articleUrl || ""),
    rootBody: String(item?.rootBody || ""),
    rootAuthorUrlname: String(item?.rootAuthorUrlname || ""),
    pendingCount: Number(item?.pendingCount || 1),
    pendingBodies: Array.isArray(item?.pendingBodies) ? item.pendingBodies.map(String) : [String(item?.body || "")],
  };
}

function groupByArticle(items) {
  const groups = new Map();
  for (const item of items) {
    const articleUrl = String(item?.articleUrl || "");
    const articleTitle = String(item?.articleTitle || "");
    const key = articleUrl || articleTitle || "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        articleTitle,
        articleUrl,
        commentCount: 0,
        comments: [],
      });
    }
    const group = groups.get(key);
    group.comments.push(publicComment(item));
    group.commentCount = group.comments.length;
  }
  return [...groups.values()];
}


const NOTE_OWNER = "nero_notelover";
const DEFAULT_STATE_URL = "https://neronote100.github.io/nero_comment_reader/data/state.json";


async function noteJsonFresh(path) {
  const response = await fetch("https://note.com" + path, {
    headers: {
      Accept: "application/json",
      "User-Agent": "NeroCommentReader/0.4 (+https://neronote100.github.io/nero_comment_reader/)",
    },
    cf: { cacheTtl: 0 },
  });
  if (!response.ok) throw new Error("note API returned HTTP " + response.status + " for " + path);
  return response.json();
}

async function loadSavedState() {
  try {
    const response = await fetch(DEFAULT_STATE_URL + "?t=" + Date.now(), {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0 },
    });
    if (!response.ok) return { articles: {} };
    const data = await response.json();
    return data && typeof data === "object" ? data : { articles: {} };
  } catch {
    return { articles: {} };
  }
}

function astCommentText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(astCommentText).filter(Boolean).join("");
  if (typeof node !== "object") return "";
  if (node.type === "text") return String(node.value ?? node.text ?? "");
  const children = Array.isArray(node.children) ? node.children : [];
  const inner = children.map(astCommentText).join("");
  const tag = String(node.tag_name || node.tagName || "").toLowerCase();
  return ["p","div","blockquote","li"].includes(tag) ? inner + "\n" : inner;
}

function normalizeLiveComment(raw) {
  const user = raw?.user || raw?.author || {};
  return {
    key: String(raw?.key || raw?.comment_key || ""),
    parentKey: String(raw?.parent_key || raw?.parentKey || ""),
    authorUrlname: String(user?.urlname || raw?.urlname || "").toLowerCase(),
    authorName: String(user?.nickname || user?.name || raw?.nickname || ""),
    avatar: String(user?.profile_image_url || user?.profileImageUrl || raw?.profile_image_url || ""),
    body: String(astCommentText(raw?.comment ?? raw?.body ?? raw?.content ?? "")).replace(/\r/g,"").trim(),
    publishedAt: String(raw?.published_at || raw?.publish_at || raw?.created_at || raw?.createdAt || ""),
    isRoot: raw?.is_root !== false,
    replyCount: Number(raw?.reply_count || raw?.replyCount || 0),
    creatorReplied: Boolean(raw?.is_creator_replied ?? raw?.isCreatorReplied ?? false),
    creatorLiked: Boolean(raw?.is_creator_liked ?? raw?.isCreatorLiked ?? false),
  };
}

function liveCommentRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.comments)) return payload.data.comments;
  if (Array.isArray(payload?.comments)) return payload.comments;
  return [];
}

function liveNextPage(payload) {
  return payload?.next_page ?? payload?.nextPage ?? payload?.data?.next_page ?? payload?.data?.nextPage ?? null;
}

async function fetchLiveComments(noteKey, parentKey = "") {
  const all = [];
  let page = 1;
  for (let guard = 0; guard < 20; guard += 1) {
    const params = new URLSearchParams({ order: "oldest", per_page: "100", page: String(page) });
    if (parentKey) params.set("parent_key", parentKey);
    const payload = await noteJsonFresh(
      "/api/v3/notes/" + encodeURIComponent(noteKey) + "/note_comments?" + params.toString()
    );
    const rows = liveCommentRows(payload);
    all.push(...rows);
    const next = liveNextPage(payload);
    if (!next || rows.length === 0) break;
    const n = Number(next);
    page = Number.isFinite(n) && n > page ? n : page + 1;
  }
  return all.map(normalizeLiveComment);
}

async function fetchCreatorArticlesLive() {
  const byKey = new Map();
  for (let page = 1; page <= 100; page += 1) {
    const params = new URLSearchParams({
      kind: "note",
      disabled_pinned: "true",
      page: String(page),
    });
    const payload = await noteJsonFresh(
      "/api/v2/creators/" + encodeURIComponent(NOTE_OWNER) + "/contents?" + params.toString()
    );
    const data = payload?.data || {};
    const rows = Array.isArray(data?.contents) ? data.contents : Array.isArray(payload?.contents) ? payload.contents : [];
    for (const row of rows) {
      const key = String(row?.key || row?.noteKey || row?.note_key || "");
      if (!key) continue;
      byKey.set(key, {
        key,
        title: String(row?.name || row?.title || ""),
        commentCount: Number(row?.commentCount ?? row?.comment_count ?? 0),
        publishedAt: String(row?.publishAt || row?.publishedAt || row?.publish_at || ""),
        url: "https://note.com/" + NOTE_OWNER + "/n/" + key,
      });
    }
    const last = Boolean(data?.isLastPage ?? data?.is_last_page ?? payload?.isLastPage ?? false);
    if (last || rows.length === 0) break;
  }
  return [...byKey.values()];
}

function unresolvedLiveThread(root, replies) {
  const thread = [root, ...replies]
    .filter(item => item && item.key)
    .sort((a,b)=>(Date.parse(a.publishedAt)||0)-(Date.parse(b.publishedAt)||0));

  let lastOwner = -1;
  for (let i = 0; i < thread.length; i += 1) {
    if (thread[i].authorUrlname === NOTE_OWNER) lastOwner = i;
  }

  const pending = [];
  for (let i = lastOwner + 1; i < thread.length; i += 1) {
    const item = thread[i];
    if (!item.authorUrlname || item.authorUrlname === NOTE_OWNER || item.creatorLiked) continue;
    pending.push(item);
  }

  if (!pending.length) return [];

  // 長い会話で相手が連投していても、1スレッドにつき1件だけ対応対象にする。
  // 最新コメントを代表にし、返信案生成用に未対応文脈も保持する。
  const latest = pending[pending.length - 1];
  return [{
    ...latest,
    rootKey: root.key,
    rootAuthorUrlname: root.authorUrlname,
    rootBody: root.body,
    pendingCount: pending.length,
    pendingBodies: pending.map(item => item.body).filter(Boolean),
  }];
}

async function scanLiveArticle(article) {
  const roots = (await fetchLiveComments(article.key)).filter(comment=>comment.isRoot !== false);
  const unresolved = [];
  const previousRootKeys = new Set(
    (Array.isArray(article?.previousUnresolved) ? article.previousUnresolved : [])
      .map(item => String(item?.rootKey || item?.key || ""))
      .filter(Boolean)
  );
  const pendingOnly = article?.scanMode === "pending_only" && previousRootKeys.size > 0;

  for (const root of roots) {
    if (!root.authorUrlname || root.authorUrlname === NOTE_OWNER) continue;
    // コメント総数が変わっていない「前回未対応だけ残っている記事」は、
    // 前回未対応だったスレッドだけ再確認すればよい。解決済みの長いスレッドを
    // 毎回すべて読み直さず、Workers の外部リクエスト上限を節約する。
    if (pendingOnly && !previousRootKeys.has(root.key)) continue;

    // 返信なしなら、王子スキの有無だけで判定できる。
    if (root.replyCount <= 0) {
      if (!root.creatorLiked) {
        unresolved.push({
          ...root,
          rootKey: root.key,
          rootAuthorUrlname: root.authorUrlname,
          rootBody: root.body,
          pendingCount: 1,
          pendingBodies: [root.body],
        });
      }
      continue;
    }

    // 返信が1件だけで、note側が「作者返信済み」と返している場合は、
    // その1件が王子の返信なので会話は対応済み。余分なAPI呼び出しを避ける。
    if (root.replyCount === 1 && root.creatorReplied) continue;

    // 2往復以上、または作者返信フラグだけでは判断できない場合は、
    // parent_key でスレッド全体を取得して最後の王子返信より後だけを見る。
    const replies = (await fetchLiveComments(article.key, root.key))
      .filter(comment => comment.isRoot === false);
    unresolved.push(...unresolvedLiveThread(root, replies));
  }

  return unresolved;
}

function publicLiveItem(article, comment) {
  return {
    id: article.key + ":" + comment.key,
    articleKey: article.key,
    articleTitle: article.title,
    articleUrl: article.url,
    articlePublishedAt: article.publishedAt,
    commentKey: comment.key,
    rootKey: comment.rootKey,
    authorUrlname: comment.authorUrlname,
    authorName: comment.authorName,
    avatar: comment.avatar,
    body: comment.body,
    publishedAt: comment.publishedAt,
    rootAuthorUrlname: comment.rootAuthorUrlname,
    rootBody: comment.rootBody,
    pendingCount: Number(comment.pendingCount || 1),
    pendingBodies: Array.isArray(comment.pendingBodies) ? comment.pendingBodies : [comment.body],
  };
}

async function getLiveCandidateArticles() {
  const [savedState, articles] = await Promise.all([
    loadSavedState(),
    fetchCreatorArticlesLive(),
  ]);
  const oldArticles = savedState?.articles && typeof savedState.articles === "object" ? savedState.articles : {};
  const candidates = [];

  for (const article of articles) {
    if (article.commentCount <= 0) continue;
    const old = oldArticles[article.key];
    const oldPending = Array.isArray(old?.unresolved) && old.unresolved.length > 0;
    const countChanged = !old || Number(old.commentCount || 0) !== article.commentCount;
    const oldFailed = Boolean(old?.error) || Number(old?.checkedAt || 0) <= 0;
    if (oldPending || countChanged || oldFailed) {
      candidates.push({
        ...article,
        reason: oldPending ? "previously_pending" : countChanged ? "comment_count_changed" : "previous_scan_failed",
        scanMode: oldPending && !countChanged && !oldFailed ? "pending_only" : "full",
        previousUnresolved: Array.isArray(old?.unresolved) ? old.unresolved : [],
      });
    }
  }

  return { articles, candidates };
}

async function buildLiveCommentBatch(offset = 0, batchSize = 10) {
  const { articles, candidates } = await getLiveCandidateArticles();
  const start = Math.max(0, Number(offset || 0));
  // 1記事内に長い返信スレッドが数十本あることがある。
  // Workersの外部サブリクエスト上限を超えないよう、ライブ判定は1記事ずつ処理する。
  const size = 1;
  const selected = candidates.slice(start, start + size);
  const items = [];
  let failedArticles = 0;
  const failedArticleKeys = [];

  for (const article of selected) {
    try {
      const unresolved = await scanLiveArticle(article);
      for (const comment of unresolved) items.push(publicLiveItem(article, comment));
    } catch (error) {
      // 取得失敗時に古い未返信データを復活させると「返信済みなのに未返信」に戻る。
      // 失敗記事は判定保留として除外し、次回更新時に再試行する。
      failedArticles += 1;
      failedArticleKeys.push({
        key: article.key,
        title: article.title,
        error: String(error?.message || error),
      });
    }
  }

  items.sort((a,b)=>(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0));
  const nextOffset = start + selected.length < candidates.length ? start + selected.length : null;

  return {
    owner: NOTE_OWNER,
    updatedAt: new Date().toISOString(),
    articleCount: articles.length,
    candidateArticles: candidates.length,
    scannedArticles: selected.length,
    failedArticles,
    failedArticleKeys,
    offset: start,
    nextOffset,
    items,
  };
}


async function loadPublishedInbox(env) {
  if (!env?.COMMENT_SNAPSHOT) return null;
  try {
    const id = env.COMMENT_SNAPSHOT.idFromName(NOTE_OWNER);
    const stub = env.COMMENT_SNAPSHOT.get(id);
    const response = await stub.fetch("https://comment-snapshot/latest");
    if (!response.ok) return null;
    const data = await response.json();
    return data && Array.isArray(data.items) ? data : null;
  } catch {
    return null;
  }
}

async function recordLiveBatch(env, scanId, result, start) {
  if (!env?.COMMENT_SNAPSHOT) return { ok: false, error: "COMMENT_SNAPSHOT binding missing" };
  const id = env.COMMENT_SNAPSHOT.idFromName(NOTE_OWNER);
  const stub = env.COMMENT_SNAPSHOT.get(id);
  const response = await stub.fetch("https://comment-snapshot/append", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scanId, result, start }),
  });
  let detail = null;
  try { detail = await response.json(); } catch {}
  return {
    ok: response.ok && detail?.ok !== false,
    status: response.status,
    detail,
    error: response.ok ? null : (detail?.error || "snapshot append failed"),
  };
}

let liveSnapshotMemory = null;
let liveSnapshotMemoryAt = 0;
const LIVE_SNAPSHOT_TTL_MS = 15 * 1000;

async function buildLiveInboxSnapshot() {
  const { articles, candidates } = await getLiveCandidateArticles();
  const items = [];
  let failedArticles = 0;
  const failedArticleKeys = [];

  for (const article of candidates) {
    try {
      const unresolved = await scanLiveArticle(article);
      for (const comment of unresolved) {
        items.push(publicLiveItem(article, comment));
      }
    } catch (error) {
      // 取得に失敗した記事は古い保存データで補完しない。
      // 「返信済みなのに未返信」に戻すより、判定保留として除外する。
      failedArticles += 1;
      failedArticleKeys.push({
        key: article.key,
        title: article.title,
        error: String(error?.message || error),
      });
    }
  }

  items.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));

  return {
    version: 3,
    source: "live",
    owner: NOTE_OWNER,
    updatedAt: new Date().toISOString(),
    articleCount: articles.length,
    unresolvedCount: items.length,
    candidateArticles: candidates.length,
    scannedArticles: candidates.length,
    failedArticles,
    failedArticleKeys,
    items,
  };
}

async function loadCurrentInbox(env) {
  const published = await loadPublishedInbox(env);
  if (published) return published;

  const now = Date.now();
  if (liveSnapshotMemory && now - liveSnapshotMemoryAt < LIVE_SNAPSHOT_TTL_MS) {
    return liveSnapshotMemory;
  }

  // GitHub Pages の data/inbox.json は手動更新前の保存スナップショットなので、
  // ChatGPT からの未返信確認では使わない。note API をその場で再判定する。
  const snapshot = await buildLiveInboxSnapshot();
  liveSnapshotMemory = snapshot;
  liveSnapshotMemoryAt = now;
  return snapshot;
}

async function noteJson(path) {
  const response = await fetch("https://note.com" + path, {
    headers: {
      Accept: "application/json",
      "User-Agent": "NeroCommentReader/0.3 (+https://neronote100.github.io/nero_comment_reader/)",
    },
    cf: { cacheTtl: 20, cacheEverything: true },
  });
  if (!response.ok) throw new Error("note API returned HTTP " + response.status + " for " + path);
  return response.json();
}

function textFromAny(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    return value
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  if (Array.isArray(value)) return value.map(textFromAny).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.value === "string") return value.value;
    if (typeof value.text === "string") return value.text;
    if (value.children) return textFromAny(value.children);
    return Object.values(value).map(textFromAny).filter(Boolean).join("\n");
  }
  return "";
}

function normalizeEventArticle(raw) {
  const user = raw?.user || {};
  const key = String(raw?.key || "");
  const authorUrlname = String(user?.urlname || "");
  const title = String(raw?.name || raw?.title || "");
  return {
    key,
    title,
    authorName: String(user?.nickname || user?.name || authorUrlname),
    authorUrlname,
    publishedAt: raw?.publish_at || raw?.published_at || raw?.created_at || null,
    articleUrl: key && authorUrlname ? "https://note.com/" + authorUrlname + "/n/" + key : "",
    preview: textFromAny(raw?.body || raw?.description || "").slice(0, 1400),
    likeCount: Number(raw?.like_count || 0),
  };
}

function normalizeTag(value) {
  return decodeURIComponent(String(value || "").trim()).replace(/^#+/, "").trim();
}

function magazineKey(value) {
  const match = String(value || "").match(/m[a-f0-9]{10,}/i);
  if (!match) throw new Error("マガジンURLまたは m から始まるマガジンキーを指定してください。");
  return match[0];
}

async function fetchEventSourcePage(sourceType, source, page) {
  if (sourceType === "hashtag") {
    const tag = normalizeTag(source);
    if (!tag) throw new Error("ハッシュタグを指定してください。");
    const payload = await noteJson(
      "/api/v3/hashtags/" + encodeURIComponent(tag) + "/notes?order=new&page=" + page + "&paid_only=false"
    );
    const data = payload?.data || {};
    return {
      sourceLabel: "#" + tag,
      articles: Array.isArray(data.notes) ? data.notes : [],
      nextPage: data.next_page ?? null,
    };
  }

  if (sourceType === "magazine") {
    const key = magazineKey(source);
    const payload = await noteJson("/api/v1/magazines/" + key + "/notes?page=" + page);
    const data = payload?.data || {};
    return {
      sourceLabel: String(data.name || key),
      magazineKey: key,
      articles: Array.isArray(data.notes) ? data.notes : [],
      nextPage: data.next_page ?? null,
    };
  }

  throw new Error("sourceType must be hashtag or magazine");
}

async function ownerCommentedOnArticle(noteKey, owner = NOTE_OWNER) {
  let page = 1;
  for (let guard = 0; guard < 8; guard += 1) {
    const payload = await noteJson(
      "/api/v3/notes/" + encodeURIComponent(noteKey) + "/note_comments?order=newest&per_page=100&page=" + page
    );
    const comments = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.data?.comments)
        ? payload.data.comments
        : [];
    if (comments.some((comment) => String(comment?.user?.urlname || "") === owner)) return true;
    const nextPage = payload?.next_page ?? payload?.data?.next_page ?? null;
    if (!nextPage) break;
    page = Number(nextPage) || page + 1;
  }
  return false;
}

async function enrichEventArticle(article) {
  try {
    const payload = await noteJson("/api/v3/notes/" + encodeURIComponent(article.key));
    const data = payload?.data || {};
    const body = textFromAny(
      data?.body ||
      data?.note?.body ||
      data?.note_draft?.body ||
      article.preview
    );
    return { ...article, body: body.slice(0, 12000) };
  } catch {
    return { ...article, body: article.preview };
  }
}

async function getEventSourcePage(sourceType, source, page = 1) {
  const sourcePage = await fetchEventSourcePage(sourceType, source, Math.max(1, Number(page || 1)));
  const articles = sourcePage.articles
    .map(normalizeEventArticle)
    .filter(article => article.key && article.authorUrlname);
  return {
    sourceType,
    source: sourcePage.sourceLabel || String(source || ""),
    magazineKey: sourcePage.magazineKey || null,
    page: Math.max(1, Number(page || 1)),
    nextPage: sourcePage.nextPage ?? null,
    count: articles.length,
    articles,
  };
}

async function checkEventArticle(article) {
  if (!article?.key || !article?.authorUrlname) {
    return { status: "invalid", article, error: "記事情報が不足しています。" };
  }
  if (article.authorUrlname === NOTE_OWNER) {
    return { status: "own", article };
  }

  try {
    const commented = await ownerCommentedOnArticle(article.key, NOTE_OWNER);
    if (commented) return { status: "commented", article };
    return { status: "uncommented", article: await enrichEventArticle(article) };
  } catch (error) {
    // 判定失敗を未コメント扱いにすると、対応済み記事が再表示される。
    return {
      status: "unknown",
      article,
      error: String(error?.message || error),
    };
  }
}

async function scanEventArticles(sourceType, source, limit = 5, startPage = 1) {
  const target = Math.min(10, Math.max(1, Number(limit || 5)));
  let page = Math.max(1, Number(startPage || 1));
  let inspected = 0;
  let skippedCommented = 0;
  let skippedOwn = 0;
  let sourceLabel = sourceType === "hashtag" ? "#" + normalizeTag(source) : String(source);
  const selected = [];

  for (let pageGuard = 0; pageGuard < 8 && selected.length < target; pageGuard += 1) {
    const sourcePage = await fetchEventSourcePage(sourceType, source, page);
    sourceLabel = sourcePage.sourceLabel || sourceLabel;

    for (const raw of sourcePage.articles) {
      if (selected.length >= target) break;
      const article = normalizeEventArticle(raw);
      if (!article.key || !article.authorUrlname) continue;
      inspected += 1;

      if (article.authorUrlname === NOTE_OWNER) {
        skippedOwn += 1;
        continue;
      }

      let commented = false;
      try {
        commented = await ownerCommentedOnArticle(article.key, NOTE_OWNER);
      } catch {
        // Comment status is best-effort. If note temporarily rejects the check,
        // keep the article instead of silently losing a possible participant.
      }
      if (commented) {
        skippedCommented += 1;
        continue;
      }

      selected.push(await enrichEventArticle(article));
    }

    if (!sourcePage.nextPage) break;
    page = Number(sourcePage.nextPage) || page + 1;
  }

  return {
    sourceType,
    source: sourceLabel,
    requested: target,
    returned: selected.length,
    inspected,
    skippedCommented,
    skippedOwn,
    articles: selected,
  };
}

const TOOLS = [
  {
    name: "get_comment_reader_status",
    title: "王子 Comment Readerの状態",
    description:
      "王子（nero_notelover）のnoteをその場で最新確認し、確認記事数と未対応コメント件数を返します。GitHub Pagesの古い保存スナップショットは使いません。未対応とは、王子が返信しておらず、かつ王子がコメントにスキを付けていないものです。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_unanswered_comments",
    title: "王子の未対応コメント一覧",
    description:
      "王子の記事をnote APIでその場で再判定し、未対応コメントを新しい順に取得します。王子が返信済み、または王子がスキ済みのコメントは除外します。GitHub Pagesの古い保存データには依存しません。",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "取得件数。通常は5〜10件。",
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "0始まりの取得開始位置。",
        },
        query: {
          type: "string",
          description: "任意。コメント者名、note ID、記事タイトル、コメント本文の部分一致検索。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_unanswered_by_article",
    title: "記事ごとの未対応コメント",
    description:
      "王子の記事ごとに、未返信かつ王子未スキのコメントをまとめて取得します。基本は返信対象コメント5件以上になるまで次の記事も追加し、同じ記事のコメントは途中で分割しません。1つの記事を開いたまま、その記事に残っている未対応コメントを一括で返信したい場合はこちらを使ってください。",
    inputSchema: {
      type: "object",
      properties: {
        min_comments: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 5,
          description: "最低限取得したい返信対象コメント数。既定は5件。記事途中では切らないため、結果はこの件数を超えることがあります。",
        },
        max_articles: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 20,
          description: "安全上の最大記事数。通常は指定不要です。",
        },
        offset_articles: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "0始まりの記事取得開始位置。",
        },
        query: {
          type: "string",
          description: "任意。コメント者名、note ID、記事タイトル、コメント本文の部分一致検索。",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },

  {
    name: "list_event_source_page",
    title: "イベント検索元の記事ページを取得",
    description:
      "noteのハッシュタグまたはマガジンの記事一覧を1ページ分取得します。コメント済み判定は行いません。nextPageがある限りページを続け、最後まで走査するための起点です。",
    inputSchema: {
      type: "object",
      properties: {
        source_type: { type: "string", enum: ["hashtag", "magazine"] },
        source: { type: "string", minLength: 1 },
        page: { type: "integer", minimum: 1, default: 1 }
      },
      required: ["source_type", "source"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "check_event_article",
    title: "イベント記事の王子コメント済み判定",
    description:
      "イベント記事1件について、王子（nero_notelover）がすでにコメントしているか最新確認します。未コメントなら記事本文も取得します。判定失敗時は未コメント扱いにせずunknownを返します。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", minLength: 1 },
        title: { type: "string" },
        authorName: { type: "string" },
        authorUrlname: { type: "string", minLength: 1 },
        publishedAt: { type: ["string", "null"] },
        articleUrl: { type: "string" },
        preview: { type: "string" },
        likeCount: { type: "number" }
      },
      required: ["key", "authorUrlname"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },

  {
    name: "find_event_articles_by_hashtag",
    title: "イベント記事をハッシュタグから探す",
    description:
      "指定したnoteハッシュタグの新着記事から、王子本人の記事と王子がすでにコメント済みの記事を除外し、未コメント記事を取得します。記事本文も返すので、王子主催イベントの参加記事へのコメント案作成に使ってください。",
    inputSchema: {
      type: "object",
      properties: {
        hashtag: {
          type: "string",
          minLength: 1,
          description: "検索するハッシュタグ。#付きでも無しでも可。例: #秋読コレクション",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 5,
          description: "未コメント記事の取得件数。既定は5件。",
        },
      },
      required: ["hashtag"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "find_event_articles_by_magazine",
    title: "イベント記事をマガジンから探す",
    description:
      "指定したnoteマガジンから、王子本人の記事と王子がすでにコメント済みの記事を除外し、未コメント記事を取得します。マガジンURLまたはmから始まるキーを指定できます。記事本文も返すのでコメント案作成に使ってください。",
    inputSchema: {
      type: "object",
      properties: {
        magazine: {
          type: "string",
          minLength: 1,
          description: "noteマガジンURL、または m から始まるマガジンキー。",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 5,
          description: "未コメント記事の取得件数。既定は5件。",
        },
      },
      required: ["magazine"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },

  {
    name: "list_live_comment_check_articles",
    title: "最新コメント判定の候補記事一覧",
    description:
      "未返信コメントを最新状態で確認するために、再判定が必要な王子の記事一覧を返します。自動同期停止後はこちらを起点にし、check_live_unanswered_articleを記事ごとに呼んでください。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "check_live_unanswered_article",
    title: "記事1件の未対応スレッドを最新判定",
    description:
      "指定した王子の記事のコメントスレッドをnote APIから最新取得し、最後の王子返信より後に残る王子未スキのコメントだけを返します。長い会話は1スレッド1対応にまとめます。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", minLength: 1 },
        title: { type: "string" },
        article_url: { type: "string" },
        published_at: { type: "string" }
      },
      required: ["key"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },

  {
    name: "get_unanswered_comment",
    title: "未対応コメントを1件取得",
    description:
      "Comment ReaderのコメントIDを指定して、返信案作成に必要な記事名・本文・元スレッド文脈を1件取得します。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "list_unanswered_commentsが返したコメントID。" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

async function callTool(name, args, env) {
  let currentInboxPromise = null;
  const currentInbox = () => {
    if (!currentInboxPromise) currentInboxPromise = loadCurrentInbox(env);
    return currentInboxPromise;
  };

  if (name === "get_comment_reader_status") {
    const inbox = await currentInbox();
    const result = {
      owner: inbox.owner,
      updatedAt: inbox.updatedAt,
      articleCount: inbox.articleCount,
      unresolvedCount: inbox.unresolvedCount,
      failedArticles: inbox.failedArticles,
      source: inbox.source || "live",
      candidateArticles: Number(inbox.candidateArticles || 0),
      definition: "note APIで現在時点を再判定した、未返信かつ王子がスキしていないコメント",
    };
    return {
      content: [{ type: "text", text: "noteを最新確認した結果、未対応コメントは " + result.unresolvedCount + " 件です。" + (result.failedArticles ? " " + result.failedArticles + "記事は判定保留です。" : "") }],
      structuredContent: result,
    };
  }

  if (name === "list_unanswered_comments") {
    const inbox = await currentInbox();
    const limit = Math.min(50, Math.max(1, Number(args?.limit || 10)));
    const offset = Math.max(0, Number(args?.offset || 0));
    const query = String(args?.query || "").trim().toLowerCase();
    let items = inbox.items;

    if (query) {
      items = items.filter((item) =>
        [item?.authorName, item?.authorUrlname, item?.articleTitle, item?.body]
          .some((value) => String(value || "").toLowerCase().includes(query))
      );
    }

    const selected = items.slice(offset, offset + limit).map(publicComment);
    const result = {
      updatedAt: inbox.updatedAt,
      source: inbox.source || "live",
      failedArticles: Number(inbox.failedArticles || 0),
      total: items.length,
      offset,
      returned: selected.length,
      comments: selected,
    };

    return {
      content: [{
        type: "text",
        text:
          "noteを最新確認し、未対応コメントを " + selected.length + " 件取得しました。" + (Number(inbox.failedArticles || 0) ? " " + inbox.failedArticles + "記事は判定保留です。" : "") + " 必要に応じて各コメントへの王子らしい返信案を作成してください。",
      }],
      structuredContent: result,
    };
  }

  if (name === "list_unanswered_by_article") {
    const inbox = await currentInbox();
    const minComments = Math.min(50, Math.max(1, Number(args?.min_comments || 5)));
    const maxArticles = Math.min(20, Math.max(1, Number(args?.max_articles || 20)));
    const offsetArticles = Math.max(0, Number(args?.offset_articles || 0));
    const query = String(args?.query || "").trim().toLowerCase();
    let items = inbox.items;

    if (query) {
      items = items.filter((item) =>
        [item?.authorName, item?.authorUrlname, item?.articleTitle, item?.body]
          .some((value) => String(value || "").toLowerCase().includes(query))
      );
    }

    const groups = groupByArticle(items);
    const selected = [];
    let selectedComments = 0;
    for (const group of groups.slice(offsetArticles)) {
      if (selected.length >= maxArticles) break;
      selected.push(group);
      selectedComments += group.commentCount;
      if (selectedComments >= minComments) break;
    }

    const result = {
      updatedAt: inbox.updatedAt,
      totalArticles: groups.length,
      totalComments: items.length,
      offsetArticles,
      minComments,
      returnedArticles: selected.length,
      returnedComments: selectedComments,
      articles: selected,
    };

    return {
      content: [{
        type: "text",
        text:
          "未対応コメントを記事単位で " + selected.length + " 記事・合計 " + selectedComments + " 件取得しました。基本は5件以上になるまで次の記事を追加し、同じ記事の未対応コメントは途中で分割していません。記事を1回開くだけで順番に対応できるよう、記事ごとにまとめて返信案を作成してください。",
      }],
      structuredContent: result,
    };
  }


  if (name === "list_event_source_page") {
    const result = await getEventSourcePage(
      String(args?.source_type || ""),
      String(args?.source || ""),
      Number(args?.page || 1)
    );
    return {
      content: [{
        type: "text",
        text:
          result.source + " の記事を " + result.count + " 件取得しました。"
          + (result.nextPage ? " 次ページがあります。" : " これが最終ページです。")
          + " 各記事はcheck_event_articleでコメント済み判定してください。",
      }],
      structuredContent: result,
    };
  }

  if (name === "check_event_article") {
    const article = {
      key: String(args?.key || ""),
      title: String(args?.title || ""),
      authorName: String(args?.authorName || args?.authorUrlname || ""),
      authorUrlname: String(args?.authorUrlname || ""),
      publishedAt: args?.publishedAt || null,
      articleUrl: String(args?.articleUrl || ""),
      preview: String(args?.preview || ""),
      likeCount: Number(args?.likeCount || 0),
    };
    const result = await checkEventArticle(article);
    return {
      content: [{
        type: "text",
        text:
          result.status === "commented" ? "王子コメント済みです。"
          : result.status === "own" ? "王子自身の記事です。"
          : result.status === "uncommented" ? "王子未コメントです。記事本文も取得しました。"
          : "コメント済み判定に失敗したため判定保留です。",
      }],
      structuredContent: result,
    };
  }

  if (name === "find_event_articles_by_hashtag") {
    const result = await scanEventArticles("hashtag", args?.hashtag, args?.limit || 5, 1);
    return {
      content: [{
        type: "text",
        text:
          result.source + " から王子未コメントの記事を " + result.returned + " 件取得しました。各記事の本文を読んだうえで、企画主催者として内容に具体的に触れる王子らしいコメント案を作成してください。",
      }],
      structuredContent: result,
    };
  }

  if (name === "find_event_articles_by_magazine") {
    const result = await scanEventArticles("magazine", args?.magazine, args?.limit || 5, 1);
    return {
      content: [{
        type: "text",
        text:
          result.source + " から王子未コメントの記事を " + result.returned + " 件取得しました。各記事の本文を読んだうえで、企画主催者として内容に具体的に触れる王子らしいコメント案を作成してください。",
      }],
      structuredContent: result,
    };
  }

  if (name === "list_live_comment_check_articles") {
    const limit = Math.min(50, Math.max(1, Number(args?.limit || 20)));
    const offset = Math.max(0, Number(args?.offset || 0));
    const { articles, candidates } = await getLiveCandidateArticles();
    const selected = candidates.slice(offset, offset + limit);
    const result = {
      articleCount: articles.length,
      candidateCount: candidates.length,
      offset,
      returned: selected.length,
      nextOffset: offset + selected.length < candidates.length ? offset + selected.length : null,
      articles: selected,
    };
    return {
      content: [{
        type: "text",
        text: "最新判定が必要な記事を " + selected.length + " 件取得しました。check_live_unanswered_articleで記事ごとに確認してください。",
      }],
      structuredContent: result,
    };
  }

  if (name === "check_live_unanswered_article") {
    const key = String(args?.key || "");
    const article = {
      key,
      title: String(args?.title || key),
      url: String(args?.article_url || ("https://note.com/" + NOTE_OWNER + "/n/" + key)),
      publishedAt: String(args?.published_at || ""),
    };
    try {
      const unresolved = await scanLiveArticle(article);
      const items = unresolved.map(comment => publicLiveItem(article, comment));
      const result = {
        articleKey: key,
        articleTitle: article.title,
        articleUrl: article.url,
        unresolvedCount: items.length,
        items,
      };
      return {
        content: [{
          type: "text",
          text: items.length
            ? "この記事には最新判定で未対応スレッドが " + items.length + " 件あります。"
            : "この記事は最新判定で未対応なしです。",
        }],
        structuredContent: result,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: "この記事は判定保留です。古い未返信データは使用しません: " + String(error?.message || error) }],
      };
    }
  }

  if (name === "get_unanswered_comment") {
    const inbox = await currentInbox();
    const id = String(args?.id || "");
    const item = inbox.items.find((candidate) => String(candidate?.id || "") === id);
    if (!item) {
      return {
        isError: true,
        content: [{ type: "text", text: "指定された未対応コメントは見つかりませんでした。同期後に解消済みの可能性があります。" }],
      };
    }

    const result = publicComment(item);
    return {
      content: [{
        type: "text",
        text:
          "返信案作成用のコメントを取得しました。相手の内容に具体的に触れ、王子らしく明るく親しみやすく、必要なら🌙や🤭︎を自然に使い、そのままnoteへ貼れる返信案を作成してください。",
      }],
      structuredContent: result,
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: "Unknown tool: " + name }],
  };
}

async function handleMcp(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method === "GET") {
    return json({
      name: "Nero Comment Reader MCP",
      status: "ok",
      endpoint: "/mcp",
      transport: "Streamable HTTP (stateless JSON responses)",
    });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  let message;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const id = message?.id;
  const method = String(message?.method || "");

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: message?.params?.protocolVersion || MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "nero-comment-reader", version: "0.2.0" },
      instructions:
        "王子（nero_notelover）の未対応コメントを読み取る専用MCPです。返信済み、または王子がスキ済みのコメントは一覧から除外されています。ユーザーが未対応コメントの確認や返信案を求めた場合は、古い保存データではなく最新判定を優先してください。まずlist_live_comment_check_articlesで候補記事を取得し、check_live_unanswered_articleを記事ごとに順番に呼び、未対応スレッドが合計5件以上になるまで確認してください。判定失敗の記事は古いデータで補完せず判定保留として飛ばしてください。5件以上になった時点で止めますが、同じ記事の未対応スレッドはすべて含めてください。返信対象は最低5件を基本とし、5件未満なら次の記事を追加してください。5件以上になった時点で止めますが、同じ記事の未対応コメントは途中で切らず、その記事分をすべて含めてください。1つの記事に未対応コメントが1件でもある場合、その記事に残っている他の『未返信かつ王子未スキ』コメントもすべて同じ記事グループとして扱います。出力は記事ごとにまとめ、記事タイトルと記事URLは各記事につき1回だけ表示してください。その下にコメント者ごとの返信案を並べます。返信案本文は、ChatGPT上でコピーボタンが出るように必ず markdown の text コードブロック（\`\`\`text ... \`\`\`）の中だけに入れてください。コードブロック内には『返信案：』などのラベルや記事URLを入れず、そのままnoteへ貼り付けられる返信本文だけを書いてください。王子の返信は、相手の内容へ具体的に反応し、明るく親しみやすく、短めの段落で、🌙や🤭︎を自然に使います。感謝はふざけず丁寧にし、定型的なお礼だけで終わらせません。記事内のコメントは、取得結果の順番でまとめて回答してください。また、ユーザーが王子主催イベントへの参加記事を探す、ハッシュタグやマガジンからコメント対象を探す、または参加記事へのコメント案を求めた場合は、完全走査を優先してください。list_event_source_pageでpage=1から開始し、nextPageがある限り必ず次ページも取得して最後まで走査してください。取得した各記事はcheck_event_articleで王子コメント済みかを最新確認し、commentedとownは除外、unknownは判定保留、uncommentedだけをコメント案の対象にしてください。イベント記事では王子本人の記事と王子がすでにコメント済みの記事は除外されます。各記事について『記事タイトル』『記事URL』『投稿者』を表示し、その後に記事本文の具体的な内容へ触れた王子らしいコメント案を1つ作ってください。コメント案は返信案と同様に text コードブロックへ本文だけを入れて、コピーボタンが出る形にしてください。単なる『参加ありがとうございます』だけでは終わらせず、記事を読んだことが伝わる内容にしてください。MCP側ではAI生成を行いません。",
    });
  }

  if (method === "notifications/initialized") {
    return new Response(null, { status: 202, headers: CORS });
  }

  if ((id === undefined || id === null) && method.startsWith("notifications/")) {
    return new Response(null, { status: 202, headers: CORS });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = String(message?.params?.name || "");
    try {
      const result = await callTool(name, message?.params?.arguments || {}, env);
      return rpcResult(id, result);
    } catch (error) {
      return rpcResult(id, {
        isError: true,
        content: [{ type: "text", text: "Comment Readerの取得に失敗しました: " + String(error?.message || error) }],
      });
    }
  }

  return rpcError(id, -32601, "Method not found", { method });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      try {
        const inbox = await loadInbox(env);
        return json({
          ok: true,
          owner: inbox.owner,
          updatedAt: inbox.updatedAt,
          unresolvedCount: inbox.unresolvedCount,
        });
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 502);
      }
    }


    if (url.pathname === "/comments/live") {
      try {
        const offset = Number(url.searchParams.get("offset") || 0);
        const batch = Number(url.searchParams.get("batch") || 10);
        const incomingScanId = String(url.searchParams.get("scan_id") || "");
        const scanId = incomingScanId || crypto.randomUUID();
        const result = await buildLiveCommentBatch(offset, batch);
        let snapshotRecord = { ok: false, error: null };
        try {
          snapshotRecord = await recordLiveBatch(env, scanId, result, !incomingScanId || offset === 0);
        } catch (error) {
          snapshotRecord = { ok: false, error: String(error?.message || error) };
        }
        return json({
          ok: true,
          scanId,
          snapshotRecorded: Boolean(snapshotRecord?.ok),
          snapshotRecordError: snapshotRecord?.ok ? null : (snapshotRecord?.error || snapshotRecord?.detail?.error || null),
          snapshotRecordDetail: snapshotRecord?.ok ? null : (snapshotRecord?.detail || null),
          ...result
        });
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 500);
      }
    }

    if (url.pathname === "/event/source-page") {
      try {
        const sourceType = String(url.searchParams.get("type") || "");
        const source = String(url.searchParams.get("q") || "");
        const page = Math.max(1, Number(url.searchParams.get("page") || 1));
        const result = await getEventSourcePage(sourceType, source, page);
        return json({ ok: true, ...result });
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 400);
      }
    }

    if (url.pathname === "/event/check-article") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (request.method !== "POST") return json({ ok: false, error: "POST required" }, 405);
      try {
        const article = await request.json();
        const result = await checkEventArticle(article);
        return json({ ok: true, ...result });
      } catch (error) {
        return json({ ok: false, status: "unknown", error: String(error?.message || error) }, 400);
      }
    }

    if (url.pathname === "/event/search") {
      try {
        const sourceType = String(url.searchParams.get("type") || "");
        const source = String(url.searchParams.get("q") || "");
        const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") || 5)));
        const result = await scanEventArticles(sourceType, source, limit, 1);
        return json({ ok: true, ...result });
      } catch (error) {
        return json({ ok: false, error: String(error?.message || error) }, 400);
      }
    }

    if (url.pathname === "/mcp") return handleMcp(request, env);

    if (url.pathname === "/") {
      return new Response("Nero Comment Reader MCP 🌙\n/mcp\n/health\n", {
        status: 200,
        headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  },
};
