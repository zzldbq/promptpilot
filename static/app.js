'use strict';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty = v => JSON.stringify(v, null, 2);
const date = v => v ? new Date(v).toLocaleString('zh-CN') : '—';
const labels = {pass:'通过',fail:'失败',review:'待人工复核',error:'调用错误',running:'运行中',completed:'已完成',interrupted:'已中断'};
const badge = status => `<span class="pill ${esc(status)}">${esc(labels[status] || status)}</span>`;
let state, pid = localStorage.getItem('promptpilot.project'), page = 'home', currentRun = null, timer;
const pages = {home:'项目概览',versions:'提示词版本',cases:'案件测试集',models:'模型配置',run:'新建评测',reports:'评测报告'};
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await res.json(); if (!res.ok) throw new Error(data.error || '请求失败'); return data;
}
function notify(message, error=false){$('#notice').className=error?'error-note':'success-note';$('#notice').textContent=message;}
async function action(fn){try{await fn();}catch(e){notify(e.message,true);}}
function project(){return state.projects.find(p=>p.id===pid);}
function own(kind){return state[kind].filter(x=>x.project_id===pid);}
function options(items,label,selected=''){return items.map(x=>`<option value="${esc(x.id)}" ${x.id===selected?'selected':''}>${esc(x[label])}</option>`).join('');}
async function refresh(){state=await api('/api/state');if(!project())pid=state.projects[0]?.id||'';localStorage.setItem('promptpilot.project',pid);$('#projectSelect').innerHTML=state.projects.length?options(state.projects,'name',pid):'<option>请先创建项目</option>';}
function navigate(next){closeProjectDelete();closeSuite();closeDraft();clearTimeout(timer);page=next;$('#notice').textContent='';$('#heading').textContent=pages[page];$('#nav').innerHTML=Object.entries(pages).map(([k,v],i)=>`<button data-page="${k}" class="${page===k?'active':''}">${v}</button>`).join('');if(!project()&&!['home','models'].includes(page)){$('#content').innerHTML='<div class="card empty">请先创建项目。</div>';return;}({home:home,versions:versions,cases:cases,models:models,run:runForm,reports:reports})[page]();}
function home(){const p=project();$('#content').innerHTML=`${p?`<div class="stats"><div class="stat">提示词版本<strong>${own('versions').length}</strong></div><div class="stat">测试案件<strong>${own('cases').length}</strong></div><div class="stat">评测记录<strong>${own('runs').length}</strong></div></div><div class="card"><div class="row between"><h2>${esc(p.name)}</h2>${!state.account||state.account.role==='admin'?'<button id="deleteProject" class="danger">删除项目</button>':''}</div><p>${esc(p.goal)}</p><pre>${esc(p.requirements)}</pre><div class="row"><button data-page="versions">编辑提示词</button><button data-page="cases" class="secondary">管理案件</button><button data-page="reports" class="secondary">查看报告</button></div></div>`:'<div class="card empty">暂无项目。创建项目后，添加提示词和测试案件。</div>'}<div class="card"><h2>新建项目</h2><form id="projectForm"><label>项目名称<input name="name" required placeholder="例如：案件要素提取"></label><label>业务目标<textarea name="goal" required placeholder="说明要完成的任务"></textarea></label><label>输出要求<textarea name="requirements" required placeholder="说明输出格式和字段"></textarea></label><button>创建项目</button></form></div>`;
if($('#deleteProject'))$('#deleteProject').onclick=openProjectDelete;
$('#projectForm').onsubmit=e=>{e.preventDefault();action(async()=>{const p=await api('/api/projects',Object.fromEntries(new FormData(e.target)));pid=p.id;await refresh();navigate('home');notify('项目已创建。');});};}
function closeProjectDelete(){const d=$('#projectDeleteDialog');if(d){d.close();d.remove();}}
function openProjectDelete(){
  if(state.account&&state.account.role!=='admin')return;
  if(!state.features?.delete_project){toast('删除项目功能待启用',true,'请先完成数据库升级并更新云函数。');return;}
  const p=project();if(own('runs').some(r=>r.status==='running')){toast('暂时不能删除',true,'此项目有评测正在运行，请等待完成。');return;}
  const dialog=document.createElement('dialog');dialog.id='projectDeleteDialog';dialog.className='draft-dialog';
  dialog.innerHTML=`<div class="row between"><h2>删除项目</h2><button id="cancelProjectDelete" class="secondary" type="button">返回</button></div><p>将永久删除项目 <strong>${esc(p.name)}</strong>。</p><p>包括 ${own('versions').length} 个提示词版本、${own('cases').length} 个案件、${suiteNames().length} 个测试集、${own('runs').length} 次评测，以及相关输出和复核记录。此操作不可撤销。</p><p class="help">其他项目、模型配置和登录账号不受影响。</p><form id="projectDeleteForm"><label>输入完整项目名称以确认<input name="confirm_name" required autocomplete="off"></label><button id="confirmProjectDelete" class="danger" disabled>永久删除项目</button><span id="projectDeleteStatus" class="muted" role="status"></span></form>`;
  $('#content').appendChild(dialog);$('#cancelProjectDelete').onclick=closeProjectDelete;dialog.addEventListener('cancel',e=>{e.preventDefault();if(!$('#projectDeleteForm').dataset.busy)closeProjectDelete();});
  const form=$('#projectDeleteForm');form.elements.confirm_name.oninput=()=>{$('#confirmProjectDelete').disabled=form.elements.confirm_name.value!==p.name;};form.onsubmit=e=>{e.preventDefault();deleteProject(form,p);};dialog.showModal();
}
async function deleteProject(form,p){
  if(form.dataset.busy||form.elements.confirm_name.value!==p.name)return;
  const button=$('#confirmProjectDelete'),cancel=$('#cancelProjectDelete'),status=$('#projectDeleteStatus');
  form.dataset.busy='true';button.disabled=true;cancel.disabled=true;form.elements.confirm_name.disabled=true;status.textContent='正在删除中......';
  try{
    await api('/api/projects/delete',{id:p.id,confirm_name:form.elements.confirm_name.value});
    if(form!==$('#projectDeleteForm'))return;
    const runIds=new Set(state.runs.filter(r=>r.project_id===p.id).map(r=>r.id));
    state.projects=state.projects.filter(x=>x.id!==p.id);
    for(const k of ['versions','cases','suites','runs'])if(state[k])state[k]=state[k].filter(x=>x.project_id!==p.id);
    if(runIds.has(currentRun))currentRun=null;
    pid=state.projects[0]?.id||'';localStorage.setItem('promptpilot.project',pid);
    $('#projectSelect').innerHTML=state.projects.length?options(state.projects,'name',pid):'<option>请先创建项目</option>';
    closeProjectDelete();navigate('home');toast('项目已删除');
  }catch(e){if(form===$('#projectDeleteForm'))toast('删除失败',true,e.message);}
  finally{delete form.dataset.busy;button.disabled=false;cancel.disabled=false;form.elements.confirm_name.disabled=false;status.textContent='';}
}
let versionListPage=1;
function versionPage(items,index){const pages=Math.max(1,Math.ceil(items.length/10));const current=Math.max(1,Math.min(index,pages));return {pages,current,items:items.slice((current-1)*10,current*10)};}
function toast(message,error=false,detail=''){
  let host=$('#toastHost');if(!host){host=document.createElement('div');host.id='toastHost';host.className='toast-host';document.body.appendChild(host);}
  const dialog=$('#draftDialog')||$('#suiteDialog')||$('#projectDeleteDialog');if(dialog)dialog.appendChild(host);else document.body.appendChild(host);
  const item=document.createElement('div');item.className='toast '+(error?'toast-error':'toast-success');item.setAttribute('role',error?'alert':'status');
  item.innerHTML=`<div><strong>${esc(message)}</strong>${detail?`<p>${esc(detail)}</p>`:''}</div><button type="button" aria-label="关闭提示">×</button>`;
  item.querySelector('button').onclick=()=>item.remove();host.appendChild(item);setTimeout(()=>item.remove(),5000);
}
function closeDraft(){const dialog=$('#draftDialog');if(dialog){dialog.close();dialog.remove();}}
function versions(){
  versionListPage=1;
  $('#content').innerHTML=`<div id="versionWorkspace" class="version-workspace"><section class="card"><div class="row between"><h2>版本列表</h2><div class="row"><button id="newVersion" class="secondary">新建版本</button><button id="compareVersions" class="secondary">对比版本</button></div></div><div id="versionList"></div><div id="versionPagination" class="pagination"></div></section><section class="card"><div class="row between"><h2 id="editorHeading">新建提示词版本</h2><button id="openDraft" class="secondary">AI 起草提示词</button></div><form id="versionForm"><fieldset id="versionFields"><input type="hidden" name="id"><label>版本号<input name="number" required placeholder="V1 / V2"></label><label>修改说明<input name="note" required></label><label>提示词正文<textarea class="code" name="text" rows="18" required>请根据以下虚构案件提取信息，仅输出 JSON。\n案件：{{case_input}}</textarea></label><p class="help">保留 {{case_input}} 作为案件输入位置。</p></fieldset><div class="row"><button id="saveVersion">保存版本</button><span id="versionSaveStatus" class="muted" role="status"></span></div></form></section></div><section id="versionComparison" class="card" hidden></section>`;
  $('#newVersion').onclick=()=>{if($('#saveVersion').disabled)return;closeDraft();$('#versionForm').reset();$('#versionForm').elements.id.value='';$('#editorHeading').textContent='新建提示词版本';$('#openDraft').hidden=false;renderVersionList();};
  $('#openDraft').onclick=openDraft;
  $('#compareVersions').onclick=showVersionComparison;
  $('#versionForm').onsubmit=e=>{e.preventDefault();saveVersion(e.target);};
  renderVersionList();
}
function renderVersionList(){
  const vs=own('versions').slice().reverse(),p=versionPage(vs,versionListPage);versionListPage=p.current;
  const selected=$('#versionForm').elements.id.value;
  $('#versionList').innerHTML=p.items.map(v=>`<button class="version-item ${selected===v.id?'selected':''}" data-edit-version="${esc(v.id)}"><strong>${esc(v.number)}</strong><span>${esc(v.note)}</span><small>${date(v.created_at)}</small></button>`).join('')||'<p class="muted">暂无版本，请新建。</p>';
  $('#versionPagination').innerHTML=`<span>共 ${vs.length} 个版本</span><button type="button" id="versionsPrev" class="secondary" ${p.current===1?'disabled':''}>上一页</button><label class="page-picker">第 <select id="versionsPage">${Array.from({length:p.pages},(_,i)=>`<option value="${i+1}" ${i+1===p.current?'selected':''}>${i+1}</option>`).join('')}</select> / ${p.pages} 页</label><button type="button" id="versionsNext" class="secondary" ${p.current===p.pages?'disabled':''}>下一页</button>`;
  $('#versionsPrev').onclick=()=>{versionListPage--;renderVersionList();};$('#versionsNext').onclick=()=>{versionListPage++;renderVersionList();};$('#versionsPage').onchange=e=>{versionListPage=Number(e.target.value);renderVersionList();};
  document.querySelectorAll('[data-edit-version]').forEach(b=>b.onclick=()=>{
    if($('#saveVersion').disabled)return;closeDraft();const v=vs.find(x=>x.id===b.dataset.editVersion),f=$('#versionForm');
    ['id','number','note','text'].forEach(k=>f.elements[k].value=v[k]);$('#editorHeading').textContent='编辑 '+v.number;$('#openDraft').hidden=true;renderVersionList();
  });
}
function openDraft(){
  if($('#versionForm').elements.id.value||$('#saveVersion').disabled)return;
  const dialog=document.createElement('dialog');dialog.id='draftDialog';dialog.className='draft-dialog';
  dialog.innerHTML=`<div class="row between"><h2>AI 起草提示词</h2><button type="button" id="draftBack" class="secondary">返回</button></div><form id="draftForm"><label>模型<select name="model_id" required>${state.models.map(m=>`<option value="${esc(m.id)}" ${m.configured?'':'disabled'}>${esc(m.name)}${m.configured?'':'（未配置密钥）'}</option>`).join('')}</select></label><label>业务目标<textarea name="goal" required>${esc(project().goal)}</textarea></label><label>要件说明<textarea name="elements" required placeholder="填写提取规则和需要关注的情况"></textarea></label><label>输出格式<textarea name="format" required>${esc(project().requirements)}</textarea></label><button id="draftButton">生成提示词草稿</button><p class="help">生成后填入新建版本的正文，不自动保存。返回后不会再写入生成结果。</p></form>`;
  $('#content').appendChild(dialog);$('#draftBack').onclick=closeDraft;dialog.addEventListener('cancel',e=>{e.preventDefault();closeDraft();});$('#draftForm').onsubmit=e=>{e.preventDefault();generateDraft(e.target);};dialog.showModal();
}
function showVersionComparison(){
  closeDraft();const vs=own('versions');$('#versionWorkspace').hidden=true;const panel=$('#versionComparison');panel.hidden=false;
  panel.innerHTML=`<div class="row between"><h2>版本文本差异</h2><button id="comparisonBack" class="secondary">返回</button></div><div class="grid"><label>旧版本<select id="diffOld">${options(vs,'number')}</select></label><label>新版本<select id="diffNew">${options(vs,'number',vs[1]?.id)}</select></label></div><button id="diff" class="secondary" ${vs.length<2?'disabled':''}>查看差异</button><div id="diffOutput">${vs.length<2?'<p class="muted">至少保存两个版本后可进行对比。</p>':''}</div>`;
  $('#comparisonBack').onclick=()=>{panel.hidden=true;$('#versionWorkspace').hidden=false;};
  $('#diff').onclick=()=>{const a=vs.find(v=>v.id===$('#diffOld').value),b=vs.find(v=>v.id===$('#diffNew').value);if(!a||!b)return;if(a.id===b.id){$('#diffOutput').textContent='请选择两个不同的版本。';return;}$('#diffOutput').innerHTML=lineDiff(a.text,b.text);};
}
async function saveVersion(form){
  const button=$('#saveVersion'),status=$('#versionSaveStatus'),fields=$('#versionFields');if(button.disabled)return;
  const projectId=pid,payload={...Object.fromEntries(new FormData(form)),project_id:pid};
  button.disabled=true;fields.disabled=true;$('#openDraft').disabled=true;status.textContent='正在保存中......';
  const active=()=>pid===projectId&&form===$('#versionForm');
  try{
    const saved=await api('/api/versions',payload);
    if(!active())return;
    const index=state.versions.findIndex(v=>v.id===saved.id);if(index<0)state.versions.push(saved);else state.versions[index]=saved;
    form.elements.id.value=saved.id;$('#editorHeading').textContent='编辑 '+saved.number;$('#openDraft').hidden=true;
    if(!payload.id)versionListPage=1;renderVersionList();toast('保存成功');
  }catch(e){if(active())toast('保存失败',true,e.message);}
  finally{button.disabled=false;fields.disabled=false;status.textContent='';if(active())$('#openDraft').disabled=false;}
}

