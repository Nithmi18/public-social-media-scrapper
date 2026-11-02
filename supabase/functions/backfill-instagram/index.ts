// Pages back through an Instagram account's posts with Business Discovery, a few pages per
// call, and stores the posts published inside the channel's backfill window
// (public.instagram_backfills). The saved cursor lets each call carry on where the last
// stopped. Run it repeatedly (the 'instagram-backfill' cron job) until the job is done.
//
// Counts are the values Instagram shows today; Business Discovery has no history.
export class SafeError extends Error {}
export const env = (name) => globalThis.Deno?.env.get(name) ?? globalThis.process?.env[name];
export function required(name) {
  const value = env(name);
  if (!value) throw new SafeError(`missing_${name}`);
  return value;
}
export function count(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  return /^\d+$/.test(text) ? text : null;
}
export async function authorized(req) {
  const expected = env('COLLECTOR_SECRET');
  const actual = req.headers.get('x-collector-secret') || '';
  if (!expected || expected.length < 32 || !actual || actual.length > 1024) return false;
  const hash = async (v) => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));
  const a=await hash(actual), b=await hash(expected);
  let diff=0;
  for(let i=0;i<a.length;i++) diff |= a[i]^b[i];
  return diff===0;
}
export function json(body,status=200) {
  return Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
}
export async function db(path,{method='GET',body}={}) {
  let key=env('BACKEND_DB_KEY');
  if(!key) {
    try { key=JSON.parse(env('SUPABASE_SECRET_KEYS')||'{}').default; } catch { /* fail closed */ }
  }
  if(!key) key=env('SUPABASE_SERVICE_ROLE_KEY');
  if(!key) throw new SafeError('missing_backend_database_key');
  const headers={'apikey':key,'Content-Type':'application/json','Prefer':'return=representation'};
  if(!key.startsWith('sb_secret_')) headers.Authorization=`Bearer ${key}`;
  const res=await fetch(`${required('SUPABASE_URL')}/rest/v1/${path}`,{
    method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)
  }).catch(()=>{throw new SafeError('database_network_or_timeout');});
  if(!res.ok) throw new SafeError(`database_http_${res.status}`);
  const text=await res.text();
  return text?JSON.parse(text):null;
}
export const rpc = (name,args) => db(`rpc/${name}`,{method:'POST',body:args});
export function imageUrl(value,hosts) {
  if(typeof value!=='string' || value.length>2048) return null;
  try {
    const u=new URL(value);
    return u.protocol==='https:' && hosts.some(h=>u.hostname===h || u.hostname.endsWith(`.${h}`))?u.href:null;
  } catch { return null; }
}
const IG_IMAGE_HOSTS=['cdninstagram.com','fbcdn.net'];
// Same shape as the collector's normalizeIG, so backfilled rows match collected ones.
export function normalizeIG(p) {
  if(!p.id || !p.timestamp || !p.permalink) throw new SafeError('instagram_missing_required_fields');
  return {external_id:String(p.id),url:p.permalink,title:null,caption:p.caption??null,
    media_type:(p.media_product_type==='REELS' || (p.media_type==='VIDEO' && /^https:\/\/(?:www\.)?instagram\.com\/reels?\//i.test(p.permalink)))?'REEL':p.media_type??null,published_at:p.timestamp,
    likes:count(p.like_count),comments:count(p.comments_count),views:count(p.view_count),
    thumbnail_url:imageUrl(p.media_type==='VIDEO'?p.thumbnail_url:p.media_url??p.thumbnail_url,IG_IMAGE_HOSTS)};
}

// Meta's rate-limit error codes (app, user, page and Instagram business use case).
const RATE_LIMIT_CODES=new Set([4,17,32,613,80002]);
export class MetaError extends SafeError {
  constructor(code,status,pauseSeconds=0) { super(code); this.status=status; this.pauseSeconds=pauseSeconds; }
}
// Highest usage percentage Meta reports in its usage headers, and when it says access returns.
export function usage(headers) {
  let pct=0, regainMinutes=0;
  for(const name of ['x-app-usage','x-business-use-case-usage','x-ad-account-usage']) {
    const raw=headers.get(name); if(!raw || raw.length>8192) continue;
    let data; try { data=JSON.parse(raw); } catch { continue; }
    const entries=name==='x-business-use-case-usage'?Object.values(data).flat():[data];
    for(const e of entries) {
      if(!e || typeof e!=='object') continue;
      for(const k of ['call_count','total_time','total_cputime','acc_id_util_pct']) if(Number.isFinite(Number(e[k]))) pct=Math.max(pct,Number(e[k]));
      if(Number.isFinite(Number(e.estimated_time_to_regain_access))) regainMinutes=Math.max(regainMinutes,Number(e.estimated_time_to_regain_access));
    }
  }
  return {pct,regainMinutes};
}
// One Business Discovery request. Only Meta's numeric error code is kept, never its message.
export async function metaGet(url,fetcher=fetch) {
  let response;
  try { response=await fetcher(url,{headers:{Authorization:`Bearer ${required('META_ACCESS_TOKEN')}`},redirect:'error',signal:AbortSignal.timeout(15000)}); }
  catch { throw new MetaError('upstream_network_or_timeout',0); }
  const use=usage(response.headers);
  let body; try { body=await response.json(); } catch { body=null; }
  if(!response.ok) {
    const code=Number(body?.error?.code), sub=Number(body?.error?.error_subcode);
    const tag=`upstream_http_${response.status}${Number.isFinite(code)?`_code_${code}`:''}${Number.isFinite(sub)?`_${sub}`:''}`;
    if(RATE_LIMIT_CODES.has(code) || response.status===429) throw new MetaError(tag,response.status,Math.max(3600,use.regainMinutes*60));
    throw new MetaError(tag,response.status);
  }
  if(!body) throw new MetaError('upstream_invalid_json',response.status);
  return {body,use};
}

// Meta's usage meter counts requests, so bigger pages cover more posts per request.
// Instagram may refuse 100; the call then drops to 50 for the rest of the call.
const PAGE_SIZE=100, FALLBACK_PAGE_SIZE=50, MAX_PAGES_PER_CALL=6, TIME_BUDGET_MS=60000, USAGE_PAUSE_PCT=75;
function discoveryUrl(handle,{after=null,until=null,images=true,size=PAGE_SIZE}={}) {
  const version=required('META_GRAPH_VERSION');
  if(!/^v\d+\.\d+$/.test(version)) throw new SafeError('invalid_meta_graph_version');
  const caller=required('META_CALLER_IG_ID');
  if(!/^\d+$/.test(caller)) throw new SafeError('invalid_meta_caller_id');
  const mods=`${until?`.until(${until})`:''}.limit(${size})${after?`.after(${after})`:''}`;
  const fields=`business_discovery.username(${handle}){id,media${mods}{id,caption,media_type,permalink,timestamp,like_count,comments_count,view_count${images?',media_url,thumbnail_url':''}}}`;
  const url=new URL(`https://graph.facebook.com/${version}/${caller}`);url.searchParams.set('fields',fields);
  return url;
}

// Runs up to MAX_PAGES_PER_CALL pages for one channel's job. Returns a summary.
export async function runBackfill(channel,job,fetcher=fetch,save=rpc) {
  if(!/^[A-Za-z0-9_.]+$/.test(channel.handle)) throw new SafeError('invalid_instagram_handle');
  const start=Date.parse(job.window_start), end=Date.parse(job.window_end);
  const started=Date.now();
  let cursor=job.cursor, pages=0, stored=0, images=true, size=PAGE_SIZE, done=false, pause=0, note=null;
  // Ask Instagram to list posts from the window's end backwards. If it refuses until(),
  // the job pages back from the newest post instead; if it ignores it, nothing is lost.
  let useUntil=!String(job.note||'').includes('until_not_supported');
  while(pages<MAX_PAGES_PER_CALL && Date.now()-started<TIME_BUDGET_MS) {
    let result;
    try { result=await metaGet(discoveryUrl(channel.handle,{after:cursor,until:useUntil?Math.floor(end/1000):null,images,size}),fetcher); }
    catch(error) {
      const plain400=error instanceof MetaError && error.status===400 && !error.pauseSeconds;
      if(plain400 && size>FALLBACK_PAGE_SIZE) { size=FALLBACK_PAGE_SIZE; continue; }
      if(plain400 && useUntil) { useUntil=false; note='until_not_supported'; continue; }
      if(plain400 && images) { images=false; continue; }
      throw error;
    }
    const media=result.body.business_discovery?.media;
    if(!result.body.business_discovery?.id) throw new SafeError('instagram_discovery_unavailable');
    const rows=(media?.data??[]).filter(p=>p?.id && p.timestamp && p.permalink).map(normalizeIG);
    const times=rows.map(p=>Date.parse(p.published_at)).filter(Number.isFinite);
    const newest=times.length?new Date(Math.max(...times)).toISOString():null;
    const oldest=times.length?new Date(Math.min(...times)).toISOString():null;
    if(useUntil && job.pages_read===0 && pages===0) note=times.length && Math.max(...times)<end?'until_jumped_to_window':'until_ignored';
    const next=media?.paging?.cursors?.after??null;
    if(next && !/^[A-Za-z0-9_=-]{1,2048}$/.test(next)) throw new SafeError('invalid_instagram_cursor');
    const keep=rows.filter(p=>{const t=Date.parse(p.published_at);return t>=start && t<end;});
    const reachedStart=times.length>0 && Math.min(...times)<start;
    const ended=!next || rows.length===0;
    done=reachedStart || ended;
    const doneNote=reachedStart?'reached_window_start':ended?'instagram_returned_no_more_pages':null;
    stored+=await save('save_backfill_page',{p_channel:channel.id,p_posts:keep,p_cursor:done?cursor:next,p_scanned:rows.length,
      p_newest:newest,p_oldest:oldest,p_done:done,p_note:[note,doneNote].filter(Boolean).join(';')||null});
    note=null; pages++; cursor=next;
    if(done) break;
    if(result.use.pct>=USAGE_PAUSE_PCT) { pause=Math.max(900,result.use.regainMinutes*60); break; }
  }
  return {pages,stored,done,pause};
}

export async function handler(req) {
  if(!await authorized(req)) return json({error:'unauthorized'},401);
  if(req.method!=='POST') return json({error:'method_not_allowed'},405);
  let claimed=null;
  try {
    const text=await req.text(); if(text.length>2048) return json({error:'body_too_large'},413);
    let body; try {body=JSON.parse(text);} catch {return json({error:'invalid_json'},400);}
    if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body?.channel_id)) return json({error:'invalid_channel_id'},400);
    const channel=(await db(`channels?id=eq.${body.channel_id}&select=id,handle,platform,enabled`))[0];
    if(!channel || channel.platform!=='instagram') return json({error:'channel_missing'},404);
    const job=await rpc('claim_backfill',{p_channel:channel.id});
    if(!job) return json({status:'idle'});
    claimed=channel.id;
    const r=await runBackfill(channel,job);
    await rpc('release_backfill',{p_channel:channel.id,p_error:null,p_pause_seconds:r.pause||null});
    return json({status:r.done?'done':'running',pages:r.pages,posts_stored:r.stored,paused_seconds:r.pause});
  } catch(error) {
    const code=error instanceof SafeError?error.message:'internal_error';
    const pause=error instanceof MetaError?error.pauseSeconds||300:300;
    if(claimed) { try { await rpc('release_backfill',{p_channel:claimed,p_error:code,p_pause_seconds:pause}); } catch { /* lease expiry frees it */ } }
    return json({error:code},500);
  }
}
if(globalThis.Deno) Deno.serve(handler);
