import {parseStrict,isObject,evaluate,regressions,validateModel} from './core.mjs';

const now=()=>new Date().toISOString();
const record=data=>({id:crypto.randomUUID().replaceAll('-',''),created_at:now(),...data});
const text=(b,k,max=50000)=>{const v=b[k];if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error(k+' 必须是非空文本且长度不超过 '+max);return v.trim();};
const list=(b,k)=>{const a=b[k]??[];if(!Array.isArray(a)||a.some(x=>typeof x!=='string'||!x.trim()))throw new Error(k+' 必须是字符串数组');return [...new Set(a.map(x=>x.trim()))];};

export function createHandler(env,fetcher=fetch){
  const base=env('SUPABASE_URL'),service=env('SUPABASE_SERVICE_ROLE_KEY');
  const origins=(env('ALLOWED_ORIGINS')||'https://zzldbq.github.io').split(',').map(x=>x.trim());
  const allowedHosts=(env('MODEL_ALLOWED_HOSTS')||'api.deepseek.com').split(',').map(x=>x.trim());
  const modelKeys=(env('MODEL_KEY_NAMES')||'DEEPSEEK_API_KEY').split(',').map(x=>x.trim());
  const dailyLimit=Math.min(1000,Math.max(1,Number(env('DAILY_CALL_LIMIT')||100)));
  const defaultModel={id:'deepseek-default',name:'DeepSeek Flash',base_url:'https://api.deepseek.com',model:'deepseek-flash',key_env:'DEEPSEEK_API_KEY'};
  function clean(message){let out=String(message);for(const k of [...modelKeys,'SUPABASE_SERVICE_ROLE_KEY']){const v=env(k);if(v)out=out.split(v).join('[REDACTED]');}return out;}
  async function request(url,options={},max=4_000_000){
    const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(options.timeout||15000)});
    let bytes=0;const parts=[];const reader=response.body?.getReader();
    if(reader){try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>max)throw new Error('接口响应超过大小限制');parts.push(value);}}finally{await reader.cancel();}}
    const output=new Uint8Array(bytes);let pos=0;for(const p of parts){output.set(p,pos);pos+=p.length;}
    const raw=new TextDecoder().decode(output);
    if(!response.ok)throw new Error(clean(`HTTP ${response.status}: ${raw.slice(0,4000)}`));
    return raw?JSON.parse(raw):null;
  }
  const db=(path,method='GET',body)=>request(base+'/rest/v1/'+path,{method,headers:{apikey:service,Authorization:'Bearer '+service,'Content-Type':'application/json',Prefer:'return=representation'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const rpc=(name,args={})=>db('rpc/'+name,'POST',args);
  async function items(kind,filter=''){
    // Pagination avoids silent truncation at the Data API's default row cap.
    const rows=[];for(let offset=0;;offset+=500){const page=await db(`pp_entities?kind=eq.${kind}&select=data&order=created_at.asc,id.asc&limit=500&offset=${offset}${filter}`);rows.push(...page.map(x=>x.data));if(page.length<500)return rows;}
  }
  async function get(kind,id){if(typeof id!=='string'||!/^[a-zA-Z0-9-]+$/.test(id))throw new Error('记录标识无效');if(kind==='model'&&id===defaultModel.id){const rows=await db(`pp_entities?id=eq.${id}&kind=eq.model&select=data`);return rows[0]?.data||defaultModel;}
    const rows=await db(`pp_entities?id=eq.${id}&kind=eq.${kind}&select=data`);if(!rows[0])throw new Error('记录不存在或已删除');return rows[0].data;}
  async function save(kind,data){const x=record(data);const rows=await db('pp_entities?on_conflict=id','POST',[{id:x.id,kind,data:x}]);return rows[0]?.data||x;}
  async function update(kind,data){await db(`pp_entities?id=eq.${data.id}&kind=eq.${kind}`,'PATCH',{data});return data;}
  const saveExisting=(kind,data)=>data.id?update(kind,data):save(kind,data);
  function checkModel(m){validateModel(m,allowedHosts);if(!modelKeys.includes(m.key_env))throw new Error('密钥变量未获管理员批准');return m;}
  async function call(m,prompt){checkModel(m);const key=env(m.key_env);if(!key)throw new Error('未配置模型密钥：请在 Supabase Edge Function Secrets 设置 '+m.key_env);
    const p=await request(m.base_url.replace(/\/$/,'')+'/chat/completions',{method:'POST',timeout:60000,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:m.model,messages:[{role:'user',content:prompt}],temperature:0,max_tokens:4096})});
    const raw=p?.choices?.[0]?.message?.content;if(typeof raw!=='string')throw new Error('模型响应 content 不是文本');return raw;
  }
  function seed(pid){
    const prefix='你是虚构案件材料整理助手，只提取事实，不作法律判断。输出纯 JSON：evidence_complete（布尔）、amount（数字）、needs_more_material（布尔）。\n';
    const versions=[record({project_id:pid,number:'V1',note:'完整规则：保留缺失材料与零金额',text:prefix+'材料缺失时标记不完整且需补充；金额为0也保留字段。\n案件：{{case_input}}'}),record({project_id:pid,number:'V2',note:'故意简化规则，用于回归演示',text:prefix+'默认材料齐全；金额为0可用自然语言说明。\n案件：{{case_input}}'})];
    const cases=[['A 案 · 常见材料齐全','常见','虚构 A 案：材料齐全，金额100。',true,100,false],['B 案 · 多份材料','多材料','虚构 B 案：两份材料均完整，总金额250。',true,250,false],['C 案 · 缺失关键材料','缺失信息','虚构 C 案：金额80，缺少关键材料，需要补充。',false,80,true],['D 案 · 零金额边界','边界','虚构 D 案：材料齐全，金额为0，仍需结构化输出。',true,0,false]].map(([name,tag,input,a,b,c])=>record({project_id:pid,name,tag,input,suite:'虚构回归集',expected:{evidence_complete:a,amount:b,needs_more_material:c},required:['evidence_complete','amount','needs_more_material'],manual_fields:[]}));
    return {versions,cases};
  }
  async function bulk(entries){await db('pp_entities','POST',entries.map(([kind,data])=>({id:data.id,kind,data})));}
  async function report(id){
    const run=await get('run',id),results=await items('result','&data->>run_id=eq.'+id);
    const jobs=await db(`pp_jobs?run_id=eq.${id}&state=eq.done&select=result&limit=200`);results.push(...jobs.map(x=>x.result));
    const r={...run,results,reviews:await items('review','&data->>run_id=eq.'+id),regressions:{}};
    if(run.snapshot.versions.length===2)for(const m of run.snapshot.models)r.regressions[m.id]=regressions(results,run.snapshot.versions[0].id,run.snapshot.versions[1].id,m.id);
    return r;
  }
  async function executeOne(){
    const rows=await rpc('pp_claim_job');if(!rows.length){const active=await db('pp_jobs?state=in.(pending,running)&select=id&limit=1');return {worked:false,active:!!active.length};}
    const j=rows[0],{version,model,case:c}=j.job;
    const prompt=version.text.replaceAll('{{case_input}}',c.input),start=Date.now();
    const result={id:j.id,run_id:j.run_id,case_id:c.id,version_id:version.id,model_id:model.id,created_at:now(),raw:null,parsed:null,checks:[],error:null,status:'error',rendered_prompt:prompt};
    try{result.raw=await call(model,prompt);Object.assign(result,evaluate(result.raw,c));}catch(e){result.error=clean(e.message);}
    result.elapsed_ms=Date.now()-start;
    await rpc('pp_finish_job',{p_id:j.id,p_result:result});return {worked:true,run_id:j.run_id};
  }
  async function dispatch(path,b,user,member){
    if(path==='/api/state'){
      const [projects,versions,cases,models,runs]=await Promise.all(['project','version','case','model','run'].map(x=>items(x)));
      if(!models.some(x=>x.id===defaultModel.id))models.unshift(defaultModel);
      return {projects,versions,cases,models:models.map(m=>({...m,configured:modelKeys.includes(m.key_env)&&!!env(m.key_env)})),runs:runs.map(({snapshot,...r})=>r),account:{email:user.email,role:member.role}};
    }
    if(path==='/api/step')return executeOne();
    if(path.startsWith('/api/runs/'))return report(path.slice('/api/runs/'.length));
    if(path==='/api/projects')return save('project',{name:text(b,'name',150),goal:text(b,'goal'),requirements:text(b,'requirements'),created_by:user.id});
    if(path==='/api/seed'){
      await get('project',b.project_id);const existing=await db(`pp_entities?kind=in.(version,case)&data->>project_id=eq.${b.project_id}&limit=1`);if(existing.length)throw new Error('只可向空项目导入示例');
      const s=seed(b.project_id);await bulk([...s.versions.map(x=>['version',x]),...s.cases.map(x=>['case',x])]);return {ok:true};
    }
    if(path==='/api/demo'){
      const p=record({name:'虚构案件 · 云端版本回归演示',goal:'发现提示词简化造成的退化',requirements:'纯 JSON 提取完整性、金额及补充材料标记；不作法律判断',created_by:user.id});
      const s=seed(p.id),models=[{id:'demo-a',name:'演示模型 A（固定样例）',model:'fixture-a'},{id:'demo-b',name:'演示模型 B（固定样例）',model:'fixture-b'}];
      const run=record({project_id:p.id,source:'demo',status:'completed',completed:16,total:16,finished_at:now(),snapshot:{project:p,...s,models,adapter:'固定演示数据（未调用模型）',temperature:0}});
      const entries=[['project',p],...s.versions.map(x=>['version',x]),...s.cases.map(x=>['case',x]),['run',run]];
      for(const [mi,m] of models.entries())for(const [vi,v] of s.versions.entries())for(const [ci,c] of s.cases.entries()){
        const output={...c.expected};if(vi===1&&ci===2)Object.assign(output,{evidence_complete:true,needs_more_material:false});
        const raw=vi===1&&ci===3?'材料齐全，金额为零。':JSON.stringify(output);
        entries.push(['result',record({run_id:run.id,case_id:c.id,version_id:v.id,model_id:m.id,raw,...evaluate(raw,c),error:null,elapsed_ms:420+mi*160+ci*70,rendered_prompt:v.text.replaceAll('{{case_input}}',c.input)})]);
      }
      await bulk(entries);return p;
    }
    if(path==='/api/versions'||path==='/api/cases'){
      const kind=path.endsWith('versions')?'version':'case';await get('project',b.project_id);
      const old=b.id?await get(kind,b.id):{};if(old.id&&old.project_id!==b.project_id)throw new Error('记录不属于当前项目');
      const data={...old,project_id:b.project_id,updated_at:now(),updated_by:user.id};
      if(kind==='version'){
        Object.assign(data,{number:text(b,'number',60),note:text(b,'note',2000),text:text(b,'text')});
        if(!data.text.includes('{{case_input}}'))throw new Error('提示词必须包含 {{case_input}}');
      }else{
        const parsed=b.expected_json!==undefined?parseStrict(b.expected_json):{data:b.expected,numberTypes:{}};
        if(!isObject(parsed.data))throw new Error('预期结果必须是 JSON 对象');
        Object.assign(data,{name:text(b,'name',150),tag:text(b,'tag',150),suite:text(b,'suite',150),input:text(b,'input'),expected:parsed.data,expected_types:parsed.numberTypes,expected_json:b.expected_json,required:list(b,'required'),manual_fields:list(b,'manual_fields')});
      }
      return saveExisting(kind,data);
    }
    if(path==='/api/cases/delete'){await get('case',b.id);await db('pp_entities?id=eq.'+b.id+'&kind=eq.case','DELETE');return {ok:true};}
    if(path==='/api/models'){
      if(member.role!=='admin')throw new Error('只有管理员可以修改模型配置');
      const data={name:text(b,'name',100),base_url:text(b,'base_url',2000).replace(/\/$/,''),model:text(b,'model',150),key_env:text(b,'key_env',100)};checkModel(data);
      if(b.id){const old=await get('model',b.id);const existing=await db('pp_entities?id=eq.'+b.id+'&kind=eq.model');if(existing.length)return update('model',{...old,...data});return save('model',{...old,...data});}
      return save('model',data);
    }
    if(path==='/api/draft'){
      const m=await get('model',b.model_id);checkModel(m);if(!env(m.key_env))throw new Error('请先在云端 Secrets 配置 '+m.key_env);
      const prompt='请起草中文提示词正文供人工编辑，包含字面占位符 {{case_input}}；要求模型仅输出 JSON，不作无依据的法律判断。\n目标：'+text(b,'goal')+'\n要件：'+text(b,'elements')+'\n格式：'+text(b,'format');
      await rpc('pp_reserve',{p_bucket:'model_calls',p_amount:1,p_limit:dailyLimit});return {draft:await call(m,prompt)};
    }
    if(path==='/api/runs'){
      const p=await get('project',b.project_id);
      const [vs,cs,ms]=await Promise.all([Promise.all(list(b,'version_ids').map(id=>get('version',id))),Promise.all(list(b,'case_ids').map(id=>get('case',id))),Promise.all(list(b,'model_ids').map(id=>get('model',id)))]);
      if(vs.length<1||vs.length>2||!cs.length||!ms.length||vs.length*cs.length*ms.length>200)throw new Error('请选择 1–2 个版本、案件与模型，最多 200 次调用');
      if([...vs,...cs].some(x=>x.project_id!==p.id))throw new Error('案件和版本必须属于本项目');
      for(const m of ms){checkModel(m);if(!env(m.key_env))throw new Error('模型缺少云端密钥：'+m.key_env);}
      const run=record({project_id:p.id,source:'real',status:'running',total:vs.length*cs.length*ms.length,completed:0,created_by:user.id,snapshot:{project:p,versions:vs,cases:cs,models:ms,adapter:'Supabase LocalWorkflow v1（未接入 Agent Flow）',temperature:0,max_tokens:4096,timeout_seconds:60,validation:'strict-json-number-kinds-v1'}});
      const jobs=[];for(const v of vs)for(const m of ms)for(const c of cs)jobs.push({version:v,model:m,case:c});
      await rpc('pp_create_run',{p_run:run,p_jobs:jobs,p_limit:dailyLimit});return run;
    }
    if(path==='/api/reviews'){
      let result;try{result=await get('result',b.result_id);}catch{if(typeof b.result_id!=='string'||!/^[-a-f0-9]+$/.test(b.result_id))throw new Error('结果 ID 无效');const rows=await db('pp_jobs?id=eq.'+b.result_id+'&state=eq.done&select=result');result=rows[0]?.result;}
      if(!result)throw new Error('结果不存在');if(!['认可','不认可','需补充材料'].includes(b.conclusion))throw new Error('复核结论无效');
      return save('review',{run_id:result.run_id,result_id:result.id,conclusion:b.conclusion,note:text(b,'note',5000),reviewer_id:user.id,reviewer_email:user.email});
    }
    throw new Error('未知 API');
  }
  return async function handler(req){
    const origin=req.headers.get('Origin');
    const cors={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'};
    if(origin&&origins.includes(origin))cors['Access-Control-Allow-Origin']=origin;
    const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:cors});
    if(origin&&!origins.includes(origin))return response(403,{error:'来源未获批准'});
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    if(req.method!=='POST')return response(405,{error:'仅支持 POST'});
    try{
      if(!base||!service)throw new Error('云端环境尚未初始化');
      const token=req.headers.get('Authorization');if(!token?.startsWith('Bearer '))return response(401,{error:'请先登录'});
      let user;try{user=await request(base+'/auth/v1/user',{headers:{apikey:service,Authorization:token}});}catch{return response(401,{error:'登录已过期，请重新登录'});}
      if(!user?.id||!user.email||!user.email_confirmed_at)return response(403,{error:'需要已验证的登录邮箱'});
      const members=await db('pp_members?email=eq.'+encodeURIComponent(user.email.toLowerCase())+'&enabled=eq.true&select=role');
      if(!members[0])return response(403,{error:'账号未获准使用，请联系管理员添加成员'});
      const raw=await req.text();if(raw.length>1_000_000)return response(413,{error:'请求过大'});
      const input=parseStrict(raw).data;if(!isObject(input)||typeof input.path!=='string'||!isObject(input.body??{}))throw new Error('请求格式无效');
      return response(200,await dispatch(input.path,input.body||{},user,members[0]));
    }catch(e){return response(400,{error:clean(e.message)});}
  };
}