function lineDiff(a,b){const x=a.split('\n'),y=b.split('\n');if(x.length*y.length>500000)return `<div class="grid"><pre>${esc(a)}</pre><pre>${esc(b)}</pre></div>`;const dp=Array.from({length:x.length+1},()=>new Uint32Array(y.length+1));for(let i=x.length-1;i>=0;i--)for(let j=y.length-1;j>=0;j--)dp[i][j]=x[i]===y[j]?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);let i=0,j=0,out='';while(i<x.length||j<y.length){if(i<x.length&&j<y.length&&x[i]===y[j]){out+=`<div class="diff-line">  ${esc(x[i++])}</div>`;j++;}else if(j<y.length&&(i===x.length||dp[i][j+1]>=dp[i+1][j]))out+=`<div class="diff-line diff-add">+ ${esc(y[j++])}</div>`;else out+=`<div class="diff-line diff-remove">− ${esc(x[i++])}</div>`;}return `<p class="help">绿色 + 新增；红色 − 删除</p>${out}`;}
let caseListPage=1,caseSuiteFilter='';
function suiteNames(){return [...new Set([...(state.suites||[]).filter(s=>s.project_id===pid).map(s=>s.name),...own('cases').map(c=>c.suite)])].sort((a,b)=>a.localeCompare(b,'zh-CN'));}
function casePage(items,suite,index){return versionPage(items.filter(c=>!suite||c.suite===suite),index);}
function closeSuite(){const d=$('#suiteDialog');if(d){d.close();d.remove();}}
function cases(){
  caseListPage=1;caseSuiteFilter='';
  $('#content').innerHTML=`<div class="version-workspace"><section class="card"><div class="row between"><h2>测试案件</h2><div class="row"><button id="newSuite" class="secondary">新增测试集</button><button id="newCase" class="secondary">新增案件</button></div></div><label>测试集<select id="caseSuiteFilter"></select></label><div id="caseList"></div><div id="casePagination" class="pagination"></div></section><section class="card"><h2 id="caseHeading">新增案件</h2><form id="caseForm"><fieldset id="caseFields"><input name="id" type="hidden"><label>案件名称<input name="name" required></label><div class="grid"><label>场景标签<input name="tag" required placeholder="例如：缺失信息"></label><label>所属测试集<select name="suite" id="caseSuiteSelect" required></select></label></div><label>案件输入<textarea name="input" required rows="7"></textarea></label><label>预期结果（JSON）<textarea name="expected" class="code" required>{}</textarea></label><label>必填字段（逗号分隔）<input name="required" placeholder="例如 amount, conclusion"></label><label>需人工判断的字段（逗号分隔）<input name="manual_fields" placeholder="例如 conclusion"></label><p class="help">预期字段自动视为必填。人工字段只检查是否存在，内容需人工复核。</p></fieldset><div class="row"><button id="saveCase">保存案件</button><span id="caseSaveStatus" class="muted" role="status"></span></div></form></section></div>`;
  syncSuiteChoices();renderCaseList();
  $('#caseSuiteFilter').onchange=e=>{caseSuiteFilter=e.target.value;caseListPage=1;renderCaseList();};
  $('#newSuite').onclick=openSuite;
  $('#newCase').onclick=()=>{if($('#saveCase').disabled)return;resetCaseEditor();};
  $('#caseForm').onsubmit=e=>{e.preventDefault();saveCase(e.target);};
}
function syncSuiteChoices(selected){
  const names=suiteNames(),f=$('#caseForm');const current=selected??f.elements.suite.value;
  $('#caseSuiteFilter').innerHTML='<option value="">全部测试集</option>'+names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');$('#caseSuiteFilter').value=caseSuiteFilter;
  const choices=[...new Set([...names,...(current?[current]:[])])];if(!choices.length)choices.push('默认测试集');
  f.elements.suite.innerHTML=choices.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');f.elements.suite.value=choices.includes(current)?current:choices[0];
}
function resetCaseEditor(){const f=$('#caseForm');f.reset();f.elements.id.value='';syncSuiteChoices(caseSuiteFilter||suiteNames()[0]||'默认测试集');$('#caseHeading').textContent='新增案件';}
function renderCaseList(){
  const cs=own('cases').slice().reverse(),p=casePage(cs,caseSuiteFilter,caseListPage);caseListPage=p.current;
  const count=cs.filter(c=>!caseSuiteFilter||c.suite===caseSuiteFilter).length;
  $('#caseList').innerHTML=p.items.map(c=>`<details class="case-entry"><summary><span class="case-title">${esc(c.name)} <span class="pill">${esc(c.tag)}</span></span><span class="case-actions"><button type="button" class="secondary" data-edit-case="${esc(c.id)}">编辑</button><button type="button" class="danger" data-delete-case="${esc(c.id)}">删除</button></span></summary><p class="muted">测试集：${esc(c.suite)}</p><h4>案件输入</h4><pre>${esc(c.input)}</pre><h4>预期结果</h4><pre>${esc(c.expected_json||pretty(c.expected))}</pre></details>`).join('')||'<p class="muted">暂无案件，请新增案件。</p>';
  $('#casePagination').innerHTML=`<span>共 ${count} 个案件</span><button id="casesPrev" class="secondary" ${p.current===1?'disabled':''}>上一页</button><label class="page-picker">第 <select id="casesPage">${Array.from({length:p.pages},(_,i)=>`<option value="${i+1}" ${i+1===p.current?'selected':''}>${i+1}</option>`).join('')}</select> / ${p.pages} 页</label><button id="casesNext" class="secondary" ${p.current===p.pages?'disabled':''}>下一页</button>`;
  $('#casesPrev').onclick=()=>{caseListPage--;renderCaseList();};$('#casesNext').onclick=()=>{caseListPage++;renderCaseList();};$('#casesPage').onchange=e=>{caseListPage=Number(e.target.value);renderCaseList();};
  document.querySelectorAll('[data-edit-case]').forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();if($('#saveCase').disabled)return;const c=cs.find(x=>x.id===b.dataset.editCase),f=$('#caseForm');syncSuiteChoices(c.suite);['id','name','tag','suite','input'].forEach(k=>f.elements[k].value=c[k]);f.elements.expected.value=c.expected_json||pretty(c.expected);f.elements.required.value=c.required.join(', ');f.elements.manual_fields.value=c.manual_fields.join(', ');$('#caseHeading').textContent='编辑案件';});
  document.querySelectorAll('[data-delete-case]').forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();deleteCase(b);});
}
function openSuite(){
  if(!Array.isArray(state.suites)){toast('测试集功能待启用',true,'请先更新云端数据库和云函数，再刷新页面。');return;}
  const d=document.createElement('dialog');d.id='suiteDialog';d.className='draft-dialog';
  d.innerHTML='<div class="row between"><h2>新增测试集</h2><button id="suiteBack" type="button" class="secondary">返回</button></div><form id="suiteForm"><label>测试集名称<input name="name" maxlength="150" required autofocus placeholder="例如：材料完整性"></label><button id="createSuite">创建测试集</button><span id="suiteSaveStatus" class="muted" role="status"></span></form>';
  $('#content').appendChild(d);$('#suiteBack').onclick=closeSuite;d.addEventListener('cancel',e=>{e.preventDefault();if(!$('#createSuite').disabled)closeSuite();});$('#suiteForm').onsubmit=e=>{e.preventDefault();createSuite(e.target);};d.showModal();
}
async function createSuite(form){
  const name=form.elements.name.value.trim();if(!name){toast('创建失败',true,'请输入测试集名称。');return;}if(suiteNames().includes(name)){toast('创建失败',true,'项目内测试集名称不能重复。');return;}
  const projectId=pid,button=$('#createSuite');if(button.disabled)return;button.disabled=true;$('#suiteBack').disabled=true;$('#suiteSaveStatus').textContent='正在创建中......';
  try{const s=await api('/api/suites',{project_id:projectId,name});if(pid!==projectId||form!==$('#suiteForm'))return;state.suites.push(s);caseSuiteFilter=s.name;caseListPage=1;syncSuiteChoices();renderCaseList();closeSuite();toast('创建成功');}
  catch(e){if(pid===projectId&&form===$('#suiteForm'))toast('创建失败',true,e.message);}
  finally{button.disabled=false;if(form===$('#suiteForm')){$('#suiteBack').disabled=false;$('#suiteSaveStatus').textContent='';}}
}
async function saveCase(form){
  const button=$('#saveCase'),fields=$('#caseFields'),status=$('#caseSaveStatus'),projectId=pid;if(button.disabled)return;
  const data=Object.fromEntries(new FormData(form));data.expected_json=data.expected;delete data.expected;for(const k of ['required','manual_fields'])data[k]=data[k].split(/[,，]/).map(x=>x.trim()).filter(Boolean);
  const active=()=>pid===projectId&&form===$('#caseForm');button.disabled=true;fields.disabled=true;status.textContent='正在保存中......';
  try{const c=await api('/api/cases',{...data,project_id:projectId});if(!active())return;const i=state.cases.findIndex(x=>x.id===c.id);if(i<0)state.cases.push(c);else state.cases[i]=c;form.elements.id.value=c.id;$('#caseHeading').textContent='编辑案件';caseSuiteFilter=c.suite;caseListPage=Math.floor(own('cases').slice().reverse().filter(x=>x.suite===c.suite).findIndex(x=>x.id===c.id)/10)+1;syncSuiteChoices(c.suite);renderCaseList();toast('保存成功');}
  catch(e){if(active())toast('保存失败',true,e.message);}
  finally{button.disabled=false;fields.disabled=false;status.textContent='';}
}
async function deleteCase(button){
  if(button.disabled||$('#saveCase').disabled)return;
  if(!confirm('删除此测试案件？历史评测中的案件快照仍会保留。'))return;
  const id=button.dataset.deleteCase,projectId=pid,container=$('#caseList');button.disabled=true;
  try{
    await api('/api/cases/delete',{id});if(pid!==projectId||container!==$('#caseList'))return;
    const old=state.cases.find(c=>c.id===id);
    // Keep the old grouping visible even when this was its last case.
    if(Array.isArray(state.suites)&&old&&!state.suites.some(s=>s.project_id===pid&&s.name===old.suite))state.suites.push({project_id:pid,name:old.suite});
    state.cases=state.cases.filter(c=>c.id!==id);if($('#caseForm').elements.id.value===id)resetCaseEditor();syncSuiteChoices();renderCaseList();toast('删除成功');
  }catch(e){if(pid===projectId&&container===$('#caseList'))toast('删除失败',true,e.message);}
  finally{button.disabled=false;}
}

