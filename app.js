'use strict';

const state={items:[],filtered:[]};
const $=s=>document.querySelector(s);
const commentsEl=$('#comments');
const statusEl=$('#status');
const toastEl=$('#toast');

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

function applyFilter(){
  const q=$('#searchInput').value.trim().toLowerCase();
  state.filtered=!q?state.items:state.items.filter(item=>
    [item.authorName,item.authorUrlname,item.articleTitle,item.body]
      .some(v=>String(v||'').toLowerCase().includes(q))
  );
  render();
}

async function load(){
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
    statusEl.textContent=data.updatedAt?'':'最初の同期を待っています。';
    render();
  }catch(error){
    statusEl.textContent='データを読み込めませんでした。同期状態を確認してください。';
    commentsEl.innerHTML='';
  }
}

$('#refreshBtn').addEventListener('click',load);
$('#searchInput').addEventListener('input',applyFilter);
load();
