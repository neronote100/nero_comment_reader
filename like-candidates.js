const OWNER='nero_notelover';
export const CANDIDATE_FEED_URL='https://raw.githubusercontent.com/neronote100/Prince_like_giver/manual-candidates/data/like-candidates.json';
export const CANDIDATE_WORKFLOW_URL='https://github.com/neronote100/Prince_like_giver/actions/workflows/candidates.yml';
const CACHE_KEY='nero-manual-like-candidates-v1';
const CHECKED_KEY='nero-manual-like-checked-v1';
const DAY=86400000;
const REASONS={
  source_exhausted:'今回調べられた範囲で、条件に合う候補を表示しています。',
  profile_limit:'今回の調査人数の上限まで確認した結果です。',
  request_limit:'今回の取得回数の上限まで確認した結果です。',
  time_limit:'今回の調査時間内に見つかった候補です。',
  note_access_paused:'noteからの取得が途中で停止したため、確認できた候補だけを表示しています。',
  not_yet_generated:'最初の候補抽出を待っています。',
};

// Treat the public feed as untrusted. Links must point to the named person's
// exact note profile/article; values are rendered with textContent only.
export function normalizeLikeCandidatesFeed(value,now=Date.now()){
  const generatedAt=Date.parse(value?.generatedAt);
  if(value?.owner!==OWNER||!Number.isFinite(generatedAt)||generatedAt>now+300000||
      !Array.isArray(value.candidates)||value.candidates.length>30||value.targetCount!==30||
      typeof value.complete!=='boolean')throw new Error('INVALID_CANDIDATE_FEED');
  const seenUsers=new Set(),seenArticles=new Set();
  const candidates=[];
  let rejected=0;
  for(const row of value.candidates){
    const user=row?.user;
    const following=row?.following,followers=row?.followers;
    const publishedAt=Date.parse(row?.publishedAt);
    let valid=typeof user==='string'&&/^[a-z0-9_-]{1,64}$/.test(user)&&user!==OWNER&&
      Number.isSafeInteger(following)&&Number.isSafeInteger(followers)&&followers>=0&&
      following-followers>=10&&following*100>=followers*115&&row.gap===following-followers&&
      row.liked===false&&Number.isFinite(publishedAt)&&publishedAt<=generatedAt&&generatedAt-publishedAt<=30*DAY;
    let article;
    try{
      const profile=new URL(row.profileUrl);
      article=new URL(row.articleUrl);
      valid=valid&&profile.href==='https://note.com/'+user&&
        article.href==='https://note.com/'+user+'/n/'+article.pathname.split('/').at(-1)&&
        /^n[a-f0-9]{8,32}$/.test(article.pathname.split('/').at(-1));
    }catch{valid=false;}
    if(!valid||seenUsers.has(user)||seenArticles.has(article?.href)){rejected++;continue;}
    seenUsers.add(user);seenArticles.add(article.href);
    candidates.push({user,name:String(row.name||user).slice(0,80),profileUrl:row.profileUrl,
      following,followers,gap:row.gap,articleTitle:String(row.articleTitle||'記事を開く').slice(0,150),
      publishedAt:new Date(publishedAt).toISOString(),articleUrl:article.href,liked:false});
  }
  if(value.candidates.length&&!candidates.length)throw new Error('INVALID_CANDIDATE_FEED');
  return {version:1,owner:OWNER,generatedAt:new Date(generatedAt).toISOString(),targetCount:30,
    complete:value.complete&&candidates.length===30&&rejected===0,reason:String(value.reason||''),
    scanned:Number.isSafeInteger(value.summary?.scanned)?value.summary.scanned:0,
    candidates,rejected};
}

