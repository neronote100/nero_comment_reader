// The ledger records only published introductions BY 王子, never incoming mentions.
// No private member subscription state, emails, or DMs are ever included.
const URL_PATTERN = /^https:\/\/note\.com\/nero_notelover\/n\/n[a-f0-9]+$/;
const USER_PATTERN = /^[a-zA-Z0-9_-]{2,80}$/;

export function parseIntroductions(payload) {
  if (!payload || payload.schema_version !== 1 ||
    !['backfill_pending','verified'].includes(payload.coverage) ||
    !Array.isArray(payload.records) || payload.records.length > 20000) {
    throw new Error('紹介履歴データの形式を確認してください');
  }
  const allowedRoot=new Set(['schema_version','coverage','reviewed_through','records']);
  if(Object.keys(payload).some(k=>!allowedRoot.has(k)))throw new Error('台帳に非公開項目が含まれています');
  const allowedFields=new Set(['id','member_name','member_note_id','introduced_at','published_url','source_article_url']);
  const ids = new Set(), pairs = new Set();
  const records = payload.records.map((raw,index)=>{
    if (!raw || typeof raw !== 'object') throw new Error('紹介履歴が不正です: '+index);
    if(Object.keys(raw).some(k=>!allowedFields.has(k)))throw new Error('紹介履歴に非公開項目が含まれています');
    const id=String(raw.id||'').trim(), memberName=String(raw.member_name||'').trim();
    const memberNoteId=String(raw.member_note_id||'').trim().toLowerCase();
    const introducedAt=String(raw.introduced_at||'').trim();
    const publishedUrl=String(raw.published_url||'').trim();
    const parsedDate=Date.parse(introducedAt+'T00:00:00Z');
    if (!id || id.length>120 || !memberName || memberName.length>140 ||
      !USER_PATTERN.test(memberNoteId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(introducedAt) ||
      !Number.isFinite(parsedDate) || new Date(parsedDate).toISOString().slice(0,10)!==introducedAt ||
      !URL_PATTERN.test(publishedUrl)) {
      throw new Error('紹介履歴の必須項目が不正です: '+(id||index));
    }
    const key=memberNoteId+'|'+publishedUrl;
    if(ids.has(id)||pairs.has(key))throw new Error('紹介履歴が重複しています: '+id);
    ids.add(id);pairs.add(key);
    const related=raw.source_article_url?String(raw.source_article_url):null;
    if(related&&!/^https:\/\/note\.com\/[a-zA-Z0-9_-]+\/n\/n[a-f0-9]+$/.test(related)) {
      throw new Error('元記事URLが不正です: '+id);
    }
    return {id,member_name:memberName,member_note_id:memberNoteId,
      member_url:'https://note.com/'+memberNoteId,
      introduced_at:introducedAt,published_url:publishedUrl,source_article_url:related};
  });
  return {schema_version:1,coverage:payload.coverage,
    reviewed_through:payload.reviewed_through??null,
    records:records.sort((a,b)=>b.introduced_at.localeCompare(a.introduced_at)||a.id.localeCompare(b.id))};
}

export function introductionSummary(records,today=new Date().toISOString().slice(0,10)) {
  const persons=new Map();
  for(const r of records) {
    const old=persons.get(r.member_note_id);
    if(!old||r.introduced_at>old.introduced_at)persons.set(r.member_note_id,r);
  }
  const ms=Date.parse(today+'T00:00:00Z');
  const stale=[...persons.values()].filter(r=>ms-Date.parse(r.introduced_at+'T00:00:00Z')>=30*86400000);
  return {introductions:records.length,people:persons.size,lastByPerson:persons,thirtyDaysOrMore:stale.length};
}

export function filteredIntroductions(records,query='',period='all',today=new Date().toISOString().slice(0,10)) {
  const q=String(query).toLocaleLowerCase('ja').trim();
  const todayMs=Date.parse(today+'T00:00:00Z');
  return records.filter(r=>{
    if(q&&!(r.member_name+' '+r.member_note_id).toLocaleLowerCase('ja').includes(q))return false;
    const days=(todayMs-Date.parse(r.introduced_at+'T00:00:00Z'))/86400000;
    return period==='recent'?days<30:period==='older'?days>=30:true;
  });
}

export function makeIntroductionDraft({member_name,member_note_id,introduced_at,published_url,source_article_url=''}) {
  const name=String(member_name||'').trim(),user=String(member_note_id||'').trim().toLowerCase();
  const date=String(introduced_at||'').trim();
  const url=String(published_url||'').trim().replace(/\/$/,'');
  const noteKey=url.split('/').at(-1);
  const record={id:user+'-'+noteKey,member_name:name,member_note_id:user,
    introduced_at:date,published_url:url,
    ...(source_article_url?{source_article_url:String(source_article_url).trim()}:{}),
  };
  parseIntroductions({schema_version:1,coverage:'backfill_pending',records:[record]});
  return record;
}

function makeElement(tag,className,label) {
  const el=document.createElement(tag);
  if(className)el.className=className;
  if(label!=null)el.textContent=label;
  return el;
}
const jpDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d)?d.replaceAll('-','/'):d;
export async function mountIntroductionHistory(host) {
  const status=host.querySelector('[data-intro-status]');
  const results=host.querySelector('[data-intro-results]');
  const search=host.querySelector('[data-intro-search]');
  const filter=host.querySelector('[data-intro-period]');
  const summary=host.querySelector('[data-intro-summary]');
  const refresh=host.querySelector('[data-intro-refresh]');
  const copy=host.querySelector('[data-intro-copy]');
  const draft=host.querySelector('[data-intro-draft]');
  const form=host.querySelector('[data-intro-form]');
  let dataset=null;
  function render() {
    if(!dataset)return;
    const rows=filteredIntroductions(dataset.records,search.value,filter.value);
    const stats=introductionSummary(dataset.records);
    summary.textContent='確認済み '+stats.introductions+'回 ／ '+stats.people+'人'
      +(dataset.coverage==='backfill_pending'?' ／ 過去分は照合中':' ／ 履歴の照合済み');
    results.replaceChildren();
    if(!rows.length){
      results.append(makeElement('p','empty',dataset.records.length
        ?'条件に一致する紹介履歴はありません。'
        :'まだ履歴が登録されていません。過去の紹介が0件という意味ではありません。'));
      return;
    }
    for(const record of rows){
      const card=makeElement('article','introCard');
      const top=makeElement('div','introCardHeader');
      const name=makeElement('a','introPerson',record.member_name);
      name.href=record.member_url;name.target='_blank';name.rel='noopener noreferrer';
      top.append(name,makeElement('span','introDate',jpDate(record.introduced_at)));
      card.append(top,makeElement('p','introNoteId','@'+record.member_note_id));
      const links=makeElement('div','introLinks');
      const pub=makeElement('a',null,'王子の紹介記事を見る ↗');
      pub.href=record.published_url;pub.target='_blank';pub.rel='noopener noreferrer';links.append(pub);
      if(record.source_article_url){
        const src=makeElement('a',null,'紹介した元記事 ↗');
        src.href=record.source_article_url;src.target='_blank';src.rel='noopener noreferrer';links.append(src);
      }
      card.append(links);results.append(card);
    }
  }
  async function load(){
    status.textContent='紹介履歴を確認しています…';refresh.disabled=true;
    try{
      const response=await fetch('./data/member-introductions.json?t='+Date.now(),{cache:'no-store'});
      if(!response.ok)throw new Error('HTTP '+response.status);
      dataset=parseIntroductions(await response.json());
      status.textContent='公開済みの紹介記事だけを記録。入退会・DM・購買情報はここに保存しません。'
        +(dataset.coverage==='backfill_pending'?' 過去の紹介記事は未照合です。':'');
      render();
    }catch(error){
      status.textContent='履歴の取得に失敗しました。前回確認した表示を維持します。';
      if(!dataset)results.replaceChildren(makeElement('p','empty','通信が回復したら再読込してください。'));
    }finally{refresh.disabled=false;}
  }
  if(!host.dataset.introBound){
    host.dataset.introBound='1';
    search.addEventListener('input',render);
    filter.addEventListener('change',render);
    refresh.addEventListener('click',load);
    copy.addEventListener('click',async()=>{
      if(!dataset)return;
      const lines=dataset.records.map(r=>[r.member_name,'@'+r.member_note_id,r.introduced_at,r.published_url].join(' | '));
      const text='王子がメンバーを紹介した確認済み履歴（未登録は未紹介と断定しない）\n'
        +lines.join('\n')+'\n照合状況: '+dataset.coverage;
      try{await navigator.clipboard.writeText(text);status.textContent='確認済みの履歴をコピーしました。';}
      catch{status.textContent='コピーできませんでした。ブラウザの権限を確認してください。';}
    });
    form.addEventListener('submit',async e=>{
      e.preventDefault();
      try{
        const record=makeIntroductionDraft(Object.fromEntries(new FormData(form)));
        const text='次の「王子がメンバーを紹介した」公開済み履歴を、'
          +'neronote100/nero_comment_reader の data/member-introductions.json に重複確認して追加し、'
          +'貯蔵庫への反映も確認してください。\n'+JSON.stringify(record,null,2);
        await navigator.clipboard.writeText(text);
        draft.textContent='追加用データをコピーしました。ChatGPTに貼り付けて登録を依頼してください。ここでは未保存です。';
      }catch(error){draft.textContent='入力内容を確認してください。公開済みの王子の記事URL、note ID、日付が必要です。';}
    });
  }
  // Always re-fetch: every introduction decision consults the same ledger.
  await load();
}
