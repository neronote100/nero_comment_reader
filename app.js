'use strict';

const state={
  items:[],
  filtered:[],
  eventArticles:[],
  eventSourceType:null,
  eventSource:null,
};

const $=s=>document.querySelector(s);
const commentsEl=$('#comments');
const statusEl=$('#status');
const toastEl=$('#toast');
const eventResultsEl=$('#eventResults');
const eventStatusEl=$('#eventStatus');

const WORKER='https://nero-comment-reader.nero-prince.workers.dev';

function dateText(v){
  if(!v)return '日時不明';
  const d=new Date(v);
  if(Number.isNaN(d.getTime()))return String(v);
  return new Intl.DateTimeFormat('ja-JP',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
}

function showToast(message){
  toastEl.textContent=message;
  toastEl.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer=setTimeout(()=>toastEl.classList.remove('show'),1800);
}

function promptFor(item){
  return [
    '王子（nero_notelover）への未返信コメントです。',
    '王子らしい返信案を1案作ってください。',
    '',
    '【記事】'+String(item.articleTitle||''),
    '【記事URL】'+String(item.articleUrl||''),
    '【コメント者】'+String(item.authorName||item.authorUrlname||''),
    '【コメント】',
    String(item.body||''),
    '',
    '条件：',
    '- 相手のコメント内容にちゃんと触れる',
    '- 明るく親しみやすい王子の口調',
    '- 🌙や🤭︎は自然な範囲で使う',
    '- 感謝する場面は丁寧にする',
    '- そのままnoteに貼れる返信本文だけを出す'
  ].join('\n');
}

function eventPromptFor(article){
  return [
    '王子（nero_notelover）が開催しているイベントの参加記事です。',
    '記事を読んだことが伝わる、王子らしいコメント案を1案作ってください。',
    '',
    '【検索元】'+String(state.eventSource||''),
    '【記事タイトル】'+String(article.title||''),
    '【記事URL】'+String(article.articleUrl||''),
    '【投稿者】'+String(article.authorName||article.authorUrlname||''),
    '【記事本文】',
    String(article.body||article.preview||''),
    '',
    '条件：',
    '- 単なる「参加ありがとうございます」だけで終わらせない',
    '- 記事の具体的な内容・印象的だった箇所に触れる',
    '- 企画に参加してくれたことへの感謝は自然に入れてよい',
    '- 明るく親しみやすい王子の口調',
    '- 🌙や🤭︎は自然な範囲で使う',
    '- そのままnoteのコメント欄へ貼れる本文だけを出す'
  ].join('\n');
}

function batchEventPrompt(){
  const header=[
    '王子（nero_notelover）が開催しているイベントの参加記事です。',
    '以下の記事それぞれに、王子らしいコメント案を1案ずつ作ってください。',
    '各記事について「記事タイトル」「記事URL」「投稿者」を表示し、コメント本文だけをtextコードブロックに入れてください。',
    '単なる参加のお礼ではなく、本文の具体的な内容に触れてください。',
    '',
    '【検索元】'+String(state.eventSource||''),
    ''
  ];
  const articles=state.eventArticles.map((article,index)=>[
    '--- '+(index+1)+' ---',
    '【記事タイトル】'+String(article.title||''),
    '【記事URL】'+String(article.articleUrl||''),
    '【投稿者】'+String(article.authorName||article.authorUrlname||''),
    '【本文】',
    String(article.body||article.preview||'').slice(0,8000),
    ''
  ].join('\n'));
  return header.concat(articles).join('\n');
}

async function copyValue(value){
  await navigator.clipboard.writeText(value);
}

function render(){
  commentsEl.innerHTML='';
  if(!state.filtered.length){
    commentsEl.innerHTML='<div class="empty">未返信コメントはありません🌙</div>';
    return;
  }
  const tpl=$('#commentTemplate');
  for(const item of state.filtered){
    const node=tpl.content.cloneNode(true);
    const img=node.querySelector('.avatar');
    img.src=item.avatar||'';
    img.style.visibility=item.avatar?'visible':'hidden';
    node.querySelector('.author').textContent=item.authorName||('@'+item.authorUrlname);
    node.querySelector('.date').textContent=dateText(item.publishedAt);
    const title=node.querySelector('.articleTitle');
    title.textContent=item.articleTitle||'記事を開く';
    title.href=item.articleUrl;
    node.querySelector('.commentBody').textContent=item.body||'';
    node.querySelector('.noteBtn').href=item.articleUrl;
    node.querySelector('.copyBtn').addEventListener('click',async()=>{
      await copyValue(item.body||'');
      showToast('コメントをコピーしました');
    });
    node.querySelector('.askBtn').addEventListener('click',async()=>{
      await copyValue(promptFor(item));
      showToast('ChatGPT用プロンプトをコピーしました🌙');
    });
    commentsEl.appendChild(node);
  }
}

function renderEventArticles(){
  eventResultsEl.innerHTML='';
  $('#copyEventBatchBtn').classList.toggle('hidden',!state.eventArticles.length);

  if(!state.eventArticles.length){
    eventResultsEl.innerHTML='<div class="empty">未コメントの記事は見つかりませんでした🌙</div>';
    return;
  }

  for(const article of state.eventArticles){
    const card=document.createElement('article');
    card.className='commentCard eventCard';

    const head=document.createElement('div');
    head.className='commentHead';

    const author=document.createElement('div');
    author.className='eventAuthor';
    author.innerHTML='<strong></strong><div class="date"></div>';
    author.querySelector('strong').textContent=article.authorName||('@'+article.authorUrlname);
    author.querySelector('.date').textContent=dateText(article.publishedAt);

    const badge=document.createElement('span');
    badge.className='badge';
    badge.textContent='王子未コメント';

    head.append(author,badge);

    const title=document.createElement('a');
    title.className='articleTitle eventTitle';
    title.href=article.articleUrl;
    title.target='_blank';
    title.rel='noopener';
    title.textContent=article.title||'記事を開く';

    const body=document.createElement('p');
    body.className='commentBody eventBody';
    const text=String(article.body||article.preview||'');
    body.textContent=text.length>900?text.slice(0,900)+'…':text;

    const actions=document.createElement('div');
    actions.className='actions';

    const ask=document.createElement('button');
    ask.className='primary';
    ask.textContent='✨ コメント案をChatGPT用にコピー';
    ask.addEventListener('click',async()=>{
      await copyValue(eventPromptFor(article));
      showToast('この記事のコメント案プロンプトをコピーしました🌙');
    });

    const open=document.createElement('a');
    open.href=article.articleUrl;
    open.target='_blank';
    open.rel='noopener';
    open.textContent='noteで開く ↗';

    actions.append(ask,open);
    card.append(head,title,body,actions);
    eventResultsEl.appendChild(card);
  }
}

function applyFilter(){
  const q=$('#searchInput').value.trim().toLowerCase();
  state.filtered=!q?state.items:state.items.filter(item=>
    [item.authorName,item.authorUrlname,item.articleTitle,item.body]
      .some(v=>String(v||'').toLowerCase().includes(q))
  );
  render();
}

function applyInboxSnapshot(data){
  state.items=Array.isArray(data?.items)?data.items:[];
  state.filtered=state.items;
  $('#count').textContent=Number(data?.unresolvedCount??state.items.length);
  $('#articleCount').textContent=Number(data?.articleCount??0)+'件';
  $('#updatedAt').textContent=data?.updatedAt?dateText(data.updatedAt):'まだ取得していません';
  render();
}

async function loadData(){
  statusEl.textContent='前回の手動取得データを確認しています…';
  let cached=null;
  try{
    cached=JSON.parse(localStorage.getItem('nero-live-comments-cache')||'null');
  }catch(_){}

  // 旧判定ロジックのキャッシュは再利用しない。
  if(cached?.classifierVersion!==2)cached=null;

  if(cached){
    applyInboxSnapshot(cached);
    statusEl.textContent='';
    return;
  }

  state.items=[];
  state.filtered=[];
  $('#count').textContent='—';
  $('#articleCount').textContent='—';
  $('#updatedAt').textContent='未取得';
  commentsEl.innerHTML='<div class="empty">判定方法を更新しました。<br>「最新コメントを取得」を押して、現在の状態を確認してください🌙</div>';
  statusEl.textContent='';
}

function setSyncUi(label,detail,percent){
  $('#syncState').textContent=label;
  $('#syncDetail').textContent=detail;
  $('#progressFill').style.width=Math.max(0,Math.min(100,percent))+'%';
}

async function manualRefresh(){
  const btn=$('#refreshBtn');
  btn.disabled=true;
  btn.textContent='↻ note確認中…';
  statusEl.textContent='最新コメントを取得しています…';
  setSyncUi('取得中','noteの記事とコメントを確認しています。',8);

  const merged=new Map();
  let offset=0;
  let candidateTotal=0;
  let articleCount=0;
  let failedArticles=0;
  let updatedAt=new Date().toISOString();
  let scanId='';

  try{
    for(let guard=0;guard<30;guard++){
      const scanParam=scanId?'&scan_id='+encodeURIComponent(scanId):'';
      const url=WORKER+'/comments/live?offset='+offset+'&batch=1'+scanParam+'&t='+Date.now();
      const res=await fetch(url,{cache:'no-store'});
      const data=await res.json();
      if(!res.ok||!data.ok)throw new Error(data.error||('HTTP '+res.status));
      scanId=String(data.scanId||scanId||'');

      candidateTotal=Number(data.candidateArticles||0);
      articleCount=Number(data.articleCount||articleCount||0);
      failedArticles+=Number(data.failedArticles||0);
      updatedAt=data.updatedAt||updatedAt;

      for(const item of Array.isArray(data.items)?data.items:[]){
        merged.set(item.id,item);
      }

      const completed=Math.min(candidateTotal,Number(data.offset||0)+Number(data.scannedArticles||0));
      const percent=candidateTotal?Math.min(94,10+Math.round((completed/candidateTotal)*84)):94;
      setSyncUi(
        '取得中',
        candidateTotal
          ? '確認対象 '+completed+' / '+candidateTotal+'記事。未対応コメント '+merged.size+'件。'
          : '更新が必要な記事はありません。',
        percent
      );

      if(data.nextOffset===null||data.nextOffset===undefined)break;
      offset=Number(data.nextOffset);
    }

    const items=[...merged.values()].sort((a,b)=>(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0));
    const snapshot={
      version:3,
      classifierVersion:2,
      owner:'nero_notelover',
      updatedAt,
      articleCount,
      unresolvedCount:items.length,
      failedArticles,
      items
    };

    localStorage.setItem('nero-live-comments-cache',JSON.stringify(snapshot));
    applyInboxSnapshot(snapshot);
    statusEl.textContent='';
    setSyncUi(
      failedArticles?'取得完了（判定保留あり）':'取得完了',
      '今この時点の未対応コメントは '+items.length+'件です。'
        +(failedArticles?' '+failedArticles+'記事は取得に失敗したため未返信一覧へ混ぜず、判定保留にしました。もう一度更新すると再確認します。':''),
      100
    );
    showToast('最新コメントを取得しました🌙');
  }catch(error){
    setSyncUi('取得失敗','最新コメントを取得できませんでした：'+String(error.message||error),0);
    statusEl.textContent='取得に失敗しました。少し待ってからもう一度お試しください。';
  }finally{
    btn.disabled=false;
    btn.textContent='↻ 最新コメントを取得';
  }
}

function switchView(view){
  document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id===view+'View'));
  document.querySelectorAll('.tab[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  $('#refreshBtn').style.display=view==='comments'?'':'none';
}

