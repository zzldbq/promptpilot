// Regression tests for actual app handlers with controllable delayed API responses.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8')
  .replace("action(async()=>{await refresh();navigate('home');});", '');

function setup(){
  const nodes = {'#projectSelect': {}, '#notice': {}, '#draftButton': {}, '#editorHeading': {}};
  let forms=[];
  const document={activeElement:null,addEventListener(){},querySelector:s=>nodes[s]||null,querySelectorAll:s=>s==='.reviewForm'?forms:[],createElement:()=>({querySelector:()=>({})})};
  const context=vm.createContext({document,localStorage:{getItem:()=>null},setTimeout:()=>1,clearTimeout(){},console,confirm:()=>false,FormData:class{
    constructor(f){this.f=f;}
    *[Symbol.iterator](){for(const [k,v] of Object.entries(this.f.elements))yield [k,v.value];}
  }});
  vm.runInContext(source,context);
  vm.runInContext("pid='project-a';page='reports';currentRun='run-a';",context);
  const editor={elements:{id:{value:''},number:{value:'V3'},text:{value:'original'},note:{value:'note'}},reset(){for(const v of Object.values(this.elements))v.value='';}};
  const form={elements:{goal:{value:'goal'}}};
  nodes['#versionForm']=editor;nodes['#draftForm']=form;
  let resolve,reject;
  context.api=()=>new Promise((a,b)=>{resolve=a;reject=b;});
  return {context,nodes,editor,form,document,setForms:v=>forms=v,resolve:v=>resolve(v),reject:e=>reject(e)};
}

test('late draft cannot write into a different project editor',async()=>{
  const h=setup(),pending=h.context.generateDraft(h.form);
  vm.runInContext("pid='project-b'",h.context);
  const other={elements:{text:{value:'project-b work'}}};h.nodes['#versionForm']=other;
  h.resolve({draft:'project-a draft'});await pending;
  assert.equal(other.elements.text.value,'project-b work');
  assert.equal(h.nodes['#notice'].textContent,undefined);
});
test('leaving and returning to same project still ignores the old request',async()=>{
  const h=setup(),pending=h.context.generateDraft(h.form);
  h.nodes['#draftForm']={elements:{}};
  h.resolve({draft:'obsolete'});await pending;
  assert.equal(h.editor.elements.text.value,'original');
});
test('editing while draft is pending preserves edits and displays separate draft',async()=>{
  const h=setup(),previewText={};
  h.nodes['#draftPreview']={querySelector:()=>previewText};
  const pending=h.context.generateDraft(h.form);
  h.editor.elements.text.value='manual edits';
  h.resolve({draft:'AI draft'});await pending;
  assert.equal(h.editor.elements.text.value,'manual edits');
  assert.equal(previewText.value,'AI draft');
});
test('unchanged editor receives draft normally',async()=>{
  const h=setup(),pending=h.context.generateDraft(h.form);
  h.resolve({draft:'AI draft'});await pending;
  assert.equal(h.editor.elements.text.value,'AI draft');
  assert.equal(h.editor.elements.id.value,'');
  assert.equal(h.editor.elements.number.value,'V3');
  assert.equal(h.editor.elements.note.value,'note');
  assert.equal(h.nodes['#draftButton'].disabled,false);
});

