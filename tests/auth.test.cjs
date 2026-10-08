const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../cloud/auth.js'),'utf8');
function setup(hash,fail=false){
  const nodes={};const calls=[];const stored=new Map([['promptpilot.cloud.session',JSON.stringify({access_token:'old',expires_at:9999999999})]]);
  for(const id of ['cloudResetForm','cloudLoginForm','cancelReset','cloudLogout','loginMessage','cloudStatus','cloudAccount'])nodes['#'+id]={hidden:id==='cloudResetForm',textContent:'',elements:{new_password:{value:'new-test-pass'},confirm_password:{value:'new-test-pass'}},button:{},querySelector(){return this.button;},reset(){this.elements.new_password.value='';this.elements.confirm_password.value='';}};
  const location={hash,pathname:'/promptpilot/',search:'',reload(){}};let init;
  const context={window:{PROMPTPILOT_CONFIG:{url:'https://test.supabase.co',publishableKey:'public',functionName:'promptpilot'}},document:{querySelector:s=>nodes[s],body:{classList:{remove(){},add(){throw Error('must not activate recovery session');}}},addEventListener:(e,fn)=>init=fn},location,history:{replaceState(a,b,url){location.hash='';location.clean=url;}},URLSearchParams,AbortSignal,sessionStorage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v),removeItem:k=>stored.delete(k)},clearTimeout(){},setTimeout(){throw Error('must not start jobs');},fetch:async(url,options)=>{calls.push({url,...options});return {ok:!fail,status:fail?401:200,text:async()=>fail?'{}':'{"id":"user"}'};}};
  vm.runInNewContext(source,context);init();
  return {nodes,calls,stored,location,submit:()=>nodes['#cloudResetForm'].onsubmit({preventDefault(){}})};
}
test('recovery clears URL and old session without starting app or storing recovery token',()=>{
  const s=setup('#type=recovery&access_token=recovery-secret&refresh_token=refresh-secret');
  assert.equal(s.location.hash,'');assert.equal(s.stored.size,0);assert.equal(s.calls.length,0);
  assert.equal(s.nodes['#cloudResetForm'].hidden,false);assert.equal(s.nodes['#cloudLoginForm'].hidden,true);
});
test('mismatched passwords do not send request',async()=>{
  const s=setup('#type=recovery&access_token=recovery-secret');s.nodes['#cloudResetForm'].elements.confirm_password.value='different';await s.submit();
  assert.equal(s.calls.length,0);assert.match(s.nodes['#loginMessage'].textContent,/不一致/);
});
test('successful recovery uses PUT user then returns to login without persisting password',async()=>{
  const s=setup('#type=recovery&access_token=recovery-secret');await s.submit();
  assert.equal(s.calls[0].method,'PUT');assert.equal(s.calls[0].url,'https://test.supabase.co/auth/v1/user');
  assert.equal(s.calls[0].headers.Authorization,'Bearer recovery-secret');assert.deepEqual(JSON.parse(s.calls[0].body),{password:'new-test-pass'});
  assert.equal(s.nodes['#cloudResetForm'].hidden,true);assert.equal(s.nodes['#cloudLoginForm'].hidden,false);
  assert.equal(s.nodes['#cloudResetForm'].elements.new_password.value,'');assert.equal(s.stored.size,0);
  assert.match(s.nodes['#loginMessage'].textContent,/修改成功/);
});
test('expired recovery link cannot activate old session',()=>{
  const s=setup('#error=access_denied&error_description=secret');assert.equal(s.calls.length,0);assert.equal(s.stored.size,0);assert.equal(s.location.hash,'');assert.match(s.nodes['#loginMessage'].textContent,/过期/);
});
test('server failure is not reported as successful password change',async()=>{
  const s=setup('#type=recovery&access_token=expired',true);await s.submit();assert.equal(s.nodes['#cloudResetForm'].hidden,false);assert.match(s.nodes['#loginMessage'].textContent,/失效/);
});
