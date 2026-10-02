import fs from 'node:fs/promises';

const OWNER=String(process.env.NOTE_OWNER||'nero_notelover').toLowerCase();
const FORCE=String(process.env.FORCE_SCAN||'').toLowerCase()==='true';
const BASE='https://note.com';
const STATE_PATH='data/state.json';
const INBOX_PATH='data/inbox.json';
const now=Date.now();

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function fetchJson(url){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const response=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error('HTTP '+response.status+' '+url);
    return await response.json();
  }finally{
    clearTimeout(timer);
  }
}

function cleanText(value){
  return String(value??'').replace(/\r/g,'').trim();
}

function astText(node){
  if(node==null)return '';
  if(typeof node==='string')return node;
  if(Array.isArray(node))return node.map(astText).filter(Boolean).join('');
  if(typeof node!=='object')return '';
  if(node.type==='text')return String(node.value??node.text??'');
  const children=Array.isArray(node.children)?node.children:[];
  const inner=children.map(astText).join('');
  const tag=String(node.tag_name||node.tagName||'').toLowerCase();
  return tag==='p'||tag==='div'||tag==='blockquote'||tag==='li'?inner+'\n':inner;
}

function normalizeComment(raw){
  const user=raw?.user||raw?.author||{};
  return {
    key:String(raw?.key||raw?.comment_key||''),
    parentKey:String(raw?.parent_key||raw?.parentKey||''),
    authorUrlname:String(user?.urlname||raw?.urlname||'').toLowerCase(),
    authorName:String(user?.nickname||user?.name||raw?.nickname||''),
    avatar:String(user?.profile_image_url||user?.profileImageUrl||raw?.profile_image_url||''),
    body:cleanText(astText(raw?.comment??raw?.body??raw?.content??'')),
    publishedAt:String(raw?.published_at||raw?.publish_at||raw?.created_at||raw?.createdAt||''),
    isRoot:raw?.is_root!==false,
    replyCount:Number(raw?.reply_count||raw?.replyCount||0),
    creatorReplied:Boolean(raw?.is_creator_replied??raw?.isCreatorReplied??false),
    creatorLiked:Boolean(raw?.is_creator_liked??raw?.isCreatorLiked??false)
  };
}

function parseCommentRows(payload){
  if(Array.isArray(payload?.data))return payload.data;
  if(Array.isArray(payload?.data?.comments))return payload.data.comments;
  if(Array.isArray(payload?.comments))return payload.comments;
  return [];
}

function nextPage(payload){
  return payload?.next_page??payload?.nextPage??payload?.data?.next_page??payload?.data?.nextPage??null;
}

async function fetchComments(noteKey,parentKey=''){
  const all=[];
  let page=1;
  for(let guard=0;guard<50;guard++){
    const url=new URL(BASE+'/api/v3/notes/'+encodeURIComponent(noteKey)+'/note_comments');
    url.searchParams.set('order','oldest');
    url.searchParams.set('per_page','100');
    url.searchParams.set('page',String(page));
    if(parentKey)url.searchParams.set('parent_key',parentKey);
    const payload=await fetchJson(url.toString());
    const rows=parseCommentRows(payload);
    all.push(...rows);
    const next=nextPage(payload);
    if(!next||rows.length===0)break;
    const n=Number(next);
    page=Number.isFinite(n)&&n>page?n:page+1;
    await sleep(120);
  }
  return all.map(normalizeComment);
}

async function creatorArticles(){
  const byKey=new Map();
  for(let page=1;page<=100;page++){
    const url=new URL(BASE+'/api/v2/creators/'+encodeURIComponent(OWNER)+'/contents');
    url.searchParams.set('kind','note');
    url.searchParams.set('disabled_pinned','true');
    url.searchParams.set('page',String(page));
    const payload=await fetchJson(url.toString());
    const data=payload?.data||{};
    const rows=Array.isArray(data?.contents)?data.contents:Array.isArray(payload?.contents)?payload.contents:[];
    for(const row of rows){
      const key=String(row?.key||row?.noteKey||row?.note_key||'');
      if(!key)continue;
      byKey.set(key,{
        key,
        title:String(row?.name||row?.title||''),
        commentCount:Number(row?.commentCount??row?.comment_count??0),
        publishedAt:String(row?.publishAt||row?.publishedAt||row?.publish_at||''),
        url:BASE+'/'+OWNER+'/n/'+key
      });
    }
    const last=Boolean(data?.isLastPage??data?.is_last_page??payload?.isLastPage??false);
    if(last||rows.length===0)break;
    await sleep(120);
  }
  return [...byKey.values()];
}