function models(){$('#content').innerHTML=`<div class="card hero"><h2>模型连接</h2><p>填写模型名称、接口地址和密钥变量名。</p><p class="help">在项目根目录复制 .env.example 为 .env，设置对应 API Key 后重启服务。页面仅填写环境变量名，不接收密钥。已配置只代表环境变量存在，可用性以实际调用为准。</p></div><div class="grid"><div class="card"><h2>模型配置</h2>${state.models.map(m=>`<details open><summary>${esc(m.name)} <span class="pill ${m.configured?'pass':'review'}">${m.configured?'密钥已配置（未验证连通）':'未配置密钥'}</span></summary><p>${esc(m.model)}</p><pre>${esc(m.base_url)}\n环境变量：${esc(m.key_env)}</pre><button class="secondary" data-edit-model="${m.id}">编辑配置</button></details>`).join('')}</div><div class="card"><h2>新增 / 编辑模型</h2><form id="modelForm"><input name="id" type="hidden"><label>显示名称<input name="name" required placeholder="模型名称"></label><label>Base URL<input name="base_url" type="url" required placeholder="https://provider.example/v1"></label><label>模型标识<input name="model" required placeholder="服务商提供的模型名称"></label><label>API Key 环境变量名<input name="key_env" required value="OPENAI_API_KEY" pattern="[A-Z][A-Z0-9_]*(KEY|TOKEN)"></label><button>保存配置</button> <button type="button" id="resetModel" class="secondary">清空 / 新增</button></form></div></div>`;
$('#resetModel').onclick=()=>{$('#modelForm').reset();$('#modelForm').elements.id.value='';};document.querySelectorAll('[data-edit-model]').forEach(b=>b.onclick=()=>{const m=state.models.find(x=>x.id===b.dataset.editModel);['id','name','base_url','model','key_env'].forEach(k=>$('#modelForm').elements[k].value=m[k]);});$('#modelForm').onsubmit=e=>{e.preventDefault();action(async()=>{await api('/api/models',Object.fromEntries(new FormData(e.target)));await refresh();navigate('models');notify('模型配置已保存。配置环境变量后重启服务。');});};}
function runForm(){const vs=own('versions'),cs=own('cases');$('#content').innerHTML=`<div class="card hero"><h2>评测设置</h2><p>选择版本、模型和案件后开始评测。</p></div><form id="runForm"><div class="grid"><div class="card"><h2>选择版本</h2><label>基线版本<select name="old">${options(vs,'number')}</select></label><label>候选版本<select name="next"><option value="">不比较版本（仅单版本 / 多模型）</option>${options(vs,'number',vs[1]?.id)}</select></label><h2>选择模型</h2>${state.models.map(m=>`<label class="choice"><input type="checkbox" name="models" value="${m.id}" ${m.configured?'':'disabled'}>${esc(m.name)} · ${esc(m.model)} ${m.configured?'':'（未配置 API Key）'}</label>`).join('')}<p class="help">可选择多个模型。未配置密钥的模型不可选。</p></div><div class="card"><h2>选择测试集与案件</h2><label>测试集<select id="suite"><option value="">请选择测试集</option>${suiteNames().map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select></label><div id="runCaseList"><p class="muted">请先选择测试集。</p></div><p class="help">可取消勾选个别案件；比较双方严格共用这一批案件快照。</p></div></div><button id="startRun">开始评测</button><p class="help">单次最多 200 次调用；单次请求超时 60 秒。关闭页面不会中止服务端评测。</p></form>`;
$('#startRun').disabled=true;
$('#suite').onchange=renderRunCases;
$('#runForm').onsubmit=e=>{e.preventDefault();action(async()=>{const f=new FormData(e.target),b=$('#startRun');b.disabled=true;try{const old=f.get('old'),next=f.get('next');if(next&&old===next)throw new Error('基线和候选版本应不同');const run=await api('/api/runs',{project_id:pid,version_ids:[old,next].filter(Boolean),model_ids:f.getAll('models'),case_ids:f.getAll('cases')});currentRun=run.id;await refresh();navigate('reports');}finally{b.disabled=false;}});};}
function renderRunCases(){
  const suite=$('#suite').value,cs=own('cases').filter(c=>c.suite===suite);
  $('#runCaseList').innerHTML=!suite?'<p class="muted">请先选择测试集。</p>':cs.length?`<p class="muted">共 ${cs.length} 个案件，可取消勾选不参与本次评测的案件。</p>${cs.map(c=>`<label class="choice"><input type="checkbox" name="cases" value="${esc(c.id)}" checked>${esc(c.name)} · ${esc(c.tag)}</label>`).join('')}`:'<p class="muted">此测试集暂无案件，请先到案件测试集页面添加。</p>';
  const update=()=>{$('#startRun').disabled=!document.querySelectorAll('#runCaseList input:checked').length;};
  document.querySelectorAll('#runCaseList input').forEach(c=>c.onchange=update);update();
}
function reports(){const runs=own('runs').slice().reverse();if(!runs.some(r=>r.id===currentRun))currentRun=runs[0]?.id;$('#content').innerHTML=`<div class="card"><div class="row between"><h2>评测历史</h2><button data-page="run">新建评测</button></div><select id="runSelect">${runs.map(r=>`<option value="${r.id}" ${r.id===currentRun?'selected':''}>${date(r.created_at)} · ${r.source==='demo'?'演示数据（未调用模型）':'真实模型运行'} · ${labels[r.status]} · ${r.completed}/${r.total} · ${r.id.slice(0,6)}</option>`).join('')||'<option>暂无评测记录</option>'}</select></div><div id="reportContent"></div>`;$('#runSelect').onchange=e=>switchReport(e.target);if(currentRun)action(loadReport);else $('#reportContent').innerHTML='<div class="card empty">暂无报告。完成一次评测后，可在这里查看结果。</div>';}
async function loadReport(){
if(page!=='reports')return;
if(reviewBusy()){timer=setTimeout(()=>action(loadReport),2000);return;}
const id=currentRun,container=$('#reportContent');
let r;try{r=await api('/api/runs/'+id);}catch(e){if(page==='reports'&&currentRun===id&&container===$('#reportContent')){container.textContent='报告加载失败，请重新选择或刷新。';throw e;}return;}
if(page!=='reports'||currentRun!==id||container!==$('#reportContent'))return;
if(reviewBusy()){timer=setTimeout(()=>action(loadReport),2000);return;}const s=r.snapshot;let cols=[];for(const m of s.models)for(const v of s.versions)cols.push({v,m});const regress=new Set(Object.values(r.regressions).flat());const resultsFor=(c,v,m)=>r.results.find(x=>x.case_id===c.id&&x.version_id===v.id&&x.model_id===m.id);
$('#reportContent').innerHTML=`${r.source==='demo'?'<div class="demo"><strong>演示数据 · 未调用任何真实模型</strong>　以下输出和耗时均为固定虚构样例，用于演示版本退化与多模型报告。</div>':'<p class="muted"></p>'}<div class="card"><div class="row between"><h2>评测概况 ${badge(r.status)}</h2><span>${r.completed} / ${r.total} 项</span></div>${r.error?`<p class="error-note">${esc(r.error)}</p>`:''}<p class="muted">开始 ${date(r.created_at)} · 结束 ${date(r.finished_at)} · ${esc(s.adapter)}</p><div class="scroll"><table><thead><tr><th>版本 / 模型</th><th>通过</th><th>失败</th><th>待复核</th><th>调用错误</th><th>平均耗时</th></tr></thead><tbody>${cols.map(({v,m})=>{const rs=r.results.filter(x=>x.version_id===v.id&&x.model_id===m.id);return `<tr><td><strong>${esc(v.number)}</strong> / ${esc(m.name)}</td>${['pass','fail','review','error'].map(k=>`<td>${rs.filter(x=>x.status===k).length}</td>`).join('')}<td>${rs.length?Math.round(rs.reduce((a,x)=>a+x.elapsed_ms,0)/rs.length)+' ms':'—'}</td></tr>`;}).join('')}</tbody></table></div></div><div class="card"><h2>退化案件 <span class="pill ${regress.size?'fail':'pass'}">${regress.size} 案</span></h2><p class="help">同一模型和案件中，旧版本通过、新版本未通过校验的结果。调用错误与待复核结果不计入。${r.status==='running'?'评测尚未完成，当前统计仅包含已返回的结果。':''}</p>${s.versions.length<2?'<p>本次仅选择一个版本，不做版本退化判断。</p>':regress.size? s.cases.filter(c=>regress.has(c.id)).map(c=>caseDetails(c,true)).join(''):'<p class="muted">当前已完成的结果中未发现明确退化。</p>'}</div><div class="card"><h2>逐案结果</h2>${s.cases.map(c=>caseDetails(c,false)).join('')}</div><details><summary>运行配置及输入快照（不含 API Key）</summary><pre>${esc(pretty(s))}</pre></details>`;
function caseDetails(c,reg){return `<details class="${reg?'regression':''}"><summary>${esc(c.name)} <span class="pill">${esc(c.tag)}</span>${reg?' · 旧版通过 → 新版失败':''}</summary><div class="grid"><div><h3>案件输入</h3><pre>${esc(c.input)}</pre></div><div><h3>预期结果</h3><pre>${esc(pretty(c.expected))}</pre><p class="help">必填：${esc(c.required.join(', '))} · 人工字段：${esc(c.manual_fields.join(', ')||'无')}</p></div></div><div class="output-grid">${cols.map(({v,m})=>resultCard(resultsFor(c,v,m),v,m)).join('')}</div></details>`;}
function resultCard(x,v,m){if(!x)return `<div class="result"><h3>${esc(v.number)} / ${esc(m.name)}</h3><p>${r.status==='running'?'等待调用':'无结果（运行中断）'}</p></div>`;return `<div class="result"><h3>${esc(v.number)} / ${esc(m.name)}</h3><div class="row">${badge(x.status)}<span class="muted">${x.elapsed_ms} ms · ${date(x.created_at)}</span></div>${x.error?`<pre class="error">${esc(x.error)}</pre>`:''}<h4>原始输出</h4><pre>${esc(x.raw??'未收到模型输出')}</pre><h4>具体校验项</h4><ul class="checks">${x.checks.map(c=>`<li class="${c.status}"><strong>${esc(c.field)} · ${labels[c.status]}</strong><br>${esc(c.reason)}${'expected'in c?`<br>预期：${esc(pretty(c.expected))}`:''}${'actual'in c?`<br>实际：${esc(pretty(c.actual))}`:''}</li>`).join('')||'<li>调用失败，未执行校验</li>'}</ul><details><summary>解析结果与填充后的提示词</summary><pre>${esc(pretty(x.parsed))}</pre><pre>${esc(x.rendered_prompt)}</pre></details><h4>人工复核记录</h4><div data-reviews="${x.id}">${r.reviews.filter(a=>a.result_id===x.id).map(reviewHtml).join('')||'<p class="muted">尚未复核</p>'}</div><form class="reviewForm" data-result="${x.id}"><label>复核结论<select name="conclusion"><option>认可</option><option>不认可</option><option>需补充材料</option></select></label><label>复核备注<textarea name="note" class="compact" required placeholder="记录依据，不覆盖原始输出"></textarea></label><button class="secondary">保存复核意见</button></form></div>`;}
document.querySelectorAll('.reviewForm').forEach(f=>f.onsubmit=e=>{e.preventDefault();action(async()=>{const review=await api('/api/reviews',{...Object.fromEntries(new FormData(f)),result_id:f.dataset.result});document.querySelectorAll(`[data-reviews="${f.dataset.result}"]`).forEach(el=>{if(el.querySelector('.muted'))el.innerHTML='';el.insertAdjacentHTML('beforeend',reviewHtml(review));});f.reset();notify('复核意见已保存。');});});
if(r.status==='running')timer=setTimeout(()=>action(loadReport),2000);
}

