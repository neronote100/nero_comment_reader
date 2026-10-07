import fs from 'node:fs/promises';

const FILE = process.env.INPUT || 'data/autumn_collection_snapshot.json';
const OWNER = 'nero_notelover';
const NON_ENTRY_FIRST_AUTHORS = ['nero_notelover', 'orivie'];

const snapshot = JSON.parse(await fs.readFile(FILE, 'utf8'));
const allArticles = Array.isArray(snapshot.articles) ? snapshot.articles : [];

function publishedTime(article) {
  const n = Date.parse(article?.publishedAt || '');
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

const excluded = [];
const excludedKeys = new Set();
for (const authorUrlname of NON_ENTRY_FIRST_AUTHORS) {
  const first = allArticles
    .filter(a => String(a?.authorUrlname || '').toLowerCase() === authorUrlname)
    .sort((a, b) => publishedTime(a) - publishedTime(b))[0];
  if (!first) continue;
  excludedKeys.add(String(first.key));
  excluded.push({
    key: first.key,
    title: first.title,
    authorName: first.authorName,
    authorUrlname: first.authorUrlname,
    publishedAt: first.publishedAt,
    articleUrl: first.articleUrl,
    reason: '企画応募記事ではないため集計対象外（当該作者の最初の記事）',
  });
}

const articles = allArticles.filter(a => !excludedKeys.has(String(a?.key || '')));

const authorMap = new Map();
const commenterMap = new Map();
for (const a of articles) {
  const authorKey = a.authorUrlname || a.authorName || '(unknown)';
  const au = authorMap.get(authorKey) || {
    authorUrlname: a.authorUrlname,
    authorName: a.authorName,
    articleCount: 0,
    totalLikes: 0,
    totalComments: 0,
  };
  au.articleCount += 1;
  au.totalLikes += Number(a.likeCount || 0);
  au.totalComments += Number(a.commentCountFetched || 0);
  authorMap.set(authorKey, au);

  for (const c of Array.isArray(a.comments) ? a.comments : []) {
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
})).sort((a, b) =>
  b.commentCount - a.commentCount ||
  b.articleCount - a.articleCount ||
  String(a.authorName || '').localeCompare(String(b.authorName || ''), 'ja')
);

const totals = {
  articles: articles.length,
  uniqueAuthors: authorMap.size,
  likes: articles.reduce((s, a) => s + Number(a.likeCount || 0), 0),
  commentsReported: articles.reduce((s, a) => s + Number(a.commentCountReported || 0), 0),
  commentsFetched: articles.reduce((s, a) => s + Number(a.commentCountFetched || 0), 0),
  uniqueCommenters: commenterMap.size,
  uniqueExternalCommenters: commenters.filter(c => !c.isHost).length,
};

const filtered = {
  ...snapshot,
  version: Math.max(2, Number(snapshot.version || 1)),
  entryFilter: {
    rule: '王子（nero_notelover）とorivieさんの最初の記事を、企画応募記事ではないため母集団ごと除外',
    excludedCount: excluded.length,
    excluded,
  },
  totals,
  authors: [...authorMap.values()].sort((a, b) => b.articleCount - a.articleCount || b.totalLikes - a.totalLikes),
  commenters,
  articles,
};

await fs.writeFile(FILE, JSON.stringify(filtered, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ excluded, totals }));
