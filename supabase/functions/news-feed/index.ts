// Read API for connected apps. Every call sends x-consumer-key (a key whose hash is in
// integration_clients with purpose 'feed').
//   GET .../news-feed/posts     posts from every platform with their latest counts
//   GET .../news-feed/comments  comment text (YouTube collected, Instagram captured)
//   GET .../news-feed/channels  tracked channels with their latest follower counts
// posts and comments are change feeds: pass back next_cursor to get what changed since,
// and upsert by id (a row comes again whenever it is refreshed).
export class SafeError extends Error {}
export const env = (name) => globalThis.Deno?.env.get(name) ?? globalThis.process?.env[name];
export function required(name) {
  const value = env(name);
  if (!value) throw new SafeError(`missing_${name}`);
  return value;
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
  // New secret keys go on apikey only; legacy service JWT also needs Authorization.
  const headers={'apikey':key,'Content-Type':'application/json','Prefer':'return=representation'};
  if(!key.startsWith('sb_secret_')) headers.Authorization=`Bearer ${key}`;
  const res=await fetch(`${required('SUPABASE_URL')}/rest/v1/${path}`,{
    method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)
  }).catch(()=>{throw new SafeError('database_network_or_timeout');});
  if(!res.ok) {
    let message=''; try { message=(await res.json())?.message??''; } catch { /* ignore */ }
    throw new SafeError(/^[a-z_]{3,40}$/.test(message)?message:`database_http_${res.status}`);
  }
  const text=await res.text();
  return text?JSON.parse(text):null;
}
export const rpc = (name,args) => db(`rpc/${name}`,{method:'POST',body:args});

const PLATFORMS=['instagram','youtube'];
const UUID=/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const START={time:'1970-01-01T00:00:00Z',id:'00000000-0000-0000-0000-000000000000'};
const statusFor={invalid_consumer_key:401};

class BadRequest extends Error {}
export function readCursor(cursor) {
  if(!cursor) return START;
  try {
    if(cursor.length>512) throw Error();
    const {time,id}=JSON.parse(atob(cursor));
    if(typeof time!=='string' || !Number.isFinite(Date.parse(time)) || !UUID.test(id)) throw Error();
    return {time,id};
  } catch { throw new BadRequest('invalid_cursor'); }
}
const makeCursor=(row)=>btoa(JSON.stringify({time:row.updated_at,id:row.id}));
function readLimit(u,max) {
  const limit=Number(u.searchParams.get('limit')||Math.min(100,max));
  if(!Number.isInteger(limit) || limit<1 || limit>max) throw new BadRequest('invalid_limit');
  return limit;
}
function readPlatform(u) {
  const platform=u.searchParams.get('platform');
  if(platform!==null && !PLATFORMS.includes(platform)) throw new BadRequest('invalid_platform');
  return platform;
}
function page(data,cursor,limit) {
  const last=data.at(-1);
  return {data,next_cursor:last?makeCursor(last):cursor,has_more:data.length===limit,
    delivery:'at_least_once_upsert_by_id',platforms:PLATFORMS};
}

export async function handler(req) {
  if(req.method!=='GET') return json({error:'method_not_allowed'},405);
  const key=req.headers.get('x-consumer-key');
  if(!key || !/^[a-f0-9]{64}$/.test(key)) return json({error:'unauthorized'},401);
  const u=new URL(req.url);
  const route=u.pathname.split('/').filter(Boolean).at(-1);
  try {
    if(route==='posts' || route==='news-feed') {
      const cursor=u.searchParams.get('cursor'), {time,id}=readCursor(cursor), limit=readLimit(u,100);
      const outlet=u.searchParams.get('outlet');
      if(outlet!==null && (outlet.length<1 || outlet.length>100)) throw new BadRequest('invalid_outlet');
      const data=await rpc('read_feed_posts',{p_key:key,p_after_time:time,p_after_id:id,p_limit:limit,
        p_platform:readPlatform(u),p_outlet:outlet});
      return json(page(data,cursor,limit));
    }
    if(route==='comments') {
      const cursor=u.searchParams.get('cursor'), {time,id}=readCursor(cursor), limit=readLimit(u,500);
      const postId=u.searchParams.get('post_id');
      if(postId!==null && !UUID.test(postId)) throw new BadRequest('invalid_post_id');
      const data=await rpc('read_feed_comments',{p_key:key,p_after_time:time,p_after_id:id,p_limit:limit,
        p_platform:readPlatform(u),p_post_id:postId});
      return json(page(data,cursor,limit));
    }
    if(route==='channels') return json({data:await rpc('read_feed_channels',{p_key:key}),platforms:PLATFORMS});
    return json({error:'not_found'},404);
  } catch(error) {
    if(error instanceof BadRequest) return json({error:error.message},400);
    const code=error instanceof SafeError?error.message:'internal_error';
    return json({error:code},statusFor[code]??500);
  }
}
if(globalThis.Deno) Deno.serve(handler);
