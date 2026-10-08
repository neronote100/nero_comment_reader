import fs from 'node:fs/promises';

const SNAPSHOT = process.env.INPUT || 'data/autumn_collection_snapshot.json';
const CATEGORIES = process.env.CATEGORIES || 'data/autumn_collection_categories_2026-10-07.json';
const OUTPUT = process.env.OUTPUT || 'data/autumn_collection_nero_comments.json';
const OWNER = 'nero_notelover';

const snapshot = JSON.parse(await fs.readFile(SNAPSHOT, 'utf8'));
const categoryData = JSON.parse(await fs.readFile(CATEGORIES, 'utf8'));
const categoryMap = new Map(Array.isArray(categoryData.articles) ? categoryData.articles : []);

const articles = (Array.isArray(snapshot.articles) ? snapshot.articles : []).map(a => {
  const comments = (Array.isArray(a.comments) ? a.comments : [])
    .filter(c => String(c?.authorUrlname || '').toLowerCase() === OWNER)
    .map(c => ({
      body: String(c?.body || '').trim(),
      publishedAt: c?.publishedAt || null,
      isRoot: c?.isRoot !== false,
      parentKey: c?.parentKey || ''
    }))
    .filter(c => c.body);
  return {
    key: a.key,
    category: categoryMap.get(a.key) || '未分類',
    authorName: a.authorName,
    authorUrlname: a.authorUrlname,
    title: a.title,
    articleUrl: a.articleUrl,
    publishedAt: a.publishedAt,
    neroComments: comments
  };
});

const out = {
  generatedAt: snapshot.generatedAt,
  magazineKey: snapshot.magazineKey,
  magazineName: snapshot.magazineName,
  entryFilter: snapshot.entryFilter || null,
  articleCount: articles.length,
  articlesWithNeroComment: articles.filter(a => a.neroComments.length > 0).length,
  articlesWithoutNeroComment: articles.filter(a => a.neroComments.length === 0).map(a => ({
    key:a.key, authorName:a.authorName, title:a.title, articleUrl:a.articleUrl
  })),
  articles
};

await fs.writeFile(OUTPUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({
  articleCount: out.articleCount,
  articlesWithNeroComment: out.articlesWithNeroComment,
  articlesWithoutNeroComment: out.articlesWithoutNeroComment.length
}));
