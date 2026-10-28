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
  // Keep big integers exact through JSON and PostgreSQL bigint conversion.
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
// Never propagate provider error bodies, URLs or tokens to logs/callers.
export async function requestJson(url,init={},fetcher=fetch) {
  for(let attempt=0;attempt<2;attempt++) {
    let response;
    try { response=await fetcher(url,{...init,redirect:'error',signal:AbortSignal.timeout(8000)}); }
    catch { if(attempt===0) continue; throw new SafeError('upstream_network_or_timeout'); }
    if((response.status===429 || response.status>=500) && attempt===0) {
      const retry=Number(response.headers.get('Retry-After'));
      await new Promise(r=>setTimeout(r,Number.isFinite(retry)?Math.max(250,Math.min(retry*1000,2000)):500));
      continue;
    }
    if(!response.ok) throw new SafeError(`upstream_http_${response.status}`);
    try { return await response.json(); } catch { throw new SafeError('upstream_invalid_json'); }
  }
}
export async function db(path,{method='GET',body}={}) {
  let key=env('BACKEND_DB_KEY');
  if(!key) {
    try { key=JSON.parse(env('SUPABASE_SECRET_KEYS')||'{}').default; } catch { /* fail closed */ }
  }
  if(!key) key=env('SUPABASE_SERVICE_ROLE_KEY');
  if(!key) throw new SafeError('missing_backend_database_key');
  // New secret keys go on apikey only; legacy service JWT also needs Authorization.
  const headers={'apikey':key,'Content-Type':'application/json','Prefer':'return=representation'};
  if(!key.startsWith('sb_secret_')) headers.Authorization=`Bearer ${key}`;
  // No automatic mutation retries: a timeout may follow a committed transaction.
  const res=await fetch(`${required('SUPABASE_URL')}/rest/v1/${path}`,{
    method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)
  }).catch(()=>{throw new SafeError('database_network_or_timeout');});
  if(!res.ok) throw new SafeError(`database_http_${res.status}`);
  const text=await res.text();
  return text?JSON.parse(text):null;
}
export const rpc = (name,args) => db(`rpc/${name}`,{method:'POST',body:args});
export function normalizeIG(p) {
  if(!p.id || !p.timestamp || !p.permalink) throw new SafeError('instagram_missing_required_fields');
  return {external_id:String(p.id),url:p.permalink,title:null,caption:p.caption??null,
    media_type:(p.media_product_type==='REELS' || (p.media_type==='VIDEO' && /^https:\/\/(?:www\.)?instagram\.com\/reels?\//i.test(p.permalink)))?'REEL':p.media_type??null,published_at:p.timestamp,
    likes:count(p.like_count),comments:count(p.comments_count),views:count(p.view_count)};
}
export function normalizeYT(p) {
  if(!p.id || !p.snippet?.publishedAt) throw new SafeError('youtube_missing_required_fields');
  return {external_id:p.id,url:`https://www.youtube.com/watch?v=${encodeURIComponent(p.id)}`,
    title:p.snippet.title??null,caption:p.snippet.description??null,media_type:'VIDEO',
    published_at:p.snippet.publishedAt,likes:count(p.statistics?.likeCount),
    comments:count(p.statistics?.commentCount),views:count(p.statistics?.viewCount)};
}
// News outlets post ~60 times a day on Instagram, so the refresh window is set in
// days and the page cap only guards against runaway paging (50 posts a page).
const IG_REFRESH_DAYS=7, IG_MAX_PAGES=12;
// Daily Mirror uploads ~15 videos a day, so 14 days needs more than 4 pages of 50.
const YT_MAX_PAGES=8, YT_MAX_RECENT=400;
export async function instagram(channel,fetcher=fetch) {
  if(!/^[A-Za-z0-9_.]+$/.test(channel.handle)) throw new SafeError('invalid_instagram_handle');
  const version=required('META_GRAPH_VERSION');
  if(!/^v\d+\.\d+$/.test(version)) throw new SafeError('invalid_meta_graph_version');
  const caller=required('META_CALLER_IG_ID');
  if(!/^\d+$/.test(caller)) throw new SafeError('invalid_meta_caller_id');
  const posts=new Map(); let after=null, info, truncated=false;
  const cutoff=Date.now()-IG_REFRESH_DAYS*86400000;
  for(let page=0;page<IG_MAX_PAGES;page++) {
    const paging=after?`.after(${after})`:'';
    const fields=`business_discovery.username(${channel.handle}){id,username,name,biography,followers_count,media_count,media.limit(50)${paging}{id,caption,media_type,permalink,timestamp,like_count,comments_count,view_count}}`;
    const url=new URL(`https://graph.facebook.com/${version}/${caller}`);url.searchParams.set('fields',fields);
    const result=await requestJson(url,{headers:{Authorization:`Bearer ${required('META_ACCESS_TOKEN')}`}},fetcher);
    info=result.business_discovery;
    if(!info?.id) throw new SafeError('instagram_discovery_unavailable');
    const rows=info.media?.data??[];
    for(const p of rows) posts.set(String(p.id),normalizeIG(p));
    const next=info.media?.paging?.cursors?.after;
    // Never follow provider next URLs: reconstruct on the trusted API host.
    const hasNext=Boolean(rows.length && next);
    if(!hasNext) break;
    if(rows.length && rows.every(p=>Date.parse(p.timestamp)<cutoff)) break;
    if(!/^[A-Za-z0-9_=-]+$/.test(next)) throw new SafeError('invalid_instagram_cursor');
    after=next;
    if(page===IG_MAX_PAGES-1) truncated=true;
  }
  return {posts:[...posts.values()],external_id:String(info.id),
    metadata:{username:info.username,name:info.name,biography:info.biography},
    followers:count(info.followers_count),post_count:count(info.media_count),views:null,
    warnings:truncated?['instagram_page_cap_reached_recent_coverage_incomplete']:[]};
}
export async function youtube(channel,recentIds=[],fetcher=fetch) {
  const key=required('YOUTUBE_API_KEY');
  const get=async(path,params)=>{
    const u=new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    for(const [k,v] of Object.entries({...params,key})) u.searchParams.set(k,v);
    return requestJson(u,{},fetcher);
  };
  const lookup=channel.external_id?{id:channel.external_id}:{forHandle:channel.handle};
  const channelResult=await get('channels',{part:'snippet,statistics,contentDetails',...lookup});
  const c=channelResult.items?.[0];
  if(!c?.contentDetails?.relatedPlaylists?.uploads) throw new SafeError('youtube_channel_unavailable');
  const ids=new Set(recentIds); let pageToken='', truncated=false;
  const cutoff=Date.now()-14*86400000;
  for(let page=0;page<YT_MAX_PAGES;page++) {
    const data=await get('playlistItems',{part:'contentDetails',playlistId:c.contentDetails.relatedPlaylists.uploads,maxResults:'50',...(pageToken?{pageToken}:{})});
    for(const p of data.items??[]) if(p.contentDetails?.videoId) ids.add(p.contentDetails.videoId);
    if(!data.nextPageToken) break;
    if(data.items?.length && data.items.every(p=>Date.parse(p.contentDetails?.videoPublishedAt)<cutoff)) break;
    pageToken=data.nextPageToken;
    if(page===YT_MAX_PAGES-1) truncated=true;
  }
  const posts=[], all=[...ids];
  for(let i=0;i<all.length;i+=50) {
    const data=await get('videos',{part:'snippet,statistics',id:all.slice(i,i+50).join(',')});
    // Omitted videos may be private, unavailable or deleted; do not infer deletion.
    for(const p of data.items??[]) posts.push(normalizeYT(p));
  }
  return {posts,external_id:c.id,metadata:{name:c.snippet?.title},
    followers:c.statistics?.hiddenSubscriberCount?null:count(c.statistics?.subscriberCount),
    post_count:count(c.statistics?.videoCount),views:count(c.statistics?.viewCount),
    warnings:truncated?['youtube_page_cap_reached_recent_coverage_incomplete']:[]};
}

export async function handler(req) {
  if(!await authorized(req)) return json({error:'unauthorized'},401);
  if(req.method!=='POST') return json({error:'method_not_allowed'},405);
  let run;
  try {
    if(Number(req.headers.get('content-length')||0)>2048) return json({error:'body_too_large'},413);
    const text=await req.text(); if(text.length>2048) return json({error:'body_too_large'},413);
    let body; try {body=JSON.parse(text);} catch {return json({error:'invalid_json'},400);}
    if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body?.channel_id)) return json({error:'invalid_channel_id'},400);
    const channels=await db(`channels?id=eq.${body.channel_id}&select=*`);
    const channel=channels[0];
    if(!channel?.enabled) return json({error:'channel_disabled_or_missing'},404);
    run=await rpc('claim_collection',{p_channel:channel.id});
    if(!run) return json({error:'collection_already_running'},409);
    let payload;
    if(channel.platform==='instagram') payload=await instagram(channel);
    else if(channel.platform==='youtube') {
      const since=new Date(Date.now()-14*86400000).toISOString();
      const recent=await db(`posts?channel_id=eq.${channel.id}&published_at=gte.${encodeURIComponent(since)}&select=external_id&order=published_at.desc&limit=${YT_MAX_RECENT+1}`);
      payload=await youtube(channel,recent.slice(0,YT_MAX_RECENT).map(p=>p.external_id));
      if(recent.length>YT_MAX_RECENT) payload.warnings.push('youtube_recent_refresh_cap_reached');
    } else throw new SafeError('unsupported_platform');
    const seen=await rpc('finish_collection',{p_run:run,p_payload:payload});
    return json({run_id:run,status:payload.warnings.length?'partial':'success',posts_seen:seen,warnings:payload.warnings});
  } catch(error) {
    const code=error instanceof SafeError?error.message:'internal_error';
    // Failed ingest is atomic. Unknown commit outcomes are not overwritten.
    if(run) {
      try {await db(`runs?id=eq.${run}&status=eq.running`,{method:'PATCH',body:{status:'failed',finished_at:new Date().toISOString(),error_code:code}});} catch { /* lease expiry exposes interruption */ }
    }
    return json({error:code,...(run?{run_id:run}:{})},500);
  }
}
if(globalThis.Deno) Deno.serve(handler);

