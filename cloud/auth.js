'use strict';
(() => {
  const cfg=window.PROMPTPILOT_CONFIG,storageKey='promptpilot.cloud.session';
  let session=null,refreshing=null,worker=null,working=false,resolveReady;
  const ready=new Promise(r=>resolveReady=r);
  const status=message=>{document.querySelector('#cloudStatus').textContent=message;};
  const loginMessage=(message)=>{document.querySelector('#loginMessage').textContent=message;};
  async function http(path,body,token){
    const res=await fetch(cfg.url+path,{method:'POST',headers:{apikey:cfg.publishableKey,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(75000)});
    const raw=await res.text();let data;try{data=JSON.parse(raw);}catch{throw new Error('云端返回非 JSON 响应，请检查函数部署和网络');}
    if(!res.ok){const e=new Error(data.error_description||data.msg||data.error||data.message||'请求失败');e.status=res.status;throw e;}return data;
  }
  function persist(data){session={access_token:data.access_token,refresh_token:data.refresh_token,expires_at:data.expires_at||Math.floor(Date.now()/1000)+data.expires_in};sessionStorage.setItem(storageKey,JSON.stringify(session));}
  function showLogin(message){clearTimeout(worker);session=null;sessionStorage.removeItem(storageKey);document.body.classList.remove('cloud-ready');loginMessage(message||'请使用管理员为你创建的账号登录');}
  async function token(){
    if(!session)throw new Error('请先登录');
    if(session.expires_at>Date.now()/1000+90)return session.access_token;
    if(!refreshing)refreshing=http('/auth/v1/token?grant_type=refresh_token',{refresh_token:session.refresh_token}).then(persist).catch(e=>{showLogin('登录已过期，请重新登录');throw e;}).finally(()=>refreshing=null);
    await refreshing;return session.access_token;
  }
  async function request(path,body){
    const result=await http('/functions/v1/'+cfg.functionName,{path,body:body||{}},await token());
    if(path==='/api/state'){
      document.querySelector('#cloudAccount').textContent=result.account.email+' · '+(result.account.role==='admin'?'管理员':'试用成员');
      if(result.runs.some(r=>r.status==='running'))startWorker();
    }
    if(path==='/api/runs')startWorker();
    return result;
  }
  function startWorker(){if(!worker&&!working&&session)worker=setTimeout(pump,100);}
  async function pump(){
    worker=null;if(working||!session)return;working=true;
    status('云端评测执行中：请保持网页开启；离开后下次登录可继续待执行案件。');
    let again=false,delay=1000;
    try{const result=await request('/api/step',{});again=result.worked||result.active;if(!result.worked)delay=5000;if(!again)status('云端就绪 · 已完成结果已保存');}
    catch(e){status('评测连接暂时中断：'+e.message+'；将重试连接，不自动重复已领取的模型调用。');again=!!session;delay=20000;}
    finally{working=false;if(again&&session)worker=setTimeout(pump,delay);}
  }
  async function activate(){
    await request('/api/state');document.body.classList.add('cloud-ready');loginMessage('');resolveReady();
  }
  window.PromptPilotCloud={ready,request};
  document.addEventListener('DOMContentLoaded',()=>{
    document.querySelector('#cloudLoginForm').onsubmit=async e=>{
      e.preventDefault();const form=e.target,button=form.querySelector('button');button.disabled=true;loginMessage('正在登录…');
      try{const data=await http('/auth/v1/token?grant_type=password',{email:form.elements.email.value.trim(),password:form.elements.password.value});persist(data);form.elements.password.value='';await activate();}
      catch(error){showLogin(error.message==='Invalid login credentials'?'邮箱或密码不正确；请确认管理员已创建该账号。':error.message);}
      finally{button.disabled=false;}
    };
    document.querySelector('#cloudLogout').onclick=async()=>{
      const current=session;showLogin('已退出登录');if(current)try{await http('/auth/v1/logout?scope=local',{},current.access_token);}catch{}
      location.reload();
    };
    try{session=JSON.parse(sessionStorage.getItem(storageKey));}catch{sessionStorage.removeItem(storageKey);}
    if(session)activate().catch(e=>showLogin(e.message));
  });
})();