async function checkEventArticlesFully(articles,onProgress){
  const results=new Array(articles.length);
  let cursor=0;
  let completed=0;
  const concurrency=Math.min(3,Math.max(1,articles.length));

  async function worker(){
    while(true){
      const index=cursor++;
      if(index>=articles.length)return;
      const article=articles[index];
      try{
        const res=await fetch(WORKER+'/event/check-article',{
          method:'POST',
          cache:'no-store',
          headers:{'content-type':'application/json'},
          body:JSON.stringify(article)
        });
        const data=await res.json();
        results[index]=res.ok&&data.ok?data:{status:'unknown',article,error:data.error||('HTTP '+res.status)};
      }catch(error){
        results[index]={status:'unknown',article,error:String(error.message||error)};
      }finally{
        completed++;
        onProgress?.(completed,articles.length,results[index]);
      }
    }
  }

  await Promise.all(Array.from({length:concurrency},()=>worker()));
  return results;
}

async function searchEvent(sourceType){
  const input=sourceType==='hashtag'?$('#hashtagInput'):$('#magazineInput');
  const source=input.value.trim();
  if(!source){
    eventStatusEl.textContent=sourceType==='hashtag'?'ハッシュタグを入力してください。':'マガジンURLを入力してください。';
    return;
  }

  localStorage.setItem(sourceType==='hashtag'?'nero-event-hashtag':'nero-event-magazine',source);
  eventStatusEl.textContent='検索元の記事を最後まで取得しています…';
  eventResultsEl.innerHTML='<div class="empty">全記事を走査中…🌙</div>';
  $('#copyEventBatchBtn').classList.add('hidden');

  const buttons=[$('#hashtagSearchBtn'),$('#magazineSearchBtn')];
  buttons.forEach(button=>button.disabled=true);

  state.eventArticles=[];
  state.eventSourceType=sourceType;
  state.eventSource=source;

  let inspected=0;
  let skippedCommented=0;
  let skippedOwn=0;
  let unknown=0;
  let sourcePageNumber=1;
  const seenPages=new Set();

  try{
    while(true){
      if(seenPages.has(sourcePageNumber))throw new Error('ページ番号が循環したため停止しました。');
      seenPages.add(sourcePageNumber);

      const sourceUrl=WORKER+'/event/source-page?type='+encodeURIComponent(sourceType)
        +'&q='+encodeURIComponent(source)
        +'&page='+encodeURIComponent(sourcePageNumber)
        +'&t='+Date.now();
      const sourceRes=await fetch(sourceUrl,{cache:'no-store'});
      const sourceData=await sourceRes.json();
      if(!sourceRes.ok||!sourceData.ok)throw new Error(sourceData.error||('HTTP '+sourceRes.status));

      state.eventSource=sourceData.source||state.eventSource;
      const articles=Array.isArray(sourceData.articles)?sourceData.articles:[];
      const pageTotal=articles.length;

      eventStatusEl.textContent=String(state.eventSource)+'：このページ '+pageTotal+'記事を確認します…';

      const checked=await checkEventArticlesFully(articles,(done,total)=>{
        eventStatusEl.textContent=
          String(state.eventSource)+'：確認 '+(inspected+done)+'件'
          +'（現在ページ '+done+' / '+total+'）'
          +' / 未コメント '+state.eventArticles.length+'件';
      });

      for(const result of checked){
        inspected++;
        if(result?.status==='uncommented'&&result.article){
          state.eventArticles.push(result.article);
        }else if(result?.status==='commented'){
          skippedCommented++;
        }else if(result?.status==='own'){
          skippedOwn++;
        }else{
          unknown++;
        }
      }

      // 途中経過も表示しておく。最後まで走査しても未コメントが0件なら空表示になる。
      renderEventArticles();

      if(sourceData.nextPage===null||sourceData.nextPage===undefined)break;
      sourcePageNumber=Number(sourceData.nextPage);
      if(!Number.isFinite(sourcePageNumber)||sourcePageNumber<1)throw new Error('次ページ番号を取得できませんでした。');
    }

    eventStatusEl.textContent=
      String(state.eventSource)+'：全記事の走査完了。未コメント '+state.eventArticles.length+'件'
      +'（全確認 '+inspected+'件 / コメント済み '+skippedCommented+'件'
      +(skippedOwn?' / 王子自身 '+skippedOwn+'件':'')
      +(unknown?' / 判定保留 '+unknown+'件':'')+'）';
    renderEventArticles();
  }catch(error){
    eventStatusEl.textContent='走査に失敗しました：'+String(error.message||error)
      +(inspected?'（'+inspected+'件までは確認済み）':'');
    renderEventArticles();
  }finally{
    buttons.forEach(button=>button.disabled=false);
  }
}

document.querySelectorAll('.tab[data-view]').forEach(button=>{
  button.addEventListener('click',()=>switchView(button.dataset.view));
});

$('#refreshBtn').addEventListener('click',manualRefresh);
$('#searchInput').addEventListener('input',applyFilter);
$('#hashtagSearchBtn').addEventListener('click',()=>searchEvent('hashtag'));
$('#magazineSearchBtn').addEventListener('click',()=>searchEvent('magazine'));
$('#copyEventBatchBtn').addEventListener('click',async()=>{
  await copyValue(batchEventPrompt());
  showToast('表示中の記事をまとめてコピーしました🌙');
});

const savedHashtag=localStorage.getItem('nero-event-hashtag');
const savedMagazine=localStorage.getItem('nero-event-magazine');
if(savedHashtag)$('#hashtagInput').value=savedHashtag;
if(savedMagazine)$('#magazineInput').value=savedMagazine;

loadData();
setSyncUi('手動取得','「最新コメントを取得」を押した時だけnoteを確認します。',0);
