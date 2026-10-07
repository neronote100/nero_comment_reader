const MAGAZINE_KEY = process.env.MAGAZINE_KEY || 'mbdfa1301e316';
const OWNER = 'nero_notelover';
const BASE = 'https://note.com';
const OUTPUT = process.env.OUTPUT || 'data/autumn_collection_snapshot.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function noteJson(path, attempt = 0) {
  const res = await fetch(BASE + path, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'NeroCommentReader/0.5 (+https://neronote100.github.io/nero_comment_reader/)'
    }
  });
  if (res.ok) return res.json();
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(800 * (attempt + 1));
    return noteJson(path, attempt + 1);
  }
  throw new Error(`note API HTTP ${res.status}: ${path}`);
}

function textFromAny(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    return value
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (Array.isArray(value)) return value.map(textFromAny).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.value === 'string') return value.value;
    if (typeof value.text === 'string') return value.text;
    if (value.children) return textFromAny(value.children);
    return Object.values(value).map(textFromAny).filter(Boolean).join('\n');
  }
  return '';
}

function commentText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(commentText).filter(Boolean).join('');
  if (typeof node !== 'object') return '';
  if (node.type === 'text') return String(node.value ?? node.text ?? '');
  const children = Array.isArray(node.children) ? node.children : [];
  const inner = children.map(commentText).join('');
  const tag = String(node.tag_name || node.tagName || '').toLowerCase();
  return ['p','div','blockquote','li'].includes(tag) ? inner + '\n' : inner;
}

function normalizeComment(raw) {
  const user = raw?.user || raw?.author || {};
  return {
    key: String(raw?.key || raw?.comment_key || ''),
    parentKey: String(raw?.parent_key || raw?.parentKey || ''),
    authorUrlname: String(user?.urlname || raw?.urlname || '').toLowerCase(),
    authorName: String(user?.nickname || user?.name || raw?.nickname || ''),
    body: String(commentText(raw?.comment ?? raw?.body ?? raw?.content ?? '')).replace(/\r/g, '').trim(),
    publishedAt: String(raw?.published_at || raw?.publish_at || raw?.created_at || raw?.createdAt || ''),
    isRoot: raw?.is_root !== false,
    replyCount: Number(raw?.reply_count || raw?.replyCount || 0),
  };
}

function commentRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.comments)) return payload.data.comments;
  if (Array.isArray(payload?.comments)) return payload.comments;
  return [];
}

function nextPage(payload) {
  return payload?.next_page ?? payload?.nextPage ?? payload?.data?.next_page ?? payload?.data?.nextPage ?? null;
}

async function fetchComments(noteKey, parentKey = '') {
  const all = [];
  let page = 1;
  for (let guard = 0; guard < 30; guard += 1) {
    const params = new URLSearchParams({ order: 'oldest', per_page: '100', page: String(page) });
    if (parentKey) params.set('parent_key', parentKey);
    const payload = await noteJson(`/api/v3/notes/${encodeURIComponent(noteKey)}/note_comments?${params}`);
    const rows = commentRows(payload);
    all.push(...rows.map(normalizeComment));
    const next = nextPage(payload);
    if (!next || rows.length === 0) break;
    const n = Number(next);
    page = Number.isFinite(n) && n > page ? n : page + 1;
    await sleep(80);
  }
  return all;
}

async function fetchAllThreadComments(noteKey) {
  const roots = (await fetchComments(noteKey)).filter(c => c.isRoot !== false);
  const all = [...roots];
  for (const root of roots) {
    if (root.replyCount <= 0 || !root.key) continue;
    const replies = (await fetchComments(noteKey, root.key)).filter(c => c.isRoot === false);
    all.push(...replies);
    await sleep(80);
  }
  const seen = new Set();
  return all.filter(c => {
    const id = c.key || `${c.parentKey}:${c.authorUrlname}:${c.publishedAt}:${c.body}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function fetchMagazineArticles() {
  const byKey = new Map();
  let page = 1;
  let magazineName = MAGAZINE_KEY;
  for (let guard = 0; guard < 100; guard += 1) {
    const payload = await noteJson(`/api/v1/magazines/${MAGAZINE_KEY}/notes?page=${page}`);
    const data = payload?.data || {};
    magazineName = String(data.name || magazineName);
    const rows = Array.isArray(data.notes) ? data.notes : [];
    for (const raw of rows) {
      const user = raw?.user || {};
      const key = String(raw?.key || '');
      if (!key) continue;
      const authorUrlname = String(user?.urlname || '');
      byKey.set(key, {
        key,
        title: String(raw?.name || raw?.title || ''),
        authorName: String(user?.nickname || user?.name || authorUrlname),
        authorUrlname,
        publishedAt: raw?.publish_at || raw?.published_at || raw?.created_at || null,
        articleUrl: key && authorUrlname ? `https://note.com/${authorUrlname}/n/${key}` : '',
        likeCount: Number(raw?.like_count ?? raw?.likeCount ?? 0),
        commentCountReported: Number(raw?.comment_count ?? raw?.commentCount ?? 0),
        preview: textFromAny(raw?.body || raw?.description || '').slice(0, 1200)
      });
    }
    const next = data.next_page ?? payload?.next_page ?? null;
    if (!next || rows.length === 0) break;
    page = Number(next) || page + 1;
    await sleep(120);
  }
  return { magazineName, articles: [...byKey.values()] };
}

