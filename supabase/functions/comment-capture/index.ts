// Backend for the comment capture extension.
//   GET  .../comment-capture/queue?days=7  -> channels and posts with new comments to read
//   POST .../comment-capture/capture       -> {shortcode, comments:[...]} read from a post page
// Every call sends x-capture-key (a key whose hash is in integration_clients with purpose 'capture').
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
  // No automatic mutation retries: a timeout may follow a committed transaction.
  const res=await fetch(`${required('SUPABASE_URL')}/rest/v1/${path}`,{
    method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)
  }).catch(()=>{throw new SafeError('database_network_or_timeout');});
  if(!res.ok) {
    // Surface the RPC's own exception names (invalid_capture_key, post_not_collected, ...).
    let message=''; try { message=(await res.json())?.message??''; } catch { /* ignore */ }
    throw new SafeError(/^[a-z_]{3,40}$/.test(message)?message:`database_http_${res.status}`);
  }
  const text=await res.text();
  return text?JSON.parse(text):null;
}
export const rpc = (name,args) => db(`rpc/${name}`,{method:'POST',body:args});

const statusFor = {invalid_capture_key:401,post_not_collected:404,invalid_shortcode:400,invalid_comments:400};

// Keep only the fields the database stores, with types it accepts.
export function cleanComment(c) {
  if(!c || typeof c!=='object') return null;
  const id=String(c.external_id??''), parent=c.parent_external_id==null?null:String(c.parent_external_id);
  const text=typeof c.text_content==='string'?c.text_content.trim():'';
  if(!/^\d{1,30}$/.test(id) || (parent!==null && !/^\d{1,30}$/.test(parent)) || !text) return null;
  if(typeof c.published_at!=='string' || !Number.isFinite(Date.parse(c.published_at))) return null;
  const likes=Number.isSafeInteger(c.likes) && c.likes>=0?c.likes:null;
  const author=typeof c.author_display_name==='string'?c.author_display_name.slice(0,100):null;
  return {external_id:id,parent_external_id:parent,text_content:text.slice(0,5000),author_display_name:author,likes,published_at:c.published_at};
}

export async function handler(req) {
  const key=req.headers.get('x-capture-key');
  if(!key || !/^[a-f0-9]{64}$/.test(key)) return json({error:'unauthorized'},401);
  const route=new URL(req.url).pathname.split('/').filter(Boolean).at(-1);
  try {
    if(req.method==='GET' && route==='queue') {
      const days=Number(new URL(req.url).searchParams.get('days')||7);
      if(!Number.isInteger(days) || days<1 || days>30) return json({error:'invalid_days'},400);
      return json(await rpc('comment_capture_queue',{p_key:key,p_days:days}));
    }
    if(req.method==='POST' && route==='capture') {
      if(Number(req.headers.get('content-length')||0)>2_000_000) return json({error:'body_too_large'},413);
      const text=await req.text(); if(text.length>2_000_000) return json({error:'body_too_large'},413);
      let body; try {body=JSON.parse(text);} catch {return json({error:'invalid_json'},400);}
      if(typeof body?.shortcode!=='string' || !/^[A-Za-z0-9_-]{5,64}$/.test(body.shortcode)) return json({error:'invalid_shortcode'},400);
      if(!Array.isArray(body.comments) || body.comments.length>2000) return json({error:'invalid_comments'},400);
      const unique=new Map();
      for(const c of body.comments.map(cleanComment)) if(c && !unique.has(c.external_id)) unique.set(c.external_id,c);
      const comments=[...unique.values()];
      const saved=await rpc('save_comment_capture',{p_key:key,p_shortcode:body.shortcode,p_comments:comments});
      return json({...saved,comments_received:body.comments.length,comments_skipped:body.comments.length-comments.length});
    }
    return json({error:'not_found'},404);
  } catch(error) {
    const code=error instanceof SafeError?error.message:'internal_error';
    return json({error:code},statusFor[code]??500);
  }
}
if(globalThis.Deno) Deno.serve(handler);