function reviewDirty(){return Array.from(document.querySelectorAll('.reviewForm')).some(f=>f.elements.note.value.trim()||f.elements.conclusion.value!=='认可');}
function reviewBusy(){return document.activeElement?.closest('.reviewForm')||reviewDirty();}
function switchReport(select){
  if(select.value===currentRun)return;
  if(reviewDirty()&&!confirm('当前报告有未保存的复核意见。放弃这些修改并切换报告？')){select.value=currentRun;return;}
  currentRun=select.value;
  clearTimeout(timer);
  $('#reportContent').textContent='正在加载所选报告…';
  action(loadReport);
}
async function generateDraft(form){
  const projectId=pid,editor=$('#versionForm'),button=$('#draftButton');
  const unchangedPage=()=>pid===projectId&&form===$('#draftForm')&&editor===$('#versionForm');
  const snapshot=()=>JSON.stringify(Object.fromEntries(new FormData(editor)));
  const original=snapshot();
  if(editor.elements.id.value)return;
  button.disabled=true;button.textContent='模型生成中…';
  try{
    const data=await api('/api/draft',Object.fromEntries(new FormData(form)));
    if(!unchangedPage())return;
    if(snapshot()!==original){
      let preview=$('#draftPreview');
      if(!preview){preview=document.createElement('div');preview.id='draftPreview';form.appendChild(preview);}
      preview.innerHTML='<label>生成的草稿（编辑器已修改，未自动覆盖）<textarea readonly rows="8"></textarea></label>';
      preview.querySelector('textarea').value=data.draft;
      return;
      return;
    }
    editor.elements.id.value='';
    $('#editorHeading').textContent='新建提示词版本';
    editor.elements.text.value=data.draft;
    if(!editor.elements.note.value)editor.elements.note.value='模型起草，待审核';
    closeDraft();
  }catch(e){if(unchangedPage())toast('生成失败',true,e.message);}
  finally{button.disabled=false;button.textContent='生成提示词草稿';}
}

function reviewHtml(a){return `<div class="review-entry"><strong>${esc(a.conclusion)}</strong> · ${date(a.created_at)}<p>${esc(a.note)}</p></div>`;}
document.addEventListener('click',e=>{const b=e.target.closest('[data-page]');if(b)navigate(b.dataset.page);});
$('#projectSelect').onchange=e=>{pid=e.target.value;localStorage.setItem('promptpilot.project',pid);currentRun=null;navigate(page);};
action(async()=>{await refresh();navigate('home');});
