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
  const editor={elements:{id:{value:'v1'},text:{value:'original'},note:{value:'note'}},reset(){for(const v of Object.values(this.elements))v.value='';}};
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
  assert.equal(h.nodes['#draftButton'].disabled,false);
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
