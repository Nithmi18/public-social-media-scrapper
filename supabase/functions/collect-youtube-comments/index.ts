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


export function normalizeComment(comment,replyCount=null) {
 const s=comment?.snippet;
 if(!comment?.id || !s?.publishedAt || typeof s.textDisplay!=='string') throw new SafeError('youtube_comment_missing_fields');
 return {external_id:comment.id,parent_external_id:s.parentId??null,
 text_content:s.textDisplay,author_display_name:s.authorDisplayName??null,
 author_channel_id:s.authorChannelId?.value??null,likes:count(s.likeCount),
 reply_count:replyCount,published_at:s.publishedAt,updated_at:s.updatedAt??null};
}
export async function commentApi(path,params,fetcher=fetch) {
 const url=new URL(`https://www.googleapis.com/youtube/v3/${path}`);
 for(const [k,v] of Object.entries({...params,key:required('YOUTUBE_API_KEY')})) url.searchParams.set(k,v);
 let response;
 try {response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(8000)});}
 catch {throw new SafeError('youtube_comments_network_or_timeout');}
 let data;
 try {data=await response.json();} catch {throw new SafeError('youtube_comments_invalid_response');}
 if(!response.ok) {
  const allowed=new Set(['commentsDisabled','videoNotFound','commentNotFound','invalidPageToken','quotaExceeded','dailyLimitExceeded','keyInvalid','forbidden']);
  const reason=data?.error?.errors?.[0]?.reason;
  throw new SafeError(allowed.has(reason)?`youtube_${reason}`:`youtube_comments_http_${response.status}`);
 }
 return data;
}
// One API page per step; persist state and rows atomically before the next step.
export async function nextCommentPage(videoId,previous,api=commentApi) {
 const state=structuredClone(previous), rows=[];
 if(state.pending_replies.length) {
  const job=state.pending_replies[0];
  let data;
  try {data=await api('comments',{part:'snippet',parentId:job.parent_id,maxResults:'100',textFormat:'plainText',...(job.page_token?{pageToken:job.page_token}:{})});}
  catch(e) {
   if(e.message==='youtube_commentNotFound') {state.pending_replies.shift();return {rows,state};}
   throw e;
  }
  for(const r of data.items??[]) rows.push(normalizeComment(r));
  if(data.nextPageToken) {
   if(data.nextPageToken===job.page_token) throw new SafeError('youtube_repeated_page_token');
   job.page_token=data.nextPageToken;
  } else state.pending_replies.shift();
 } else if(!state.threads_done) {
  const data=await api('commentThreads',{part:'snippet,replies',videoId,maxResults:'50',order:'time',textFormat:'plainText',...(state.thread_page_token?{pageToken:state.thread_page_token}:{})});
  for(const thread of data.items??[]) {
   const top=thread.snippet?.topLevelComment;
   const total=thread.snippet?.totalReplyCount??0;
   rows.push(normalizeComment(top,total));
   const included=thread.replies?.comments??[];
   for(const reply of included) rows.push(normalizeComment(reply));
   if(total>included.length && !state.pending_replies.some(j=>j.parent_id===top.id)) state.pending_replies.push({parent_id:top.id,page_token:null});
  }
  if(data.nextPageToken && data.nextPageToken===state.thread_page_token) throw new SafeError('youtube_repeated_page_token');
  state.thread_page_token=data.nextPageToken??null;
  state.threads_done=!data.nextPageToken;
 }
 return {rows:[...new Map(rows.map(r=>[r.external_id,r])).values()],state};
}
export async function handler(req) {
 if(!await authorized(req)) return json({error:'unauthorized'},401);
 if(req.method!=='POST') return json({error:'method_not_allowed'},405);
 let run,seen=0;
 try {
  if(Number(req.headers.get('content-length')||0)>2048) return json({error:'body_too_large'},413);
  const text=await req.text();if(text.length>2048)return json({error:'body_too_large'},413);
  let body;try{body=JSON.parse(text);}catch{return json({error:'invalid_json'},400);}
  if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body?.post_id))return json({error:'invalid_post_id'},400);
  required('YOUTUBE_API_KEY');
  const claim=await rpc('claim_comment_sync',{p_post:body.post_id});
  if(!claim)return json({error:'comment_collection_already_running'},409);
  run=claim.run_id;let state=claim.state;
  const deadline=Date.now()+85000;
  for(let step=0;step<20 && Date.now()<deadline-15000;step++) {
   if(state.threads_done && !state.pending_replies.length)break;
   const page=await nextCommentPage(claim.video_id,state);
   seen+=await rpc('save_comment_page',{p_run:run,p_comments:page.rows,p_state:page.state});
   state=page.state;
  }
  const status=state.threads_done && !state.pending_replies.length?'success':'partial';
  await rpc('finish_comment_sync',{p_run:run,p_status:status,p_error:null});
  return json({run_id:run,status,comments_processed:seen,resume_pending:status==='partial'});
 } catch(e) {
  const code=e instanceof SafeError?e.message:'internal_error';
  const unavailable=['youtube_commentsDisabled','youtube_videoNotFound'].includes(code);
  // An invalid persisted cursor restarts scanning safely; upserts prevent duplicates.
  if(run && code==='youtube_invalidPageToken') {
   try {
    await rpc('save_comment_page',{p_run:run,p_comments:[],p_state:{thread_page_token:null,threads_done:false,pending_replies:[]}});
    await rpc('finish_comment_sync',{p_run:run,p_status:'partial',p_error:code});
    return json({run_id:run,status:'partial',comments_processed:seen,resume_pending:true,warning:'pagination_reset'});
   } catch { /* ordinary failure handling below */ }
  }
  if(run)try{await rpc('finish_comment_sync',{p_run:run,p_status:unavailable?'unavailable':'failed',p_error:code});}catch{ /* stale lease is recoverable */ }
  return json({run_id:run,status:unavailable?'unavailable':'failed',error:code,comments_processed:seen},unavailable?200:500);
 }
}
if(globalThis.Deno)Deno.serve(handler);
