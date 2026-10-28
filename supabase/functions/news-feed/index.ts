// Self-contained Supabase Edge Function: paste ALL of this into index.ts.
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
    media_type:p.media_product_type==='REELS'?'REEL':p.media_type??null,published_at:p.timestamp,
    likes:count(p.like_count),comments:count(p.comments_count),views:null};
}
export function normalizeYT(p) {
  if(!p.id || !p.snippet?.publishedAt) throw new SafeError('youtube_missing_required_fields');
  return {external_id:p.id,url:`https://www.youtube.com/watch?v=${encodeURIComponent(p.id)}`,
    title:p.snippet.title??null,caption:p.snippet.description??null,media_type:'VIDEO',
    published_at:p.snippet.publishedAt,likes:count(p.statistics?.likeCount),
    comments:count(p.statistics?.commentCount),views:count(p.statistics?.viewCount)};
}
export async function instagram(channel,fetcher=fetch) {
  if(!/^[A-Za-z0-9_.]+$/.test(channel.handle)) throw new SafeError('invalid_instagram_handle');
  const version=required('META_GRAPH_VERSION');
  if(!/^v\d+\.\d+$/.test(version)) throw new SafeError('invalid_meta_graph_version');
  const caller=required('META_CALLER_IG_ID');
  if(!/^\d+$/.test(caller)) throw new SafeError('invalid_meta_caller_id');
  const posts=new Map(); let after=null, info, truncated=false;
  const cutoff=Date.now()-14*86400000;
  for(let page=0;page<4;page++) {
    const paging=after?`.after(${after})`:'';
    const fields=`business_discovery.username(${channel.handle}){id,username,name,biography,followers_count,media_count,media.limit(50)${paging}{id,caption,media_type,permalink,timestamp,like_count,comments_count}}`;
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
    if(page===3) truncated=true;
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
  for(let page=0;page<4;page++) {
    const data=await get('playlistItems',{part:'contentDetails',playlistId:c.contentDetails.relatedPlaylists.uploads,maxResults:'50',...(pageToken?{pageToken}:{})});
    for(const p of data.items??[]) if(p.contentDetails?.videoId) ids.add(p.contentDetails.videoId);
    if(!data.nextPageToken) break;
    if(data.items?.length && data.items.every(p=>Date.parse(p.contentDetails?.videoPublishedAt)<cutoff)) break;
    pageToken=data.nextPageToken;
    if(page===3) truncated=true;
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
  if(req.method!=='GET') return json({error:'method_not_allowed'},405);
  const key=req.headers.get('x-consumer-key');
  if(!key || !/^[a-f0-9]{64}$/.test(key)) return json({error:'unauthorized'},401);
  const u=new URL(req.url),cursor=u.searchParams.get('cursor');
  let time='1970-01-01T00:00:00Z',id='00000000-0000-0000-0000-000000000000';
  try {
    if(cursor) {
      if(cursor.length>512) throw Error();
      const parsed=JSON.parse(atob(cursor));time=parsed.time;id=parsed.id;
      if(typeof time!=='string' || !Number.isFinite(Date.parse(time)) || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) throw Error();
    }
  } catch {return json({error:'invalid_cursor'},400);}
  const limit=Number(u.searchParams.get('limit')||50);
  if(!Number.isInteger(limit)||limit<1||limit>100) return json({error:'invalid_limit'},400);
  try {
    const data=await rpc('read_news_feed',{p_key:key,p_after_time:time,p_after_id:id,p_limit:limit});
    const last=data.at(-1);
    return json({data,next_cursor:last?btoa(JSON.stringify({time:last.first_seen_at,id:last.id})):cursor,
      delivery:'at_least_once_use_post_id_to_deduplicate',platforms:['instagram']});
  } catch {return json({error:'unauthorized_or_feed_unavailable'},401);}
}
if(globalThis.Deno) Deno.serve(handler);