export async function fetchLikeCandidatesFeed({fetcher=globalThis.fetch,localUrl,now=Date.now()}={}){
  for(const url of [CANDIDATE_FEED_URL,localUrl].filter(Boolean)){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetcher(url,{method:'GET',cache:'no-store',credentials:'omit',signal:controller.signal});
      if(!response.ok)continue;
      const body=await response.text();
      if(body.length>300000)continue;
      return normalizeLikeCandidatesFeed(JSON.parse(body),now);
    }catch{/* A failed refresh must leave the displayed snapshot intact. */}
    finally{clearTimeout(timer);}
  }
  throw new Error('CANDIDATE_FEED_UNAVAILABLE');
}

function readStorage(storage,key){try{return JSON.parse(storage?.getItem(key)||'null');}catch{return null;}}
function saveStorage(storage,key,value){try{storage?.setItem(key,JSON.stringify(value));}catch{/* Viewing still works without storage. */}}
function element(tag,className,text){
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}
function link(text,url,className){
  const node=element('a',className,text);
  node.href=url;node.target='_blank';node.rel='noopener noreferrer';
  return node;
}
function dateText(value){
  return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
}

export function mountLikeCandidates(host){
  let storage;
  try{storage=window.localStorage;}catch{/* Private browsing can deny storage. */}
  let feed=null,loading=false;
  const saved=readStorage(storage,CHECKED_KEY);
  const checked=new Set(Array.isArray(saved)?saved.filter(v=>typeof v==='string').slice(-2000):[]);
  host.replaceChildren();
  const controls=element('div','candidateControls');
  const refresh=element('button','primaryAction','↻ 最新候補を表示');
  refresh.type='button';
  const extract=link('候補を新しく抽出 ↗',CANDIDATE_WORKFLOW_URL,'secondary');
  controls.append(refresh,extract);
  const instructions=element('p','candidateHint','「候補を新しく抽出」でGitHubを開き、Run workflowを押してください。完了後「最新候補を表示」で一覧を更新できます。');
  const summary=element('section','candidateSummary');
  const count=element('strong','candidateCount','—');
  const meta=element('div','candidateMeta');
  summary.append(count,meta);
  const filter=element('label','candidateFilter');
  const onlyUnchecked=element('input');onlyUnchecked.type='checkbox';
  filter.append(onlyUnchecked,document.createTextNode('未確認の候補だけ表示'));
  const copy=element('button','secondary','未確認の記事URLをまとめてコピー');copy.type='button';copy.disabled=true;
  const localNote=element('p','candidateHint','確認済みは、このブラウザで付ける手動の記録です。noteのスキ状態とは同期しません。');
  const status=element('p','status candidateStatus','候補一覧を読み込んでいます…');
  status.setAttribute('role','status');
  const list=element('section','candidateList');
  const actions=element('div','candidateTools');actions.append(filter,copy);
  host.append(controls,instructions,summary,actions,localNote,status,list);

  function updateCount(){
    if(!feed)return;
    const remaining=feed.candidates.filter(row=>!checked.has(row.articleUrl)).length;
    count.textContent=feed.candidates.length+'人';
    meta.replaceChildren(element('div',null,'未確認 '+remaining+'人 / 確認済み '+(feed.candidates.length-remaining)+'人'),
      element('div',null,'抽出 '+dateText(feed.generatedAt)+'（日本時間）'+(feed.scanned?' / '+feed.scanned+'人を調査':'')));
    copy.disabled=loading||remaining===0;
  }
  function describeFeed(){
    const notices=[];
    if(Date.now()-Date.parse(feed.generatedAt)>DAY)notices.push('抽出から24時間以上経っています。記事を開いて現在の状態を確認してください。');
    if(!feed.complete)notices.push(REASONS[feed.reason]||'今回は30人未満の候補です。条件を満たした人だけを表示しています。');
    if(feed.rejected)notices.push('確認できない情報が含まれる候補を除外しました。');
    if(!notices.length)notices.push('30人の候補を表示しています。気になる記事を開いてみてください。');
    status.textContent=notices.join(' ');
  }
  function render(){
    list.replaceChildren();updateCount();
    const visible=feed.candidates.filter(row=>!onlyUnchecked.checked||!checked.has(row.articleUrl));
    if(!visible.length){
      list.append(element('div','empty',feed.candidates.length?'表示中の候補はすべて確認済みです。':
        feed.reason==='not_yet_generated'?'最初の候補抽出を待っています。':'今回の調査では、条件に合う候補が見つかりませんでした。'));
      return;
    }
    for(const row of visible){
      const card=element('article','commentCard candidateCard'+(checked.has(row.articleUrl)?' candidateChecked':''));
      const header=element('div','commentHead');
      const person=link(row.name,row.profileUrl,'candidatePerson');
      const badge=element('span','badge','差 '+row.gap+'人');
      header.append(person,badge);
      const numbers=element('p','candidateNumbers','@'+row.user+' · フォロー '+row.following+' / フォロワー '+row.followers);
      const title=link(row.articleTitle,row.articleUrl,'articleTitle');
      const date=element('p','date',dateText(row.publishedAt)+' 公開');
      const links=element('div','actions candidateActions');
      const open=link('noteで記事を読む ↗',row.articleUrl,'primary');
      const mark=element('label','candidateMark');
      const box=element('input');box.type='checkbox';box.checked=checked.has(row.articleUrl);
      box.setAttribute('aria-label',row.name+'の記事を確認済みにする');
      mark.append(box,document.createTextNode('確認済み'));
      box.addEventListener('change',()=>{
        if(box.checked)checked.add(row.articleUrl);else checked.delete(row.articleUrl);
        saveStorage(storage,CHECKED_KEY,[...checked].slice(-2000));
        card.classList.toggle('candidateChecked',box.checked);
        if(onlyUnchecked.checked&&box.checked)render();else updateCount();
      });
      links.append(open,mark);card.append(header,numbers,title,date,links);list.append(card);
    }
  }
  async function refreshFeed(){
    if(loading)return;
    loading=true;refresh.disabled=true;refresh.textContent='↻ 読み込み中…';copy.disabled=true;
    status.textContent='最新の候補一覧を確認しています…';
    try{
      const latest=await fetchLikeCandidatesFeed({localUrl:new URL('./data/like-candidates.json',location.href).href});
      if(!feed||Date.parse(latest.generatedAt)>=Date.parse(feed.generatedAt)){
        feed=latest;
        // Keep the source-shaped summary so cached feeds validate exactly like remote feeds.
        saveStorage(storage,CACHE_KEY,{...feed,summary:{scanned:feed.scanned}});
      }
      render();describeFeed();
      if(Date.parse(latest.generatedAt)<Date.parse(feed.generatedAt))status.textContent+=' 表示中の新しい候補一覧を保持しました。';
    }catch{
      status.textContent=feed?'最新の一覧を取得できませんでした。前回の候補を表示しています。少し待ってから再度お試しください。':'候補一覧を取得できませんでした。「候補を新しく抽出」から抽出を実行し、完了後にもう一度表示してください。';
    }finally{
      loading=false;refresh.disabled=false;refresh.textContent='↻ 最新候補を表示';updateCount();
    }
  }
  onlyUnchecked.addEventListener('change',()=>{if(feed)render();});
  refresh.addEventListener('click',refreshFeed);
  copy.addEventListener('click',async()=>{
    try{
      await navigator.clipboard.writeText(feed.candidates.filter(row=>!checked.has(row.articleUrl)).map(row=>row.articleUrl).join('\n'));
      status.textContent='未確認の記事URLをコピーしました。';
    }catch{status.textContent='コピーできませんでした。各記事のリンクから開いてください。';}
  });
  try{
    feed=normalizeLikeCandidatesFeed(readStorage(storage,CACHE_KEY));
    render();describeFeed();
  }catch{/* First visit or invalid cache. */}
  void refreshFeed();
}
