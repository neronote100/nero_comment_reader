// Choose the most recently verified read-only snapshot.
// On equal timestamps prefer the authenticated Worker over public static data.
const order={worker:0,static:1,cache:2};
export function validCommentSnapshot(value){
  return Boolean(value && value.owner==='nero_notelover' &&
    Array.isArray(value.items) && value.items.length<=100000 &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    Number.isInteger(Number(value.articleCount)) && Number(value.articleCount)>=0 &&
    Number.isInteger(Number(value.failedArticles??0)) && Number(value.failedArticles??0)>=0);
}

export function chooseCommentSnapshot(candidates){
  const valid=candidates.filter(x=>order[x.source]!=null&&validCommentSnapshot(x.snapshot));
  valid.sort((a,b)=>
    Date.parse(b.snapshot.updatedAt)-Date.parse(a.snapshot.updatedAt) ||
    order[a.source]-order[b.source]);
  return valid[0]??null;
}

export function snapshotFreshness(picked,now=Date.now()){
  if(!picked)return {kind:'missing',message:'表示できる保存データがありません。'};
  const ageDays=Math.max(0,Math.floor((now-Date.parse(picked.snapshot.updatedAt))/86400000));
  const source=picked.source==='static'?'GitHub公開バックアップ':
    picked.source==='worker'?'Comment Readerライブ保存':'端末保存';
  const warnings=[];
  if(ageDays>=2)warnings.push('最終更新から'+ageDays+'日経過');
  if(picked.source!=='worker')warnings.push('未対応は候補値。必要に応じて手動で最新確認');
  const failed=Number(picked.snapshot.failedArticles??0);
  if(failed)warnings.push(failed+'記事が判定保留');
  return {kind:ageDays>=2?'stale':'fresh',source,ageDays,
    message:source+'（'+picked.snapshot.updatedAt+'）'+(warnings.length?'：'+warnings.join('／'):'')};
}
