// Shared by the Edge Function and Node tests. Strict JSON retains number kinds.
export function parseStrict(text) {
  if(typeof text!=='string')throw new Error('JSON 必须是文本');
  let i=0;const numberTypes={};
  const ws=()=>{while(/[ \t\r\n]/.test(text[i]||'')&&i<text.length)i++;};
  const fail=message=>{throw new Error(`${message}（位置 ${i}）`);};
  function string(){
    const start=i++;
    while(i<text.length){const c=text[i++];if(c==='"')return JSON.parse(text.slice(start,i));if(c==='\\')i++;}
    fail('字符串未闭合');
  }
  function value(path,depth){
    if(depth>100)fail('JSON 嵌套层级过深');ws();const c=text[i];
    if(c==='"')return string();
    if(c==='{'){
      i++;ws();const out={};if(text[i]==='}'){i++;return out;}
      while(true){ws();if(text[i]!=='"')fail('字段名必须用双引号');const k=string();
        if(Object.hasOwn(out,k))fail('JSON 字段重复：'+k);ws();if(text[i++]!==':')fail('缺少冒号');
        const v=value(path+'/'+k.replaceAll('~','~0').replaceAll('/','~1'),depth+1);
        Object.defineProperty(out,k,{value:v,enumerable:true,writable:true,configurable:true});ws();
        if(text[i]==='}'){i++;return out;}if(text[i++]!==',')fail('缺少逗号');
      }
    }
    if(c==='['){i++;ws();const out=[];if(text[i]===']'){i++;return out;}while(true){out.push(value(path+'/'+out.length,depth+1));ws();if(text[i]===']'){i++;return out;}if(text[i++]!==',')fail('缺少逗号');}}
    for(const [literal,v] of [['true',true],['false',false],['null',null]])if(text.startsWith(literal,i)){i+=literal.length;return v;}
    const match=/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if(match){i+=match[0].length;const n=Number(match[0]);if(!Number.isFinite(n))fail('数字超出有限范围');
      const kind=/[.eE]/.test(match[0])?'float':'int';if(kind==='int'&&!Number.isSafeInteger(n))fail('整数超出精确表示范围');numberTypes[path]=kind;return n;}
    fail('无效 JSON');
  }
  const data=value('',0);ws();if(i!==text.length)fail('JSON 后有多余内容');return {data,numberTypes};
}
export const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function same(a,b,path,at,bt){
  if(typeof a!==typeof b||Array.isArray(a)!==Array.isArray(b))return false;
  if(typeof a==='number')return a===b&&(at[path]||(Number.isInteger(a)?'int':'float'))===(bt[path]||(Number.isInteger(b)?'int':'float'));
  if(a===null||b===null||typeof a!=='object')return a===b;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&same(a[k],b[k],path+'/'+k.replaceAll('~','~0').replaceAll('/','~1'),at,bt));
}
export function evaluate(raw,c){
  let parsed,types;
  try{const p=parseStrict(raw);parsed=p.data;types=p.numberTypes;if(!isObject(parsed))throw new Error('顶层必须是 JSON 对象');}
  catch(e){return {status:'fail',parsed:null,checks:[{field:'$',status:'fail',reason:'JSON 解析失败：'+e.message}]};}
  const checks=[{field:'$',status:'pass',reason:'JSON 对象可解析'}];
  const expected=c.expected,manual=c.manual_fields||[];
  for(const field of [...new Set([...(c.required||[]),...Object.keys(expected),...manual])].sort()){
    const base={field,expected:expected[field],actual:parsed[field]};
    if(!Object.hasOwn(parsed,field))checks.push({...base,status:'fail',reason:'缺少必填字段'});
    else if(manual.includes(field))checks.push({...base,status:'review',reason:'业务结论或依据需人工复核'});
    else if(Object.hasOwn(expected,field)){
      const ok=same(expected[field],parsed[field],'/'+field.replaceAll('~','~0').replaceAll('/','~1'),c.expected_types||{},types);
      checks.push({...base,status:ok?'pass':'fail',reason:ok?'类型和值一致':'类型或值不匹配（数组顺序和整数/浮点数类型参与比较）'});
    }else checks.push({...base,status:'pass',reason:'必填字段存在；未设置值断言'});
  }
  if(!Object.keys(expected).length)checks.push({field:'$',status:'review',reason:'没有预期值断言，需人工复核'});
  return {parsed,checks,status:checks.some(x=>x.status==='fail')?'fail':checks.some(x=>x.status==='review')?'review':'pass'};
}
export function regressions(results,oldId,newId,modelId){
  const old=new Map(results.filter(x=>x.version_id===oldId&&x.model_id===modelId).map(x=>[x.case_id,x.status]));
  return results.filter(x=>x.version_id===newId&&x.model_id===modelId&&x.status==='fail'&&old.get(x.case_id)==='pass').map(x=>x.case_id);
}
export function validateModel(model,allowedHosts){
  const url=new URL(model.base_url);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port||!allowedHosts.includes(url.hostname))throw new Error('模型地址必须为管理员批准的 HTTPS 域名，且不含凭据、端口或查询参数');
  if(!/^[A-Z][A-Z0-9_]*(KEY|TOKEN)$/.test(model.key_env)||model.key_env.startsWith('SUPABASE_'))throw new Error('无效模型密钥变量名称');
  return model;
}