function unresolvedFromThread(root,replies){
  const thread=[root,...replies].sort((a,b)=>{
    const av=Date.parse(a.publishedAt)||0;
    const bv=Date.parse(b.publishedAt)||0;
    return av-bv;
  });
  let lastOwner=-1;
  for(let i=0;i<thread.length;i++){
    if(thread[i].authorUrlname===OWNER)lastOwner=i;
  }
  const unresolved=[];
  for(let i=lastOwner+1;i<thread.length;i++){
    const c=thread[i];
    if(!c.authorUrlname||c.authorUrlname===OWNER)continue;
    if(c.creatorLiked)continue;
    unresolved.push({
      ...c,
      rootKey:root.key,
      rootAuthorUrlname:root.authorUrlname,
      rootBody:root.body
    });
  }
  return unresolved;
}

async function scanArticle(article){
  const roots=(await fetchComments(article.key)).filter(c=>c.isRoot!==false);
  const unresolved=[];
  for(const root of roots){
    if(!root.creatorReplied){
      if(root.authorUrlname&&root.authorUrlname!==OWNER&&!root.creatorLiked){
        unresolved.push({
          ...root,
          rootKey:root.key,
          rootAuthorUrlname:root.authorUrlname,
          rootBody:root.body
        });
      }
      continue;
    }

    if(root.replyCount<=1)continue;

    await sleep(120);
    const replies=await fetchComments(article.key,root.key);
    unresolved.push(...unresolvedFromThread(root,replies));
  }
  return unresolved;
}

async function readState(){
  try{
    const raw=await fs.readFile(STATE_PATH,'utf8');
    const data=JSON.parse(raw);
    return data&&typeof data==='object'?data:{};
  }catch{
    return {};
  }
}

const oldState=await readState();
const oldArticles=oldState?.articles&&typeof oldState.articles==='object'?oldState.articles:{};
const articles=await creatorArticles();
const nextArticles={};
let failedArticles=0;

for(const article of articles){
  const old=oldArticles[article.key];
  if(article.commentCount<=0){
    nextArticles[article.key]={...article,unresolved:[],checkedAt:now};
    continue;
  }

  const oldChecked=Number(old?.checkedAt||0);
  const pending=Array.isArray(old?.unresolved)&&old.unresolved.length>0;
  const maxAge=pending?60*60*1000:24*60*60*1000;
  const shouldScan=FORCE||!old||Number(old.commentCount||0)!==article.commentCount||now-oldChecked>=maxAge;

  if(!shouldScan){
    nextArticles[article.key]={...old,...article};
    continue;
  }

  try{
    const unresolved=await scanArticle(article);
    nextArticles[article.key]={...article,unresolved,checkedAt:Date.now()};
  }catch(error){
    failedArticles++;
    console.error('scan failed',article.key,error?.message||error);
    nextArticles[article.key]=old?{...old,...article}:{...article,unresolved:[],checkedAt:0,error:true};
  }
  await sleep(180);
}

const items=[];
for(const article of Object.values(nextArticles)){
  for(const comment of Array.isArray(article.unresolved)?article.unresolved:[]){
    items.push({
      id:article.key+':'+comment.key,
      articleKey:article.key,
      articleTitle:article.title,
      articleUrl:article.url,
      articlePublishedAt:article.publishedAt,
      commentKey:comment.key,
      rootKey:comment.rootKey,
      authorUrlname:comment.authorUrlname,
      authorName:comment.authorName,
      avatar:comment.avatar,
      body:comment.body,
      publishedAt:comment.publishedAt,
      rootAuthorUrlname:comment.rootAuthorUrlname,
      rootBody:comment.rootBody
    });
  }
}

items.sort((a,b)=>(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0));
const updatedAt=new Date().toISOString();

await fs.mkdir('data',{recursive:true});
await fs.writeFile(STATE_PATH,JSON.stringify({
  version:1,
  owner:OWNER,
  updatedAt,
  articles:nextArticles
},null,2)+'\n');

await fs.writeFile(INBOX_PATH,JSON.stringify({
  version:1,
  owner:OWNER,
  updatedAt,
  articleCount:articles.length,
  unresolvedCount:items.length,
  failedArticles,
  items
},null,2)+'\n');

console.log('articles='+articles.length+' unresolved='+items.length+' failed='+failedArticles);
