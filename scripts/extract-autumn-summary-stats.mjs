import fs from 'node:fs/promises';

const INPUT = 'data/autumn_collection_snapshot.json';
const CATEGORY_INPUT = 'data/autumn_collection_categories_2026-10-07.json';
const OUTPUT = 'data/autumn_collection_summary_stats.json';

const d = JSON.parse(await fs.readFile(INPUT, 'utf8'));
const categoryData = JSON.parse(await fs.readFile(CATEGORY_INPUT, 'utf8'));
const categoryMap = new Map(Array.isArray(categoryData.articles) ? categoryData.articles : []);
const articles = Array.isArray(d.articles) ? d.articles : [];
const commenters = Array.isArray(d.commenters) ? d.commenters : [];

const byCategory = {};
for (const a of articles) {
  const category = categoryMap.get(a.key) || '未分類';
  const row = byCategory[category] || { articles: 0, likes: 0, comments: 0 };
  row.articles += 1;
  row.likes += Number(a.likeCount || 0);
  row.comments += Number(a.commentCountFetched || 0);
  byCategory[category] = row;
}

const external = commenters.filter(c => !c.isHost);
const buckets = {
  '100+': 0,
  '50-99': 0,
  '30-49': 0,
  '20-29': 0,
  '10-19': 0,
  '5-9': 0,
  '2-4': 0,
  '1': 0,
};
for (const c of external) {
  const n = Number(c.commentCount || 0);
  if (n >= 100) buckets['100+']++;
  else if (n >= 50) buckets['50-99']++;
  else if (n >= 30) buckets['30-49']++;
  else if (n >= 20) buckets['20-29']++;
  else if (n >= 10) buckets['10-19']++;
  else if (n >= 5) buckets['5-9']++;
  else if (n >= 2) buckets['2-4']++;
  else if (n === 1) buckets['1']++;
}

const out = {
  generatedAt: d.generatedAt,
  entryFilter: d.entryFilter,
  totals: d.totals,
  topExternalCommenters: external.slice(0, 30),
  commentBuckets: buckets,
  categories: byCategory
};

await fs.writeFile(OUTPUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(out));
