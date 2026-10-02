'use strict';

const state={
  items:[],
  filtered:[],
  syncWasRunning:false,
  pollTimer:null,
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

const RUNS_API='https://api.github.com/repos/neronote100/nero_comment_reader/actions/workflows/sync-comments.yml/runs?per_page=1';
const WORKER='https://nero-comment-reader.nero-prince.workers.dev';

function dateText(v){
  if(!v)return '日時不明';
  const d=new Date(v);
  if(Number.isNaN(d.getTime()))return String(v);
  return new Intl.DateTimeFormat('ja-JP',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);
}

function timeText(v){
  const d=new Date(v);
  if(Number.isNaN(d.getTime()))return '—';
  return new Intl.DateTimeFormat('ja-JP',{hour:'2-digit',minute:'2-digit'}).format(d);
}

function nextScheduledSync(){
  const now=new Date();
  const next=new Date(now);
  next.setSeconds(0,0);
  const m=now.getMinutes();
  if(m<7)next.setMinutes(7);
  else if(m<37)next.setMinutes(37);
  else{
    next.setHours(now.getHours()+1);
    next.setMinutes(7);
  }
  return next;
}

function updateNextSync(){
  const next=nextScheduledSync();
  const mins=Math.max(0,Math.ceil((next-Date.now())/60000));
  $('#nextSync').textContent=timeText(next)+'（約'+mins+'分後）';
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

async function loadData(){
  statusEl.textContent='最新データを読み込んでいます…';
  try{
    const res=await fetch('./data/inbox.json?t='+Date.now(),{cache:'no-store'});
    if(!res.ok)throw new Error('HTTP '+res.status);
    const data=await res.json();
    state.items=Array.isArray(data.items)?data.items:[];
    state.filtered=state.items;
    $('#count').textContent=Number(data.unresolvedCount??state.items.length);
    $('#articleCount').textContent=Number(data.articleCount??0)+'件';
    $('#updatedAt').textContent=data.updatedAt?dateText(data.updatedAt):'まだ同期されていません';
    statusEl.textContent='';
    render();
  }catch(error){
    statusEl.textContent='データを読み込めませんでした。同期状態を確認してください。';
    commentsEl.innerHTML='';
  }
}

function setSyncUi(label,detail,percent){
  $('#syncState').textContent=label;
  $('#syncDetail').textContent=detail;
  $('#progressFill').style.width=Math.max(0,Math.min(100,percent))+'%';
}

async function checkSyncStatus(){
  updateNextSync();
  clearTimeout(state.pollTimer);
  try{
    const res=await fetch(RUNS_API,{cache:'no-store',headers:{Accept:'application/vnd.github+json'}});
    if(!res.ok)throw new Error('HTTP '+res.status);
    const json=await res.json();
    const run=json.workflow_runs&&json.workflow_runs[0];
    if(!run){
      setSyncUi('待機中','まだ同期履歴がありません。',0);
      return;
    }

    if(run.status==='queued'||run.status==='waiting'||run.status==='pending'){
      state.syncWasRunning=true;
      setSyncUi('待機中','GitHub Actionsの開始を待っています。',12);
      state.pollTimer=setTimeout(checkSyncStatus,30000);
      return;
    }

    if(run.status==='in_progress'){
      state.syncWasRunning=true;
      let percent=45;
      let label='note確認中';
      let detail='コメントを確認しています。開始 '+timeText(run.run_started_at||run.created_at);

      try{
        const jobsRes=await fetch('https://api.github.com/repos/neronote100/nero_comment_reader/actions/runs/'+run.id+'/jobs?per_page=20',{
          cache:'no-store',headers:{Accept:'application/vnd.github+json'}
        });
        if(jobsRes.ok){
          const jobs=await jobsRes.json();
          const steps=jobs.jobs?.[0]?.steps||[];
          const syncStep=steps.find(s=>s.name==='Sync comments');
          const commitStep=steps.find(s=>s.name==='Commit updated data');
          if(commitStep?.status==='in_progress'){
            percent=88;label='保存中';detail='最新の未対応コメントをGitHubへ保存しています。';
          }else if(syncStep?.status==='completed'){
            percent=78;label='確認完了';detail='コメント確認が終わりました。保存処理へ進みます。';
          }else if(syncStep?.status==='in_progress'){
            percent=52;label='note確認中';detail='記事とコメントを順番に確認しています。';
          }else{
            percent=25;label='準備中';detail='同期の準備をしています。';
          }
        }
      }catch(_){}

      setSyncUi(label,detail,percent);
      state.pollTimer=setTimeout(checkSyncStatus,30000);
      return;
    }

    if(run.conclusion==='success'){
      setSyncUi('同期完了','最新同期 '+dateText(run.updated_at||run.created_at)+'。次回まで待機中です。',100);
      if(state.syncWasRunning){
        state.syncWasRunning=false;
        await loadData();
        showToast('同期が完了しました🌙');
      }
      return;
    }

    state.syncWasRunning=false;
    setSyncUi('同期エラー','直近の同期は '+String(run.conclusion||'失敗')+' でした。',100);
  }catch(error){
    setSyncUi('状況取得失敗','GitHubの同期状況を取得できませんでした。コメント一覧の再読込は利用できます。',0);
  }
}

async function refreshAll(){
  const btn=$('#refreshBtn');
  btn.disabled=true;
  btn.textContent='↻ 確認中…';
  try{
    await Promise.all([loadData(),checkSyncStatus()]);
  }finally{
    btn.disabled=false;
    btn.textContent='↻ 同期状況を確認';
  }
}

function switchView(view){
  document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id===view+'View'));
  document.querySelectorAll('.tab[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  $('#refreshBtn').style.display=view==='comments'?'':'none';
}

async function searchEvent(sourceType){
  const input=sourceType==='hashtag'?$('#hashtagInput'):$('#magazineInput');
  const source=input.value.trim();
  if(!source){
    eventStatusEl.textContent=sourceType==='hashtag'?'ハッシュタグを入力してください。':'マガジンURLを入力してください。';
    return;
  }

  localStorage.setItem(sourceType==='hashtag'?'nero-event-hashtag':'nero-event-magazine',source);
  eventStatusEl.textContent='王子がすでにコメントした記事を確認しながら検索しています…';
  eventResultsEl.innerHTML='<div class="empty">検索中…🌙</div>';
  $('#copyEventBatchBtn').classList.add('hidden');

  const buttons=[$('#hashtagSearchBtn'),$('#magazineSearchBtn')];
  buttons.forEach(button=>button.disabled=true);

  try{
    const url=WORKER+'/event/search?type='+encodeURIComponent(sourceType)+'&q='+encodeURIComponent(source)+'&limit=5&t='+Date.now();
    const res=await fetch(url,{cache:'no-store'});
    const data=await res.json();
    if(!res.ok||!data.ok)throw new Error(data.error||('HTTP '+res.status));

    state.eventArticles=Array.isArray(data.articles)?data.articles:[];
    state.eventSourceType=sourceType;
    state.eventSource=data.source||source;

    eventStatusEl.textContent=
      String(data.source||source)+'：未コメント '+state.eventArticles.length+'件表示'
      +'（確認 '+Number(data.inspected||0)+'件 / コメント済み除外 '+Number(data.skippedCommented||0)+'件）';
    renderEventArticles();
  }catch(error){
    state.eventArticles=[];
    eventResultsEl.innerHTML='';
    eventStatusEl.textContent='検索に失敗しました：'+String(error.message||error);
  }finally{
    buttons.forEach(button=>button.disabled=false);
  }
}

document.querySelectorAll('.tab[data-view]').forEach(button=>{
  button.addEventListener('click',()=>switchView(button.dataset.view));
});

$('#refreshBtn').addEventListener('click',refreshAll);
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

updateNextSync();
refreshAll();
setInterval(updateNextSync,60000);
