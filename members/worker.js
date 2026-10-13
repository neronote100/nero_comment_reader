import html from "./site.html";
import css from "./site.css";
import script from "./site-script.txt";

const NOTE = "https://note.com";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const validOwner = value => /^[a-zA-Z0-9_-]{2,80}$/.test(value);
const safeText = value => String(value ?? "").trim();
const MAX_ARTICLES = 5000;
const AUDIT_DAYS = 7;
const MAX_NOTE_REQUESTS_PER_STEP = 8;
const SCAN_EXPIRATION_MS = 24 * 60 * 60 * 1000;

function parseRows(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.comments)) return payload.data.comments;
  if (Array.isArray(payload?.comments)) return payload.comments;
  return [];
}
function flatten(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return String(node.value ?? node.text ?? "");
  const content = (Array.isArray(node.children) ? node.children : []).map(flatten).join("");
  return ["p", "div", "li"].includes(node.tag_name) ? content + "\n" : content;
}
function norm(comment) {
  const user = comment.user || comment.author || {};
  return {
    key: String(comment.key || comment.comment_key || ""),
    parentKey: String(comment.parent_key || ""),
    authorUrlname: String(user.urlname || comment.urlname || "").toLowerCase(),
    authorName: String(user.nickname || user.name || ""),
    body: safeText(flatten(comment.comment ?? comment.body ?? comment.content ?? "")).slice(0,1600),
    publishedAt: String(comment.published_at || comment.created_at || ""),
    replyCount: Number(comment.reply_count ?? comment.replyCount ?? 0),
    isRoot: comment.is_root !== false,
    creatorLiked: Boolean(comment.is_creator_liked ?? comment.isCreatorLiked ?? false),
    creatorReplied: Boolean(comment.is_creator_replied ?? comment.isCreatorReplied ?? false)
  };
}
async function noteJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14000);
  try {
    const res = await fetch(NOTE + path, {
      headers: { Accept: "application/json", "User-Agent": "NeroCommentReader/Member" },
      signal: controller.signal,
      cf: { cacheTtl: 0 }
    });
    if (!res.ok) throw new Error("note API HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}
async function fetchArticles(owner) {
  const map = new Map();
  for (let page = 1; page <= 100; page++) {
    const params = new URLSearchParams({ kind: "note", disabled_pinned: "true", page: String(page) });
    const data = await noteJson("/api/v2/creators/" + encodeURIComponent(owner) + "/contents?" + params);
    const rows = data?.data?.contents || data?.contents || [];
    for (const row of rows) {
      const key = String(row.key || row.noteKey || row.note_key || "");
      if (!key) continue;
      map.set(key, {
        key,
        title: String(row.name || row.title || ""),
        commentCount: Number(row.commentCount ?? row.comment_count ?? 0),
        publishedAt: String(row.publishAt || row.publishedAt || ""),
        url: NOTE + "/" + owner + "/n/" + key
      });
    }
    if (map.size >= MAX_ARTICLES) throw new Error("記事数が上限を超えています");
    if (Boolean(data?.data?.isLastPage ?? data?.isLastPage ?? false) || !rows.length) break;
  }
  return [...map.values()];
}
async function fetchComments(articleKey, parentKey = "") {
  const comments = [];
  for (let page = 1; page <= 40; page++) {
    const params = new URLSearchParams({ order: "oldest", per_page: "100", page: String(page) });
    if (parentKey) params.set("parent_key", parentKey);
    const data = await noteJson("/api/v3/notes/" + encodeURIComponent(articleKey) + "/note_comments?" + params);
    const rows = parseRows(data);
    comments.push(...rows.map(norm));
    const next = data.next_page ?? data.nextPage ?? data.data?.next_page ?? data.data?.nextPage;
    if (!next || !rows.length) return comments;
    if (page === 40) throw new Error("コメントのページ上限に到達");
  }
  return comments;
}
function unresolvedForThread(root, replies, owner) {
  const all = [root, ...replies].filter(x => x.key)
    .sort((a, b) => (Date.parse(a.publishedAt) || 0) - (Date.parse(b.publishedAt) || 0));
  let lastOwner = -1;
  for (let i = 0; i < all.length; i++) if (all[i].authorUrlname === owner) lastOwner = i;
  const pending = all.slice(lastOwner + 1).filter(x => x.authorUrlname && x.authorUrlname !== owner && !x.creatorLiked);
  if (!pending.length) return [];
  const current = pending[pending.length - 1];
  return [{ ...current, rootKey: root.key, rootBody: root.body, pendingCount: pending.length,
    pendingBodies: pending.slice(-6).map(x => x.body.slice(0,800)).filter(Boolean) }];
}
async function scanArticle(article, owner) {
  const roots = (await fetchComments(article.key)).filter(x => x.isRoot);
  const only = article.scanMode === "pending_only" &&
    new Set((article.previousUnresolved || []).map(x => x.rootKey || x.key)).size > 0;
  const keys = new Set((article.previousUnresolved || []).map(x => x.rootKey || x.key));
  const unresolved = [];
  for (const root of roots) {
    if (!root.authorUrlname || root.authorUrlname === owner) continue;
    if (only && !keys.has(root.key)) continue;
    if (root.replyCount <= 0) {
      if (!root.creatorLiked) unresolved.push({ ...root, rootKey: root.key,
        rootBody: root.body, pendingCount: 1, pendingBodies: [root.body] });
      continue;
    }
    // 返信が1件でも、作者以外の返信の可能性があるのでスレッド単位で確認する。
    const replies = (await fetchComments(article.key, root.key)).filter(x => !x.isRoot);
    unresolved.push(...unresolvedForThread(root, replies, owner));
  }
  return unresolved;
}
function publicItem(article, comment) {
  return { id: article.key + ":" + comment.key, articleTitle: article.title,
    articleUrl: article.url, articleKey: article.key, commentKey: comment.key,
    authorName: comment.authorName, authorUrlname: comment.authorUrlname,
    body: comment.body, publishedAt: comment.publishedAt,
    rootBody: comment.rootBody, pendingCount: comment.pendingCount,
    pendingBodies: comment.pendingBodies };
}

async function fetchArticlePage(owner, page) {
  const params = new URLSearchParams({ kind: "note", disabled_pinned: "true", page: String(page) });
  const payload = await noteJson("/api/v2/creators/" + encodeURIComponent(owner) + "/contents?" + params);
  const rows = Array.isArray(payload?.data?.contents) ? payload.data.contents
    : Array.isArray(payload?.contents) ? payload.contents : [];
  const articles = rows.map(row => ({
    key: String(row.key || row.noteKey || row.note_key || ""),
    title: String(row.name || row.title || "").slice(0,300),
    commentCount: Number(row.commentCount ?? row.comment_count ?? 0),
    publishedAt: String(row.publishAt || row.publishedAt || ""),
    url: NOTE + "/" + owner + "/n/" + String(row.key || row.noteKey || row.note_key || "")
  })).filter(row => row.key && Number.isFinite(row.commentCount));
  const last = Boolean(payload?.data?.isLastPage ?? payload?.isLastPage ?? false) || rows.length === 0;
  return { articles, last };
}
async function fetchArticleIndexChunk(owner, startPage) {
  const result = [];
  let page = startPage;
  let last = false;
  for (let i = 0; i < MAX_NOTE_REQUESTS_PER_STEP; i++) {
    if(page>500) throw new Error("記事一覧のページ数が上限を超えました");
    const fetched = await fetchArticlePage(owner, page++);
    result.push(...fetched.articles);
    if (fetched.last) { last = true; break; }
  }
  return { articles: result, nextPage: page, last };
}
async function fetchCommentPage(noteKey, parentKey, page) {
  const params = new URLSearchParams({order:"oldest",per_page:"100",page:String(page)});
  if (parentKey) params.set("parent_key",parentKey);
  const payload = await noteJson("/api/v3/notes/" + encodeURIComponent(noteKey) + "/note_comments?" + params);
  const rows = parseRows(payload).map(norm);
  const next = payload?.next_page ?? payload?.nextPage ?? payload?.data?.next_page ?? payload?.data?.nextPage ?? null;
  const n = Number(next);
  return { rows, nextPage: next && rows.length ? (Number.isFinite(n) && n > page ? n : page+1) : null };
}
function initialWork() {
  return { rootPage:1, roots:null, nextRootPage:null, rootIndex:0,
    thread:null, replyPage:1, pending:[] };
}
// Each HTTP request uses at most eight calls to note.com, even for hundreds of reply threads.
// This prevents a 400-article creator's busiest article from hitting Workers Free's 50-subrequest cap.
export async function scanArticleChunk(article, owner, previousWork) {
  const work = previousWork || initialWork();
  const previousKeys = new Set((article.previousUnresolved || []).map(item => item.rootKey || item.key));
  const pendingOnly = article.scanMode === "pending_only" && previousKeys.size > 0;
  let calls = 0;
  while (calls < MAX_NOTE_REQUESTS_PER_STEP) {
    if (!work.roots) {
      if (work.rootPage > 1000) throw new Error("コメントのページ数が上限を超えました");
      const page = await fetchCommentPage(article.key, "", work.rootPage);
      calls++;
      work.roots = page.rows.filter(item => item.isRoot);
      work.nextRootPage = page.nextPage;
      work.rootIndex = 0;
    }
    if (work.rootIndex >= work.roots.length) {
      if (!work.nextRootPage) return { done:true, unresolved:work.pending, work:null, requests:calls };
      work.rootPage = work.nextRootPage;
      work.roots = null;
      work.nextRootPage = null;
      continue;
    }
    const root = work.roots[work.rootIndex];
    if (!root.authorUrlname || root.authorUrlname === owner || (pendingOnly && !previousKeys.has(root.key))) {
      work.rootIndex++; continue;
    }
    if (root.replyCount === 0) {
      if (!root.creatorLiked) work.pending.push({
        ...root, rootKey:root.key, rootBody:root.body, pendingCount:1, pendingBodies:[root.body]
      });
      work.rootIndex++; continue;
    }
    if (work.replyPage > 1000) throw new Error("返信のページ数が上限を超えました");
    const repliesPage = await fetchCommentPage(article.key, root.key, work.replyPage);
    calls++;
    if (!work.thread) {
      work.thread = { count:root.creatorLiked?0:1,
        latest:root.creatorLiked?null:root,
        bodies:root.creatorLiked?[]:[root.body.slice(0,800)] };
    }
    for (const reply of repliesPage.rows.filter(item => !item.isRoot)) {
      if (!reply.authorUrlname) continue;
      if (reply.authorUrlname === owner) {
        work.thread = { count:0,latest:null,bodies:[] };
      } else if (!reply.creatorLiked) {
        work.thread.count++;
        work.thread.latest=reply;
        work.thread.bodies.push(reply.body.slice(0,800));
        if(work.thread.bodies.length>6)work.thread.bodies.shift();
      }
    }
    if (repliesPage.nextPage) {
      work.replyPage = repliesPage.nextPage;
    } else {
      if (work.thread.count>0 && work.thread.latest) {
        work.pending.push({ ...work.thread.latest, rootKey:root.key,
          rootBody:root.body, pendingCount:work.thread.count,
          pendingBodies:work.thread.bodies });
      }
      work.thread = null;
      work.replyPage = 1;
      work.rootIndex++;
    }
  }
  return { done:false, work, requests:calls };
}
const articleStoreKey = key => "article:" + key;
export class MemberStateStore {
  constructor(state) { this.storage = state.storage; }

  async savedSnapshot(offset=0, limit=100) {
    const cached = await this.storage.list({prefix:"article:"});
    const all = [];
    for (const state of cached.values()) {
      if (state.error) continue;
      for (const c of state.unresolved || []) all.push(publicItem(state, c));
    }
    all.sort((a,b)=>(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0));
    const owner = await this.storage.get("owner") || "";
    const latest = await this.storage.get("latestStats") || null;
    return {owner, latest, items:all.slice(offset,offset+limit),
      nextOffset:offset+limit<all.length?offset+limit:null, totalItems:all.length};
  }

  async complete(scan) {
    const checked = await this.storage.list({prefix:"article:"});
    let pending = 0;
    for (const article of scan.articles) {
      if (scan.failed.some(f => f.key===article.key)) continue;
      pending += (checked.get(articleStoreKey(article.key))?.unresolved || []).length;
    }
    const stats = {
      updatedAt:new Date().toISOString(), articleCount:scan.articles.length,
      candidateArticles:scan.candidates.length, scannedArticles:scan.index,
      failedArticles:scan.failed.length, failedArticleKeys:scan.failed.slice(0,100),
      unresolvedCount:pending
    };
    await this.storage.put("latestStats", stats);
    await this.storage.delete("scan");
    return stats;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method=request.method;
    if (method === "GET" && url.pathname === "/state") {
      return respond({ok:true,...await this.savedSnapshot(0,100),
        hasScan:Boolean(await this.storage.get("scan"))});
    }
    if (method === "GET" && url.pathname === "/comments") {
      const offset = Math.max(0,Number(url.searchParams.get("offset"))||0);
      return respond({ok:true,...await this.savedSnapshot(offset,100)});
    }
    if (method === "POST" && url.pathname === "/profile") {
      const {owner} = await request.json();
      const chosen=String(owner||"").toLowerCase().trim();
      if (!validOwner(chosen)) return respond({ok:false,error:"noteユーザー名を確認してください"},400);
      if (chosen !== (await this.storage.get("owner"))) {
        const articles=await this.storage.list({prefix:"article:"});
        await Promise.all([...articles.keys()].map(key=>this.storage.delete(key)));
        await this.storage.put("owner",chosen);
        await this.storage.delete("latestStats");
        await this.storage.delete("scan");
      }
      return respond({ok:true,owner:chosen});
    }
    if (method === "POST" && url.pathname === "/start") {
      const owner=await this.storage.get("owner");
      if (!owner) return respond({ok:false,error:"noteユーザー名を登録してください"},400);
      const existing=await this.storage.get("scan");
      if (existing && Date.now()-existing.startedAt<SCAN_EXPIRATION_MS) {
        return respond({ok:true,done:false,scanId:existing.id,
          phase:existing.phase, scannedArticles:existing.index, candidateArticles:existing.candidates?.length||0,
          articleCount:existing.articles.length});
      }
      const quota=await this.storage.get("quota")||{day:0,count:0};
      const day=Math.floor(Date.now()/86400000);
      if (quota.day!==day) {quota.day=day;quota.count=0;}
      if (quota.count>=12) return respond({ok:false,error:"1日の更新上限（12回）に達しました。翌日に再開してください"},429);
      quota.count++;
      await this.storage.put("quota",quota);
      const scan={id:crypto.randomUUID(),owner,startedAt:Date.now(),
        phase:"listing",articles:[],listPage:1,candidates:[],index:0,work:null,failed:[]};
      await this.storage.put("scan",scan);
      return respond({ok:true,done:false,scanId:scan.id,phase:"listing",
        scannedArticles:0,candidateArticles:0,articleCount:0});
    }
    if (method === "GET" && url.pathname === "/peek") {
      const scan=await this.storage.get("scan");
      const id=url.searchParams.get("scan_id");
      if (!scan || scan.id!==id || Date.now()-scan.startedAt>SCAN_EXPIRATION_MS)
        return respond({ok:false,error:"更新状態の有効期限が切れました。再実行してください"},409);
      return respond({ok:true,scanId:scan.id,phase:scan.phase,
        owner:scan.owner,index:scan.index,listPage:scan.listPage,work:scan.work,
        article:scan.candidates[scan.index]||null});
    }
    if (method === "POST" && url.pathname === "/index") {
      const {scanId,listPage,articles,nextPage,last} = await request.json();
      const scan=await this.storage.get("scan");
      if (!scan || scan.id!==scanId || scan.phase!=="listing" || scan.listPage!==listPage)
        return respond({ok:false,error:"取得状態が更新されました"},409);
      const merged=new Map(scan.articles.map(a=>[a.key,a]));
      for (const article of articles||[]) merged.set(article.key,article);
      scan.articles=[...merged.values()];
      if (scan.articles.length>MAX_ARTICLES)
        return respond({ok:false,error:"記事数が上限を超えています"},400);
      scan.listPage=nextPage;
      if (last) {
        const previous=await this.storage.list({prefix:"article:"});
        const day=Math.floor(Date.now()/86400000);
        for (const article of scan.articles) {
          const old=previous.get(articleStoreKey(article.key));
          if (article.commentCount<=0) {
            await this.storage.put(articleStoreKey(article.key),{...article,unresolved:[],checkedAt:Date.now()});
            continue;
          }
          const changed=!old || old.commentCount!==article.commentCount;
          const pending=Boolean(old?.unresolved?.length);
          const failed=!old||old.error||!old.checkedAt;
          let hash=0;
          for(const char of article.key)hash=(hash*31+char.charCodeAt(0))>>>0;
          const audit=!pending&&old?.checkedAt&&Date.now()-old.checkedAt>AUDIT_DAYS*86400000&&hash%7===day%7;
          if(changed||pending||failed||audit)scan.candidates.push({...article,
            scanMode:pending&&!changed&&!failed&&!audit?"pending_only":"full",
            previousUnresolved:(old?.unresolved||[]).map(c=>({rootKey:c.rootKey||c.key}))});
        }
        scan.phase="scanning";
        if(!scan.candidates.length){
          const stats=await this.complete(scan);
          return respond({ok:true,done:true,phase:"complete",...stats});
        }
      }
      await this.storage.put("scan",scan);
      return respond({ok:true,done:false,phase:scan.phase,scanId,
        articleCount:scan.articles.length, candidateArticles:scan.candidates.length,scannedArticles:scan.index});
    }
    if(method==="POST"&&url.pathname==="/commit"){
      const {scanId,index,done,work,unresolved,error}=await request.json();
      const scan=await this.storage.get("scan");
      if(!scan||scan.id!==scanId||scan.index!==index||scan.phase!=="scanning")
        return respond({ok:false,error:"更新状態が変更されました"},409);
      const article=scan.candidates[index];
      if(!article)return respond({ok:false,error:"走査対象がありません"},409);
      if(error){
        scan.failed.push({key:article.key,title:article.title,error:String(error)});
        const old=await this.storage.get(articleStoreKey(article.key));
        await this.storage.put(articleStoreKey(article.key),{...article,unresolved:old?.unresolved||[],
          checkedAt:0,error:true});
        scan.work=null;scan.index++;
      }else if(done){
        await this.storage.put(articleStoreKey(article.key),{...article,unresolved:unresolved||[],
          checkedAt:Date.now(),error:false});
        scan.work=null;scan.index++;
      }else{
        scan.work=work;
      }
      if(scan.index>=scan.candidates.length){
        const stats=await this.complete(scan);
        return respond({ok:true,done:true,phase:"complete",...stats});
      }
      await this.storage.put("scan",scan);
      return respond({ok:true,done:false,scanId,phase:"scanning",
        candidateArticles:scan.candidates.length,scannedArticles:scan.index,
        failedArticles:scan.failed.length});
    }
    if(method==="POST"&&url.pathname==="/logout"){
      // No authentication: logout only revokes this browser's anonymous session data.
      await this.storage.deleteAll();
      return respond({ok:true});
    }
    return respond({ok:false,error:"Not found"},404);
  }
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(request.method==="GET"&&url.pathname==="/")return new Response(html,{
      headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store",
        "content-security-policy":"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' https://assets.st-note.com data:; base-uri 'none'; frame-ancestors 'none'"}
    });
    if(request.method==="GET"&&url.pathname==="/site.css")
      return new Response(css,{headers:{"content-type":"text/css; charset=utf-8"}});
    if(request.method==="GET"&&url.pathname==="/site.js")
      return new Response(script,{headers:{"content-type":"application/javascript; charset=utf-8"}});
    if(!url.pathname.startsWith("/api/"))return respond({ok:false,error:"Not found"},404);
    if(!env.MEMBER_STATE)return respond({ok:false,error:"Member storage unavailable"},503);
    const token=request.headers.get("x-nero-client")||"";
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token))
      return respond({ok:false,error:"ブラウザIDが無効です"},400);
    const stub=env.MEMBER_STATE.get(env.MEMBER_STATE.idFromName("anon:"+token));
    if(request.method==="GET"&&url.pathname==="/api/me")
      return stub.fetch("https://member-state/state");
    if(request.method==="GET"&&url.pathname==="/api/comments"){
      const offset=Math.max(0,Number(url.searchParams.get("offset"))||0);
      return stub.fetch("https://member-state/comments?offset="+offset);
    }
    if(request.method==="POST"&&url.pathname==="/api/profile")
      return stub.fetch(new Request("https://member-state/profile",request));
    if(request.method==="POST"&&url.pathname==="/api/logout")
      return stub.fetch("https://member-state/logout",{method:"POST"});
    if(request.method==="POST"&&url.pathname==="/api/sync/start")
      return stub.fetch("https://member-state/start",{method:"POST"});
    if(request.method==="POST"&&url.pathname==="/api/sync/next"){
      try{
        const {scanId}=await request.json();
        if(!/^[0-9a-f-]{36}$/i.test(String(scanId)))return respond({ok:false,error:"Invalid scan"},400);
        const peekResponse=await stub.fetch("https://member-state/peek?scan_id="+encodeURIComponent(scanId));
        if(!peekResponse.ok)return respond({ok:false,error:"Scan expired"},409);
        const peek=await peekResponse.json();
        if(peek.phase==="listing"){
          let result;
          try{result=await fetchArticleIndexChunk(peek.owner,peek.listPage);}
          catch(error){return respond({ok:false,error:"記事一覧の取得に失敗しました："+String(error?.message||error)},502);}
          return stub.fetch("https://member-state/index",{method:"POST",headers:{"content-type":"application/json"},
            body:JSON.stringify({scanId,listPage:peek.listPage,...result})});
        }
        if(peek.phase!=="scanning"||!peek.article)return respond({ok:false,error:"Invalid scan phase"},409);
        let result;
        try{result=await scanArticleChunk(peek.article,peek.owner,peek.work);}
        catch(error){result={done:true,error:String(error?.message||error)};}
        return stub.fetch("https://member-state/commit",{method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({scanId,index:peek.index,...result})});
      }catch(error){return respond({ok:false,error:String(error?.message||error)},502);}
    }
    return respond({ok:false,error:"Not found"},404);
  }
};
