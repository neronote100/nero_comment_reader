import fs from 'node:fs/promises';

const inputPath = process.env.INPUT || 'data/autumn_collection_snapshot.json';
const summaryPath = process.env.SUMMARY || 'data/autumn_collection_summary.json';
const articlePath = process.env.ARTICLES || 'data/autumn_collection_articles.json';
const tsvPath = process.env.ARTICLES_TSV || 'data/autumn_collection_articles_compact.tsv';
const statsPath = process.env.COMMENT_STATS || 'data/autumn_collection_comment_stats.json';
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

const exactCounts = {};
for (const c of externalCommenters) exactCounts[c.commentCount] = (exactCounts[c.commentCount] || 0) + 1;
const buckets = {
  '100+': externalCommenters.filter(c=>c.commentCount>=100).length,
  '50-99': externalCommenters.filter(c=>c.commentCount>=50 && c.commentCount<100).length,
  '30-49': externalCommenters.filter(c=>c.commentCount>=30 && c.commentCount<50).length,
  '20-29': externalCommenters.filter(c=>c.commentCount>=20 && c.commentCount<30).length,
  '10-19': externalCommenters.filter(c=>c.commentCount>=10 && c.commentCount<20).length,
  '5-9': externalCommenters.filter(c=>c.commentCount>=5 && c.commentCount<10).length,
  '2-4': externalCommenters.filter(c=>c.commentCount>=2 && c.commentCount<5).length,
  '1': externalCommenters.filter(c=>c.commentCount===1).length,
};

const esc = v => String(v ?? '').replace(/[\t\r\n]+/g,' ').replace(/\s{2,}/g,' ').trim();
const tsv = [
  ['key','title','authorName','authorUrlname','likeCount','commentCount','articleUrl','bodySnippet'].join('\t'),
  ...compactArticles.map(a => [a.key,a.title,a.authorName,a.authorUrlname,a.likeCount,a.commentCount,a.articleUrl,String(a.bodySnippet||'').slice(0,500)].map(esc).join('\t'))
].join('\n') + '\n';

await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
await fs.writeFile(articlePath, JSON.stringify({ generatedAt: raw.generatedAt, articles: compactArticles }, null, 2) + '\n', 'utf8');
await fs.writeFile(tsvPath, tsv, 'utf8');
await fs.writeFile(statsPath, JSON.stringify({ generatedAt: raw.generatedAt, totalExternalCommenters: externalCommenters.length, buckets, exactCounts }, null, 2) + '\n', 'utf8');
try {
  await fs.access(baselinePath);
} catch {
  await fs.writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
}

console.log(`summary commenters=${externalCommenters.length} articles=${compactArticles.length}`);