test('editing an existing version cannot invoke AI drafting',async()=>{
  const h=setup();h.editor.elements.id.value='v1';let called=false;h.context.api=()=>{called=true;};
  await h.context.generateDraft(h.form);assert.equal(called,false);
});
test('pagination clamps boundaries and shows ten versions at a time',()=>{
  const h=setup(),items=Array.from({length:203},(_,i)=>i);
  const first=h.context.versionPage(items,0),last=h.context.versionPage(items,99);
  assert.equal(first.current,1);assert.equal(first.items.length,10);
  assert.equal(last.current,21);assert.equal(last.items.length,3);assert.equal(last.items[0],200);
  assert.equal(h.context.versionPage([],8).current,1);
});
test('case pagination filters before paging and clamps after deletion',()=>{
  const h=setup(),rows=Array.from({length:31},(_,i)=>({id:i,suite:i<21?'甲':'乙'}));
  const result=h.context.casePage(rows,'甲',3);assert.equal(result.items.length,1);assert.equal(result.items[0].id,20);
  const after=h.context.casePage(rows.filter(c=>c.id!==20),'甲',3);assert.equal(after.current,2);assert.equal(after.items.length,10);
  assert.equal(h.context.casePage(rows,'空集',5).items.length,0);
});
test('suite choices merge persisted empty suites with legacy case groups by project',()=>{
  const h=setup();vm.runInContext("state={suites:[{project_id:'project-a',name:'空集'},{project_id:'other',name:'其他项目'}],cases:[{project_id:'project-a',suite:'旧分组'},{project_id:'project-a',suite:'旧分组'}]}",h.context);
  const names=Array.from(h.context.suiteNames());assert.equal(names.length,2);assert.ok(names.includes('空集'));assert.ok(names.includes('旧分组'));
});
test('return from AI ignores late response without clearing new-version fields',async()=>{
  const h=setup(),pending=h.context.generateDraft(h.form);
  delete h.nodes['#draftForm'];h.resolve({draft:'discarded draft'});await pending;
  assert.equal(h.editor.elements.text.value,'original');assert.equal(h.editor.elements.number.value,'V3');
});
test('save displays inline pending status and prevents duplicate requests',async()=>{
  const h=setup();vm.runInContext("state={versions:[]}",h.context);
  h.nodes['#saveVersion']={};h.nodes['#versionSaveStatus']={};h.nodes['#versionFields']={};h.nodes['#openDraft']={};
  const notices=[];h.context.toast=(...a)=>notices.push(a);h.context.renderVersionList=()=>{};
  const pending=h.context.saveVersion(h.editor);assert.equal(h.nodes['#saveVersion'].disabled,true);
  assert.match(h.nodes['#versionSaveStatus'].textContent,/正在保存/);
  await h.context.saveVersion(h.editor);h.resolve({id:'new-id',number:'V3'});await pending;
  assert.equal(h.editor.elements.id.value,'new-id');assert.equal(h.nodes['#openDraft'].hidden,true);
  assert.equal(h.nodes['#versionSaveStatus'].textContent,'');assert.equal(notices[0][0],'保存成功');
});
test('save failure keeps unsaved text and restores controls',async()=>{
  const h=setup();h.nodes['#saveVersion']={};h.nodes['#versionSaveStatus']={};h.nodes['#versionFields']={};h.nodes['#openDraft']={};
  let notice;h.context.toast=(...a)=>notice=a;
  const pending=h.context.saveVersion(h.editor);h.reject(new Error('network unavailable'));await pending;
  assert.equal(h.editor.elements.text.value,'original');assert.equal(h.nodes['#saveVersion'].disabled,false);
  assert.equal(notice[0],'保存失败');assert.equal(notice[2],'network unavailable');
});
test('comparison return preserves editor identity, contents and pagination',()=>{
  const h=setup();vm.runInContext("state={versions:[{id:'a',project_id:'project-a',number:'V1',text:'a'},{id:'b',project_id:'project-a',number:'V2',text:'b'}]};versionListPage=8",h.context);
  for(const id of ['versionWorkspace','versionComparison','comparisonBack','diff','diffOutput'])h.nodes['#'+id]={};
  h.nodes['#diffOld']={value:'a'};h.nodes['#diffNew']={value:'b'};
  h.context.showVersionComparison();assert.equal(h.nodes['#versionWorkspace'].hidden,true);
  h.nodes['#diff'].onclick();assert.match(h.nodes['#diffOutput'].innerHTML,/diff-add/);
  h.nodes['#comparisonBack'].onclick();assert.equal(h.nodes['#versionWorkspace'].hidden,false);
  assert.equal(h.editor.elements.text.value,'original');assert.equal(vm.runInContext('versionListPage',h.context),8);
});
test('AI failure uses dismissible toast pathway instead of page banner',async()=>{
  const h=setup();let notice;h.context.toast=(...a)=>notice=a;
  const pending=h.context.generateDraft(h.form);h.reject(new Error('provider error'));await pending;
  assert.deepEqual(notice,['生成失败',true,'provider error']);assert.equal(h.nodes['#notice'].textContent,undefined);
});
test('toast is dismissible and expires after five seconds',()=>{
  const h=setup();let click,expire,delay,removed=0;
  const item={setAttribute(){},querySelector:()=>({set onclick(v){click=v;}}),remove(){removed++;}};
  h.nodes['#toastHost']={appendChild(){}};h.document.body={appendChild(){}};
  h.document.createElement=()=>item;h.context.setTimeout=(f,ms)=>{expire=f;delay=ms;};
  h.context.toast('保存成功');assert.equal(delay,5000);click();expire();assert.equal(removed,2);
});
test('late draft error does not appear on a different page',async()=>{
  const h=setup(),pending=h.context.generateDraft(h.form);
  delete h.nodes['#draftForm'];h.reject(new Error('old failure'));await pending;
  assert.equal(h.nodes['#notice'].textContent,undefined);
});
test('cancel report switch restores selected report and preserves review',()=>{
  const h=setup(),select={value:'run-b'},report={textContent:'report-a'};
  h.nodes['#reportContent']=report;
  h.setForms([{elements:{note:{value:'unsaved'},conclusion:{value:'认可'}}}]);
  h.context.switchReport(select);
  assert.equal(select.value,'run-a');assert.equal(report.textContent,'report-a');
});
test('confirm report switch clears old content before loading',()=>{
  const h=setup(),select={value:'run-b'};
  h.nodes['#reportContent']={textContent:'report-a'};
  h.setForms([{elements:{note:{value:''},conclusion:{value:'不认可'}}}]);
  h.context.confirm=()=>true;let loaded;
  h.context.loadReport=()=>{loaded=vm.runInContext('currentRun',h.context);};
  h.context.switchReport(select);
  assert.equal(loaded,'run-b');assert.equal(h.nodes['#reportContent'].textContent,'正在加载所选报告…');
});
test('in-flight report poll cannot erase newly typed review',async()=>{
  const h=setup(),report={innerHTML:'existing report'};
  h.nodes['#reportContent']=report;
  const pending=h.context.loadReport();
  h.setForms([{elements:{note:{value:'typed during fetch'},conclusion:{value:'认可'}}}]);
  h.resolve({});await pending;
  assert.equal(report.innerHTML,'existing report');
});
