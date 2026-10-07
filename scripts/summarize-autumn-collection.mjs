import fs from 'node:fs/promises';

const inputPath = process.env.INPUT || 'data/autumn_collection_snapshot.json';
const summaryPath = process.env.SUMMARY || 'data/autumn_collection_summary.json';
const articlePath = process.env.ARTICLES || 'data/autumn_collection_articles.json';
const baselinePath = process.env.BASELINE || 'data/autumn_collection_baseline_2026-10-07.json';

const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const externalCommenters = (raw.commenters || []).filter(c => !c.isHost);

const compactArticles = (raw.articles || []).map(a => ({
  key: a.key,
  title: a.title,
  authorName: a.authorName,
  authorUrlname: a.authorUrlname,
  publishedAt: a.publishedAt,
  articleUrl: a.articleUrl,
  likeCount: Number(a.likeCount || 0),
  commentCount: Number(a.commentCountFetched || a.commentCountReported || 0),
  tags: Array.isArray(a.tags) ? a.tags : [],
  bodySnippet: String(a.body || a.preview || '').slice(0, 1800),
}));

const summary = {
  generatedAt: raw.generatedAt,
  magazineKey: raw.magazineKey,
  magazineName: raw.magazineName,
  owner: raw.owner,
  totals: raw.totals,
  externalCommenters,
  topCommenters: externalCommenters.slice(0, 50),
  authors: raw.authors || [],
  topLikedArticles: [...compactArticles].sort((a,b)=>b.likeCount-a.likeCount).slice(0,30),
  topCommentedArticles: [...compactArticles].sort((a,b)=>b.commentCount-a.commentCount).slice(0,30),
};

const baseline = {
  generatedAt: raw.generatedAt,
  magazineKey: raw.magazineKey,
  magazineName: raw.magazineName,
  totals: raw.totals,
  externalCommenters,
  articles: compactArticles.map(({bodySnippet, ...a}) => a),
};

await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
await fs.writeFile(articlePath, JSON.stringify({ generatedAt: raw.generatedAt, articles: compactArticles }, null, 2) + '\n', 'utf8');
try {
  await fs.access(baselinePath);
} catch {
  await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
}

console.log(`summary commenters=${externalCommenters.length} articles=${compactArticles.length}`);
