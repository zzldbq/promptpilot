import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseStrict,evaluate,regressions,validateModel} from '../supabase/functions/promptpilot/core.mjs';
import {createHandler} from '../supabase/functions/promptpilot/main.mjs';

test('cloud JSON rejects overflow, duplicate nested keys and unsafe integers',()=>{
  for(const raw of ['{"a":1e400}','{"a":NaN}','{"a":1,"a":2}','{"a":{"b":0,"b":1}}','{"a":9007199254740993}','{"a":1,}','{"a":01}','{} extra','[1,]','\u00a0{}'])assert.throws(()=>parseStrict(raw));
});
test('cloud JSON safely parses special keys, strings and nested values',()=>{
  const p=parseStrict('{"__proto__":{"polluted":true},"s":"quote\\\"end","a":[null,false,0]}').data;
  assert.equal({}.polluted,undefined);assert.equal(Object.hasOwn(p,'__proto__'),true);assert.deepEqual(p.a,[null,false,0]);assert.equal(p.s,'quote"end');
});
test('cloud comparisons preserve int versus float kind after persistence',()=>{
  const {data,numberTypes}=parseStrict('{"amount":80.0,"nested":{"x":1e0}}');
  const c=JSON.parse(JSON.stringify({expected:data,expected_types:numberTypes,required:[],manual_fields:[]}));
  assert.equal(evaluate('{"amount":80,"nested":{"x":1}}',c).status,'fail');
  assert.equal(evaluate('{"amount":80.0,"nested":{"x":1.0}}',c).status,'pass');
});
test('cloud field checks distinguish false, strings, arrays and missing fields',()=>{
  const c={expected:{ok:false,n:0,a:[1,2]},required:['extra'],manual_fields:[]};
  assert.equal(evaluate('{"ok":false,"n":0,"a":[1,2],"extra":null}',c).status,'pass');
  assert.equal(evaluate('{"ok":"false","n":0,"a":[2,1]}',c).checks.filter(x=>x.status==='fail').length,3);
});
test('cloud manual review and empty expectations cannot pass automatically',()=>{
  assert.equal(evaluate('{"conclusion":"different"}',{expected:{conclusion:'x'},manual_fields:['conclusion']}).status,'review');
  assert.equal(evaluate('{}',{expected:{},manual_fields:[]}).status,'review');
  assert.equal(evaluate('{}',{expected:{},manual_fields:['conclusion']}).status,'fail');
});
test('cloud malformed output remains serializable and traceable',()=>{
  for(const raw of ['text','[]','{"x":1e400}','```json\n{}\n```']){const r=evaluate(raw,{expected:{x:1}});assert.equal(r.status,'fail');assert.equal(r.parsed,null);JSON.stringify(r);}
});
test('cloud regression detection does not mix model or error results',()=>{
  const rows=[['C','old','a','pass'],['C','new','a','fail'],['D','old','a','pass'],['D','new','a','error'],['E','old','b','pass'],['E','new','a','fail']].map(([case_id,version_id,model_id,status])=>({case_id,version_id,model_id,status}));
  assert.deepEqual(regressions(rows,'old','new','a'),['C']);
});
test('model endpoints cannot send keys to arbitrary or insecure hosts',()=>{
  for(const base_url of ['http://api.deepseek.com','https://api.deepseek.com.evil.test','https://api.deepseek.com@evil.test','https://api.deepseek.com:8443','https://api.deepseek.com/?key=x','https://localhost'])assert.throws(()=>validateModel({base_url,key_env:'DEEPSEEK_API_KEY'},['api.deepseek.com']));
  assert.throws(()=>validateModel({base_url:'https://api.deepseek.com',key_env:'SUPABASE_SERVICE_ROLE_KEY'},['api.deepseek.com']));
});

