import assert from "node:assert/strict";
import fs from "node:fs/promises";
const text = (await fs.readFile(new URL("./worker.js", import.meta.url),"utf8"))
  .replace(/^import (html|css|script) from "\.\/[^"]+";$/gm,"");
const { MemberStateStore, scanArticleChunk, default: member } =
  await import("data:text/javascript;base64,"+Buffer.from(text).toString("base64"));
const map=new Map();
const storage={
  get:async key=>map.get(key),
  put:async(key,v)=>{map.set(key,structuredClone(v));},
  delete:async key=>{map.delete(key);},
  deleteAll:async()=>map.clear(),
  list:async({prefix=""}={})=>new Map([...map.entries()].filter(([k])=>k.startsWith(prefix)))
};
const store=new MemberStateStore({storage});
const req=(path,body)=>store.fetch(new Request("https://member.test"+path,{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)
}));
const get=path=>store.fetch(new Request("https://member.test"+path));
const ok=async promise=>{
  const res=await promise;const data=await res.json();
  assert.equal(res.ok,true,JSON.stringify(data));assert.equal(data.ok,true,JSON.stringify(data));
  return data;
};
const browserId="12345678-1234-4234-8234-123456789abc";
const fetchWithClient=async(path,token=browserId)=>member.fetch(
  new Request("https://member.test"+path,{headers:{"x-nero-client":token}}),
  {MEMBER_STATE:{idFromName:name=>name,get:()=>({fetch:url=>store.fetch(new Request(url))})}});
assert.equal((await member.fetch(new Request("https://member.test/api/me"),{MEMBER_STATE:{}})).status,400);
assert.equal((await fetchWithClient("/api/me","invalid")).status,400);
const before=await (await fetchWithClient("/api/me")).json();
assert.equal(before.ok,true);
assert.equal(before.owner,"");

await ok(req("/profile",{owner:"someone_123"}));
const create=(n,keyprefix)=>Array.from({length:n},(_,i)=>({
  key:keyprefix+i,title:"Article "+i,commentCount:i===0?3:0,
  url:"https://note.com/someone_123/n/"+keyprefix+i,publishedAt:"2026-01-01"
}));
const articles=create(425,"a");
let started=await ok(req("/start",{}));
assert.equal(started.phase,"listing");
let resumed=await ok(req("/start",{}));
assert.equal(resumed.scanId,started.scanId,"restart resumes same scan");
let first=await ok(req("/index",{scanId:started.scanId,listPage:1,articles:articles.slice(0,300),nextPage:9,last:false}));
assert.equal(first.articleCount,300);
let second=await ok(req("/index",{scanId:started.scanId,listPage:9,articles:articles.slice(300),nextPage:13,last:true}));
assert.equal(second.articleCount,425);
assert.equal(second.candidateArticles,1,"only one article has comments");
let peek=await ok(get("/peek?scan_id="+started.scanId));
assert.equal(peek.phase,"scanning");
assert.equal(peek.article.key,"a0");
const pending={key:"c1",rootKey:"c1",body:"Hello",authorName:"Guest",authorUrlname:"guest",
  publishedAt:"2026-10-10T00:00:00Z",pendingCount:1,pendingBodies:["Hello"]};
let scanned=await ok(req("/commit",{scanId:started.scanId,index:0,done:false,
  work:{rootPage:1,roots:[],rootIndex:0,pending:[pending]}}));
assert.equal(scanned.scannedArticles,0);
scanned=await ok(req("/commit",{scanId:started.scanId,index:0,done:true,unresolved:[pending]}));
assert.equal(scanned.done,true);
assert.equal(scanned.unresolvedCount,1);
let snapshot=await ok(get("/state"));
assert.equal(snapshot.latest.articleCount,425);
assert.equal(snapshot.items.length,1);
assert.equal(snapshot.owner,"someone_123");
assert.equal(snapshot.nextOffset,null);

// Existing pending thread rechecks even if total comment count is unchanged.
started=await ok(req("/start",{}));
second=await ok(req("/index",{scanId:started.scanId,listPage:1,articles,nextPage:2,last:true}));
assert.equal(second.candidateArticles,1);
peek=await ok(get("/peek?scan_id="+started.scanId));
assert.equal(peek.article.scanMode,"pending_only");
scanned=await ok(req("/commit",{scanId:started.scanId,index:0,done:true,unresolved:[]}));
assert.equal(scanned.unresolvedCount,0);
started=await ok(req("/start",{}));
second=await ok(req("/index",{scanId:started.scanId,listPage:1,articles,nextPage:2,last:true}));
assert.equal(second.done,true);
assert.equal(second.candidateArticles,0,"resolved & unchanged comments skipped");
started=await ok(req("/start",{}));
const changed=articles.map(a=>a.key==="a0"?{...a,commentCount:4}:a);
second=await ok(req("/index",{scanId:started.scanId,listPage:1,articles:changed,nextPage:2,last:true}));
assert.equal(second.candidateArticles,1);
scanned=await ok(req("/commit",{scanId:started.scanId,index:0,done:true,error:"HTTP 429"}));
assert.equal(scanned.failedArticles,1);
started=await ok(req("/start",{}));
second=await ok(req("/index",{scanId:started.scanId,listPage:1,articles:changed,nextPage:2,last:true}));
assert.equal(second.candidateArticles,1,"failed article retried");
// Sign-out clears all cached data.
await ok(req("/logout",{}));
snapshot=await ok(get("/state"));
assert.equal(snapshot.owner,"");
assert.equal(snapshot.latest,null);

// 120 busy threads must be split into multiple invocations with no more than 8 note.com fetches each.
let networkCalls=0;
const rawFetch=globalThis.fetch;
globalThis.fetch=async url=>{
  networkCalls++;
  const u=new URL(url);
  const parent=u.searchParams.get("parent_key");
  const page=Number(u.searchParams.get("page"));
  if(parent)return Response.json({data:[{key:"reply_"+parent,parent_key:parent,is_root:false,
    user:{urlname:"reader",nickname:"Reader"},comment:"New reply"}],next_page:null});
  const rows=page===1?Array.from({length:100},(_,i)=>({key:"root"+i,is_root:true,
    reply_count:1,user:{urlname:"writer",nickname:"Writer"},comment:"Hello"})):
    Array.from({length:20},(_,i)=>({key:"root"+(100+i),is_root:true,
    reply_count:1,user:{urlname:"writer",nickname:"Writer"},comment:"Hello"}));
  return Response.json({data:rows,next_page:page===1?2:null});
};
try{
  let work=null,done=false,chunks=0,result;
  while(!done){
    const before=networkCalls;
    result=await scanArticleChunk({key:"testmany",scanMode:"full"},"writer",work);
    assert.ok(networkCalls-before<=8,"single step must respect 8 external note API calls");
    done=result.done;work=result.work;chunks++;
    assert.ok(chunks<50,"must terminate");
  }
  assert.equal(result.unresolved.length,120);
  assert.ok(chunks>12);
}finally{globalThis.fetch=rawFetch;}
console.log("425+ article scalability, anonymous sessions, sync resume, retries, chunk budgets and logout passed");
