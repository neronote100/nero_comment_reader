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

export const READER_API_ORIGIN='https://ouji-note-mcp.nero-prince.workers.dev';
const PENDING_KEY='nero-reader-connect-pending-v1';
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const NOTE_KEY=/^n[a-f0-9]{8,32}$/;
const ERROR_MESSAGES={
  READER_AUTH_REQUIRED:'王子のGitHubで接続してから操作してください。',
  NOTE_SESSION_REQUIRED:'noteとの接続を準備しています。少し待ってからもう一度お試しください。',
  NOTE_ACCESS_PAUSED:'note側の制限で操作を止めました。時間をおいてからお試しください。',
  NOTE_READ_FAILED:'noteの状態を確認できませんでした。前回の候補を保持しています。',
  CANDIDATE_NOT_FOUND:'候補の有効期限が切れました。「候補を30人探す」で更新してください。',
  SCAN_EXPIRED:'候補の検索期限が切れました。もう一度「候補を30人探す」を押してください。',
  STORAGE_FAILED:'操作結果の保存を確認できませんでした。',
  INVALID_INPUT:'操作の情報を確認できませんでした。',
  READER_CONNECTION_FAILED:'接続を確認できませんでした。もう一度GitHubで接続してください。',
  READER_SERVICE_UNAVAILABLE:'接続先に応答がありません。少し待ってからお試しください。',
};
export class ReaderApiError extends Error{
  constructor(code,status){
    const safe=Object.hasOwn(ERROR_MESSAGES,code)?code:'READER_SERVICE_UNAVAILABLE';
    super(ERROR_MESSAGES[safe]);this.name='ReaderApiError';this.code=safe;this.status=status;
  }
}
export class ReaderApiClient{
  #token=null;#expiresAt=0;
  constructor({fetcher=globalThis.fetch,now=Date.now}={}){this.fetcher=fetcher;this.now=now;}
  get connected(){return !!this.#token&&this.#expiresAt>this.now();}
  setConnection(value){
    if(!TOKEN.test(value?.token)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=this.now()||
       value.owner!=='nero_notelover')throw new ReaderApiError('READER_CONNECTION_FAILED');
    this.#token=value.token;this.#expiresAt=value.expiresAt;
  }
  clear(){this.#token=null;this.#expiresAt=0;}
  async request(path,{method='GET',body}={}){
    const allowed=method==='GET'?/^\/reader\/(?:status|candidates|like-status\?key=n[a-f0-9]{8,32})$/.test(path):
      method==='POST'&&/^\/reader\/(?:exchange|logout|candidates\/start|candidates\/next|like)$/.test(path);
    if(!allowed)throw new ReaderApiError('INVALID_INPUT');
    const exchange=path==='/reader/exchange';
    if(!exchange&&!this.connected)throw new ReaderApiError('READER_AUTH_REQUIRED',401);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{
      const response=await this.fetcher(READER_API_ORIGIN+path,{
        method,cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal,
        headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),
          ...(!exchange?{Authorization:'Bearer '+this.#token}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
      });
      const raw=await response.text();
      if(raw.length>300000)throw new ReaderApiError('READER_SERVICE_UNAVAILABLE');
      let value;try{value=JSON.parse(raw);}catch{throw new ReaderApiError('READER_SERVICE_UNAVAILABLE');}
      if(!response.ok||value?.ok!==true){
        if(response.status===401)this.clear();
        throw new ReaderApiError(response.status===401?'READER_AUTH_REQUIRED':value?.code,response.status);
      }
      return value;
    }catch(error){if(error instanceof ReaderApiError)throw error;throw new ReaderApiError('READER_SERVICE_UNAVAILABLE');}
    finally{clearTimeout(timer);}
  }
}
export function verifiedConnectionMessage(event,{popup,nonce}){
  const value=event?.data;
  return event?.origin===READER_API_ORIGIN&&event.source===popup&&!!popup&&
    value?.type==='ouji-reader-connected'&&value.nonce===nonce&&TOKEN.test(value.code)?value.code:null;
}
export function parseReaderCallback(hash){
  const params=new URLSearchParams(String(hash||'').replace(/^#/,''));
  const code=params.get('reader-code'),nonce=params.get('reader-nonce');
  return TOKEN.test(code)&&TOKEN.test(nonce)&&params.getAll('reader-code').length===1&&
    params.getAll('reader-nonce').length===1?{code,nonce}:null;
}
const b64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function connectionProof(){
  const verifier=b64url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce=b64url(crypto.getRandomValues(new Uint8Array(32)));
  return {nonce,verifier,createdAt:Date.now()};
}
function notice(error){return error instanceof ReaderApiError?error.message:ERROR_MESSAGES.READER_SERVICE_UNAVAILABLE;}
export function normalizeLikeResult(value){
  if(value?.liked===true)return 'liked';
  // An unconfirmed response never proves that the POST failed.
  return 'unknown';
}

export function mountLikeCandidates(host,{client=new ReaderApiClient()}={}){
  let storage,sessionStorage;
  try{storage=window.localStorage;}catch{}
  try{sessionStorage=window.sessionStorage;}catch{}
  let feed=null,loading=false,searching=false,connecting=false,authBusy=false,noteReady=false,destroyed=false;
  const sent=new Map(),pendingSends=new Set();
  const saved=readStorage(storage,CHECKED_KEY);
  const checked=new Set(Array.isArray(saved)?saved.filter(v=>typeof v==='string').slice(-2000):[]);
  host.replaceChildren();
  const connection=element('section','candidateConnection');
  const connect=element('button','secondary candidateConnect','王子のGitHubで接続');connect.type='button';
  const disconnect=element('button','secondary candidateDisconnect','接続を解除');disconnect.type='button';disconnect.hidden=true;
  const connectionStatus=element('p','candidateHint candidateConnectionStatus','候補一覧はそのまま読めます。検索とスキの送信は、最初に王子のGitHubで接続してください。');
  connection.append(connect,disconnect,connectionStatus);
  const controls=element('div','candidateControls');
  const search=element('button','primaryAction candidateSearch','候補を30人探す');search.type='button';
  const refresh=element('button','secondary candidateRefresh','↻ 最新候補を表示');refresh.type='button';
  controls.append(search,refresh);
  const instructions=element('p','candidateHint','候補一覧は自動で更新します。新しく探すときも、この画面の「候補を30人探す」から進められます。スキは押した記事に1件ずつ届けます。');
  const summary=element('section','candidateSummary'),count=element('strong','candidateCount','—'),meta=element('div','candidateMeta');
  summary.append(count,meta);
  const filter=element('label','candidateFilter'),onlyUnchecked=element('input');onlyUnchecked.type='checkbox';
  filter.append(onlyUnchecked,document.createTextNode('未確認の候補だけ表示'));
  const copy=element('button','secondary','未確認の記事URLをまとめてコピー');copy.type='button';copy.disabled=true;
  const localNote=element('p','candidateHint','確認済みは、このブラウザで付ける手動の記録です。「スキ送信済み」はサーバーで確認できた結果です。');
  const status=element('p','status candidateStatus','候補一覧を読み込んでいます…');status.setAttribute('role','status');
  const progress=element('p','candidateProgress');progress.hidden=true;progress.setAttribute('role','status');
  const list=element('section','candidateList');
  const actions=element('div','candidateTools');actions.append(filter,copy);
  const advanced=element('details','candidateAdvanced'),advancedTitle=element('summary',null,'接続できないとき');
  advanced.append(advancedTitle,link('GitHubで候補の更新を実行 ↗',CANDIDATE_WORKFLOW_URL));
  host.append(connection,controls,instructions,summary,actions,localNote,progress,status,list,advanced);

  function updateConnection(message){
    connect.textContent=connecting?'接続を準備しています…':client.connected?'GitHubで接続し直す':'王子のGitHubで接続';
    connect.disabled=connecting;disconnect.hidden=!client.connected;
    if(message)connectionStatus.textContent=message;
    else connectionStatus.textContent=client.connected?
      noteReady?'王子のnoteに接続済みです。この画面で候補を探し、1件ずつスキを届けられます。':'本人確認ができました。noteとの接続を準備しています。':
      '候補一覧はそのまま読めます。検索とスキの送信は、最初に王子のGitHubで接続してください。';
    search.disabled=searching||connecting;
  }
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
    if(Date.now()-Date.parse(feed.generatedAt)>DAY)notices.push('抽出から24時間以上経っています。「候補を30人探す」で更新できます。');
    if(!feed.complete)notices.push(REASONS[feed.reason]||'今回は30人未満の候補です。条件を満たした人だけを表示しています。');
    if(feed.rejected)notices.push('確認できない情報が含まれる候補を除外しました。');
    if(!notices.length)notices.push('30人の候補を表示しています。記事を読んで、気になる相手にスキを届けられます。');
    status.textContent=notices.join(' ');
  }
  function receiveStates(value){
    if(!value||typeof value!=='object')return;
    for(const [key,state] of Object.entries(value)){
      if(NOTE_KEY.test(key)&&['liked','unknown','attempting'].includes(state))sent.set(key,state==='liked'?'liked':'unknown');
    }
  }
  function applyFeed(value){
    const latest=normalizeLikeCandidatesFeed(value);
    if(!feed||Date.parse(latest.generatedAt)>=Date.parse(feed.generatedAt)){
      feed=latest;saveStorage(storage,CACHE_KEY,{...feed,summary:{scanned:feed.scanned}});
    }
    render();return latest;
  }
  async function checkLike(key,button,result){
    if(authBusy||pendingSends.has(key))return;
    if(!client.connected){updateConnection(ERROR_MESSAGES.READER_AUTH_REQUIRED);connect.focus();return;}
    button.disabled=true;
    try{
      const response=await client.request('/reader/like-status?key='+encodeURIComponent(key));
      sent.set(key,normalizeLikeResult(response));render();
      status.textContent=response.liked===true?'スキの送信を確認しました。':'スキの送信結果はまだ確認できません。note上で状態を確認してください。';
    }catch(error){result.textContent=notice(error);updateConnection();}
    finally{if(button.isConnected)button.disabled=false;}
  }
  async function sendLike(row,button,result){
    const key=row.articleUrl.split('/').at(-1);
    if(authBusy||pendingSends.has(key)||sent.has(key))return;
    if(!client.connected){updateConnection(ERROR_MESSAGES.READER_AUTH_REQUIRED);connect.focus();return;}
    if(!noteReady){updateConnection(ERROR_MESSAGES.NOTE_SESSION_REQUIRED);return;}
    pendingSends.add(key);button.disabled=true;button.textContent='送信中…';
    // Once a user starts a send, any ambiguous outcome must block resending.
    sent.set(key,'unknown');
    try{
      const response=await client.request('/reader/like',{method:'POST',body:{key}});
      sent.set(key,normalizeLikeResult(response));render();
      status.textContent=response.liked===true?'スキを届けました。':'送信結果を確認中です。再送せず、「送信結果を確認」から状態を確認できます。';
    }catch(error){
      if(error instanceof ReaderApiError&&error.status===401){sent.delete(key);noteReady=false;updateConnection(notice(error));}
      else {sent.set(key,'unknown');result.textContent='結果を確認できません。再送せず、note上の状態を確認してください。';}
      render();status.textContent=notice(error)+' 送信した可能性があるため、自動で再送しません。';
    }finally{pendingSends.delete(key);render();}
  }
  function render(){
    if(!feed)return;
    list.replaceChildren();updateCount();
    const visible=feed.candidates.filter(row=>!onlyUnchecked.checked||!checked.has(row.articleUrl));
    if(!visible.length){list.append(element('div','empty',feed.candidates.length?'表示中の候補はすべて確認済みです。':'今回の調査では、条件に合う候補が見つかりませんでした。'));return;}
    for(const row of visible){
      const key=row.articleUrl.split('/').at(-1),delivery=sent.get(key);
      const card=element('article','commentCard candidateCard'+(checked.has(row.articleUrl)?' candidateChecked':''));
      card.dataset.key=key;
      const header=element('div','commentHead'),person=link(row.name,row.profileUrl,'candidatePerson'),badge=element('span','badge','差 '+row.gap+'人');
      header.append(person,badge);
      const numbers=element('p','candidateNumbers','@'+row.user+' · フォロー '+row.following+' / フォロワー '+row.followers);
      const title=link(row.articleTitle,row.articleUrl,'articleTitle'),date=element('p','date',dateText(row.publishedAt)+' 公開');
      const links=element('div','actions candidateActions'),open=link('noteで記事を読む ↗',row.articleUrl);
      const send=element('button','primary candidateSend',pendingSends.has(key)?'送信中…':delivery==='liked'?'♥ スキ送信済み':delivery==='unknown'?'送信結果を確認中':'♡ スキを届ける');
      send.type='button';send.disabled=pendingSends.has(key)||!!delivery;
      const deliveryStatus=element('p','candidateDelivery');deliveryStatus.setAttribute('role','status');
      if(delivery==='liked')deliveryStatus.textContent='noteでスキ済みを確認しました。';
      else if(delivery==='unknown')deliveryStatus.textContent='結果が未確認のため、再送を止めています。';
      send.addEventListener('click',()=>void sendLike(row,send,deliveryStatus));
      const mark=element('label','candidateMark'),box=element('input');box.type='checkbox';box.checked=checked.has(row.articleUrl);
      box.setAttribute('aria-label',row.name+'の記事を確認済みにする');
      mark.append(box,document.createTextNode('確認済み'));
      box.addEventListener('change',()=>{
        if(box.checked)checked.add(row.articleUrl);else checked.delete(row.articleUrl);
        saveStorage(storage,CHECKED_KEY,[...checked].slice(-2000));card.classList.toggle('candidateChecked',box.checked);
        if(onlyUnchecked.checked&&box.checked)render();else updateCount();
      });
      links.append(send,open,mark);
      if(delivery==='unknown'&&!pendingSends.has(key)){
        const check=element('button','secondary candidateCheckDelivery','送信結果を確認');check.type='button';
        check.addEventListener('click',()=>void checkLike(key,check,deliveryStatus));links.append(check);
      }
      card.append(header,numbers,title,date,links,deliveryStatus);list.append(card);
    }
  }
  async function refreshFeed({quiet=false}={}){
    if(loading||searching||destroyed)return;
    loading=true;refresh.disabled=true;refresh.textContent='↻ 読み込み中…';copy.disabled=true;
    if(!quiet)status.textContent='最新の候補一覧を確認しています…';
    try{
      let latest;
      if(client.connected){
        try{
          const response=await client.request('/reader/candidates');
          receiveStates(response.states);
          if(response.report!==null&&response.generatedAt)latest=applyFeed(response);
        }catch(error){if(error.status===401){noteReady=false;updateConnection(notice(error));}}
      }
      if(!latest)latest=applyFeed(await fetchLikeCandidatesFeed({localUrl:new URL('./data/like-candidates.json',location.href).href}));
      describeFeed();
      if(Date.parse(latest.generatedAt)<Date.parse(feed.generatedAt))status.textContent+=' 表示中の新しい候補一覧を保持しました。';
    }catch{
      if(!quiet)status.textContent=feed?'最新の一覧を取得できませんでした。前回の候補を表示しています。少し待ってから再度お試しください。':'候補一覧を取得できませんでした。接続後「候補を30人探す」から検索できます。';
    }finally{
      loading=false;refresh.disabled=false;refresh.textContent='↻ 最新候補を表示';updateCount();
    }
  }
  async function connectionStatusRefresh(){
    const value=await client.request('/reader/status');
    noteReady=value.noteReady===true;updateConnection();
  }
  async function exchange(code,proof){
    const value=await client.request('/reader/exchange',{method:'POST',body:{code,verifier:proof.verifier}});
    client.setConnection(value);
    try{sessionStorage?.removeItem(PENDING_KEY);}catch{}
    await connectionStatusRefresh();await refreshFeed();
  }
  async function beginConnection(){
    if(connecting)return;
    connecting=true;authBusy=true;updateConnection();
    let proof;
    try{proof=connectionProof();}
    catch{connecting=false;authBusy=false;updateConnection(ERROR_MESSAGES.READER_CONNECTION_FAILED);return;}
    // The popup inherits this origin's sessionStorage at window.open. Save the
    // proof first so OAuth can recover even if GitHub removes window.opener.
    saveStorage(sessionStorage,PENDING_KEY,proof);
    // Open during the tap so mobile browsers do not block the OAuth popup.
    const popup=window.open('about:blank','ouji-reader-connect','popup,width=480,height=720');
    if(!popup){connecting=false;authBusy=false;updateConnection('接続画面を開けませんでした。ブラウザのポップアップ許可を確認してください。');return;}
    let cleanup=()=>{};
    try{
      const challenge=b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(proof.verifier))));
      const url=new URL(READER_API_ORIGIN+'/reader/connect');
      url.search=new URLSearchParams({nonce:proof.nonce,challenge}).toString();
      let exchanging=false;
      const finish=()=>{
        cleanup();connecting=false;authBusy=false;updateConnection();
      };
      const onMessage=async event=>{
        const code=verifiedConnectionMessage(event,{popup,nonce:proof.nonce});
        if(!code||exchanging)return;
        exchanging=true;cleanup();
        try{await exchange(code,proof);try{popup.close();}catch{}}
        catch(error){updateConnection(notice(error));}
        finally{connecting=false;authBusy=false;updateConnection(client.connected?undefined:ERROR_MESSAGES.READER_CONNECTION_FAILED);}
      };
      const closed=setInterval(()=>{if(popup.closed&&!exchanging){finish();}},700);
      const timeout=setTimeout(()=>{if(!exchanging){finish();updateConnection('接続の期限が切れました。もう一度GitHubで接続してください。');}},10*60*1000);
      cleanup=()=>{window.removeEventListener('message',onMessage);clearInterval(closed);clearTimeout(timeout);};
      window.addEventListener('message',onMessage);
      popup.location.href=url.href;
    }catch(error){cleanup();try{popup.close();}catch{}connecting=false;authBusy=false;updateConnection(notice(error));}
  }
  async function searchCandidates(){
    if(searching)return;
    if(!client.connected){updateConnection(ERROR_MESSAGES.READER_AUTH_REQUIRED);connect.focus();return;}
    if(!noteReady){try{await connectionStatusRefresh();}catch(error){updateConnection(notice(error));return;}}
    if(!noteReady){updateConnection(ERROR_MESSAGES.NOTE_SESSION_REQUIRED);return;}
    searching=true;search.disabled=true;refresh.disabled=true;progress.hidden=false;progress.textContent='候補を探しています…';
    try{
      let output=await client.request('/reader/candidates/start',{method:'POST',body:{}});
      let rounds=0;
      while(true){
        if(output?.ok!==true||typeof output.scanId!=='string'||typeof output.done!=='boolean')throw new ReaderApiError('READER_SERVICE_UNAVAILABLE');
        progress.textContent='確認 '+Number(output.scanned||0)+'人 / 候補 '+Number(output.candidateCount||0)+'人';
        if(output.done){
          if(!output.report)throw new ReaderApiError('READER_SERVICE_UNAVAILABLE');
          applyFeed(output.report);receiveStates(output.report.states);render();describeFeed();break;
        }
        if(++rounds>300)throw new ReaderApiError('READER_SERVICE_UNAVAILABLE');
        output=await client.request('/reader/candidates/next',{method:'POST',body:{scanId:output.scanId}});
      }
    }catch(error){status.textContent=notice(error)+(feed?' 前回の候補を保持しています。':'');updateConnection();}
    finally{searching=false;search.disabled=false;refresh.disabled=false;progress.hidden=true;updateCount();}
  }
  async function recoverCallback(){
    const callback=parseReaderCallback(location.hash);
    if(!callback)return;
    history.replaceState(null,'',location.pathname+location.search+'#like-candidates');
    const proof=readStorage(sessionStorage,PENDING_KEY);
    if(!proof||proof.nonce!==callback.nonce||!TOKEN.test(proof.verifier)||Date.now()-proof.createdAt>10*60*1000){
      updateConnection(ERROR_MESSAGES.READER_CONNECTION_FAILED);return;
    }
    connecting=true;authBusy=true;updateConnection();
    let failure;
    try{await exchange(callback.code,proof);}
    catch(error){failure=notice(error);}
    finally{connecting=false;authBusy=false;updateConnection(failure);}
  }
  onlyUnchecked.addEventListener('change',()=>{if(feed)render();});
  refresh.addEventListener('click',()=>void refreshFeed());
  search.addEventListener('click',()=>void searchCandidates());
  connect.addEventListener('click',()=>void beginConnection());
  disconnect.addEventListener('click',async()=>{
    try{await client.request('/reader/logout',{method:'POST',body:{}});}catch{}
    client.clear();noteReady=false;updateConnection();
  });
  copy.addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText(feed.candidates.filter(row=>!checked.has(row.articleUrl)).map(row=>row.articleUrl).join('\n'));status.textContent='未確認の記事URLをコピーしました。';}
    catch{status.textContent='コピーできませんでした。各記事のリンクから開いてください。';}
  });
  const active=()=>!document.hidden&&(!host.closest('.view')||host.closest('.view').classList.contains('active'));
  const onVisible=()=>{if(active())void refreshFeed({quiet:true});};
  const interval=setInterval(onVisible,60000);
  document.addEventListener('visibilitychange',onVisible);
  try{feed=normalizeLikeCandidatesFeed(readStorage(storage,CACHE_KEY));render();describeFeed();}catch{}
  updateConnection();void refreshFeed();void recoverCallback();
  return {destroy(){destroyed=true;clearInterval(interval);document.removeEventListener('visibilitychange',onVisible);client.clear();}};
}