const envValues={SUPABASE_URL:'https://project.test',SUPABASE_SERVICE_ROLE_KEY:'private-service-secret',DEEPSEEK_API_KEY:'private-model-secret'};
const user={id:'user-1',email:'member@example.test',email_confirmed_at:'2026-10-08T00:00:00Z'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const req=(path,body={},token='valid-user',origin='https://zzldbq.github.io')=>new Request('https://project.test/functions/v1/promptpilot',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({path,body})});
function harness({member=true,role='member',valid=true,verified=true,route}={}){
  const calls=[];
  const handler=createHandler(n=>envValues[n],async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/auth/v1/user'))return valid?json({...user,email_confirmed_at:verified?user.email_confirmed_at:null}):json({error:'bad token'},401);
    if(url.includes('/pp_members?'))return json(member?[{role}]:[]);
    if(route)return route(url,options);
    if(url.includes('/pp_entities?'))return json([]);
    throw new Error('Unexpected route '+url);
  });return {handler,calls};
}
test('anonymous callers cannot read state or trigger billing',async()=>{
  const h=harness();const response=await h.handler(req('/api/step',{},''));assert.equal(response.status,401);assert.equal(h.calls.length,0);
});
test('forged tokens are rejected before member lookup',async()=>{
  const h=harness({valid:false});assert.equal((await h.handler(req('/api/state'))).status,401);assert.equal(h.calls.length,1);
});
test('valid but unapproved accounts cannot access application data',async()=>{
  const h=harness({member:false});assert.equal((await h.handler(req('/api/state'))).status,403);assert.equal(h.calls.length,2);
});
test('unverified email cannot claim membership',async()=>{
  const h=harness({verified:false});assert.equal((await h.handler(req('/api/state'))).status,403);
});
test('foreign web origins are blocked before any auth or model call',async()=>{
  const h=harness();assert.equal((await h.handler(req('/api/state',{},'valid','https://evil.test'))).status,403);assert.equal(h.calls.length,0);
});
test('public configuration never includes service/model key values',async()=>{
  const h=harness();const r=await h.handler(req('/api/state'));assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes('private-model-secret'));assert.ok(!text.includes('private-service-secret'));assert.equal(JSON.parse(text).models[0].configured,true);
});
test('members cannot change model destination or secrets references',async()=>{
  const h=harness();const r=await h.handler(req('/api/models',{name:'x'}));assert.match((await r.json()).error,/只有管理员/);assert.equal(h.calls.length,2);
});
test('one queue claim calls one model and stores a deterministic result',async()=>{
  let result;const c={id:'c',input:'fictional',expected:{ok:true},required:['ok'],manual_fields:[]};
  const h=harness({route:(url,o)=>{
    if(url.endsWith('/rpc/pp_claim_job'))return json([{id:'job',run_id:'run',job:{case:c,version:{id:'v',text:'input {{case_input}}'},model:{id:'m',model:'deepseek-flash',base_url:'https://api.deepseek.com',key_env:'DEEPSEEK_API_KEY'}}}]);
    if(url==='https://api.deepseek.com/chat/completions'){assert.equal(o.redirect,'error');assert.equal(JSON.parse(o.body).messages[0].content,'input fictional');return json({choices:[{message:{content:'{"ok":true}'}}]});}
    if(url.endsWith('/rpc/pp_finish_job')){result=JSON.parse(o.body).p_result;return json(null);}
    throw new Error(url);
  }});
  const r=await h.handler(req('/api/step'));assert.equal(r.status,200);assert.equal(result.status,'pass');assert.equal(result.raw,'{"ok":true}');assert.equal(h.calls.filter(x=>x.url.startsWith('https://api.deepseek')).length,1);
});
test('provider failure remains an error with secrets redacted',async()=>{
  let result;const h=harness({route:(url,o)=>{
    if(url.endsWith('/rpc/pp_claim_job'))return json([{id:'job',run_id:'run',job:{case:{id:'c',input:'fictional'},version:{id:'v',text:'{{case_input}}'},model:{id:'m',model:'deepseek-flash',base_url:'https://api.deepseek.com',key_env:'DEEPSEEK_API_KEY'}}}]);
    if(url.includes('api.deepseek.com'))return json({error:'private-model-secret rejected'},401);
    if(url.endsWith('/rpc/pp_finish_job')){result=JSON.parse(o.body).p_result;return json(null);}
  }});await h.handler(req('/api/step'));assert.equal(result.status,'error');assert.equal(result.raw,null);assert.match(result.error,/401/);assert.ok(!result.error.includes('private-model-secret'));
});