async function enrichArticle(article) {
  let body = article.preview;
  let tags = [];
  let detailLikeCount = article.likeCount;
  let detailCommentCount = article.commentCountReported;
  try {
    const payload = await noteJson(`/api/v3/notes/${encodeURIComponent(article.key)}`);
    const data = payload?.data || {};
    body = textFromAny(data?.body || data?.note?.body || data?.note_draft?.body || body).slice(0, 8000);
    const rawTags = data?.tags || data?.note?.tags || [];
    tags = Array.isArray(rawTags) ? rawTags.map(t => String(t?.name || t)).filter(Boolean) : [];
    detailLikeCount = Number(data?.like_count ?? data?.likeCount ?? data?.note?.like_count ?? detailLikeCount);
    detailCommentCount = Number(data?.comment_count ?? data?.commentCount ?? data?.note?.comment_count ?? detailCommentCount);
  } catch (e) {
    console.warn(`detail failed ${article.key}: ${e.message}`);
  }

  let comments = [];
  try {
    comments = await fetchAllThreadComments(article.key);
  } catch (e) {
    console.warn(`comments failed ${article.key}: ${e.message}`);
  }

  return {
    ...article,
    likeCount: detailLikeCount,
    commentCountReported: detailCommentCount,
    commentCountFetched: comments.length,
    tags,
    body,
    comments,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      out[idx] = await fn(items[idx], idx);
      await sleep(100);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const { magazineName, articles } = await fetchMagazineArticles();
console.log(`Magazine: ${magazineName}; articles: ${articles.length}`);
const enriched = await mapLimit(articles, 3, enrichArticle);

const commenterMap = new Map();
const authorMap = new Map();
for (const a of enriched) {
  const authorKey = a.authorUrlname || a.authorName || '(unknown)';
  const au = authorMap.get(authorKey) || { authorUrlname: a.authorUrlname, authorName: a.authorName, articleCount: 0, totalLikes: 0, totalComments: 0 };
  au.articleCount += 1;
  au.totalLikes += Number(a.likeCount || 0);
  au.totalComments += Number(a.commentCountFetched || 0);
  authorMap.set(authorKey, au);

  for (const c of a.comments) {
    const key = c.authorUrlname || c.authorName || '(unknown)';
    const row = commenterMap.get(key) || {
      authorUrlname: c.authorUrlname,
      authorName: c.authorName,
      commentCount: 0,
      rootCommentCount: 0,
      replyCount: 0,
      articlesCommented: new Set(),
    };
    row.commentCount += 1;
    if (c.isRoot !== false) row.rootCommentCount += 1;
    else row.replyCount += 1;
    row.articlesCommented.add(a.key);
    commenterMap.set(key, row);
  }
}

const commenters = [...commenterMap.values()].map(r => ({
  authorUrlname: r.authorUrlname,
  authorName: r.authorName,
  commentCount: r.commentCount,
  rootCommentCount: r.rootCommentCount,
  replyCount: r.replyCount,
  articleCount: r.articlesCommented.size,
  isHost: r.authorUrlname === OWNER,
})).sort((a,b) => b.commentCount - a.commentCount || b.articleCount - a.articleCount || a.authorName.localeCompare(b.authorName,'ja'));

const snapshot = {
  version: 1,
  generatedAt: new Date().toISOString(),
  magazineKey: MAGAZINE_KEY,
  magazineName,
  owner: OWNER,
  totals: {
    articles: enriched.length,
    uniqueAuthors: authorMap.size,
    likes: enriched.reduce((s,a)=>s+Number(a.likeCount||0),0),
    commentsReported: enriched.reduce((s,a)=>s+Number(a.commentCountReported||0),0),
    commentsFetched: enriched.reduce((s,a)=>s+Number(a.commentCountFetched||0),0),
    uniqueCommenters: commenterMap.size,
    uniqueExternalCommenters: commenters.filter(c=>!c.isHost).length,
  },
  authors: [...authorMap.values()].sort((a,b)=>b.articleCount-a.articleCount || b.totalLikes-a.totalLikes),
  commenters,
  articles: enriched.map(a => ({
    key: a.key,
    title: a.title,
    authorName: a.authorName,
    authorUrlname: a.authorUrlname,
    publishedAt: a.publishedAt,
    articleUrl: a.articleUrl,
    likeCount: a.likeCount,
    commentCountReported: a.commentCountReported,
    commentCountFetched: a.commentCountFetched,
    tags: a.tags,
    preview: a.preview,
    body: a.body,
    comments: a.comments,
  }))
};

const fs = await import('node:fs/promises');
await fs.mkdir('data', { recursive: true });
await fs.writeFile(OUTPUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(snapshot.totals));
