"""Build a static, secret-free Pages artifact, without modifying the local app."""
from pathlib import Path
import shutil
import argparse

parser=argparse.ArgumentParser()
parser.add_argument('--admin-email',default='')
args=parser.parse_args()

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'dist'
OUT.mkdir(exist_ok=True)
html = (ROOT / 'static/index.html').read_text(encoding='utf-8')
html = html.replace('href="/style.css"', 'href="./style.css"').replace('src="/app.js"', 'src="./app.js"').replace('href="/"', 'href="./"')
html = html.replace('<script src="./app.js" defer>', '<link rel="stylesheet" href="./cloud.css"><script src="./config.js" defer></script><script src="./auth.js" defer></script><script src="./app.js" defer>')
html = html.replace('<body>', '''<body><section id="cloudLogin" class="card"><h1>◈ PromptPilot</h1><h2>云端交付评测工作台</h2><p>仅限获准试用成员。登录后共享项目、虚构案件、评测结果和复核意见。</p><form id="cloudLoginForm"><label>邮箱<input name="email" type="email" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button>登录工作台</button></form><p id="loginMessage" role="status">请使用管理员为你创建的账号登录</p><p class="help">尚无账号或忘记密码？请联系管理员在 Supabase 重置。不要在此输入模型 API Key。</p></section>''')
html = html.replace('<nav id="nav"></nav>', '<nav id="nav"></nav><div id="cloudAccount" class="cloud-account"></div><button id="cloudLogout" class="secondary">退出登录</button>')
html = html.replace('本机运行 · SQLite 持久化', '云端试用 · Supabase 持久化').replace('MVP / LOCAL','MVP / CLOUD')
html = html.replace('<div id="notice"', '<div id="cloudStatus" role="status">云端就绪 · 评测期间请保持网页开启</div><div id="notice"')
(OUT / 'index.html').write_text(html, encoding='utf-8')
app = (ROOT / 'static/app.js').read_text(encoding='utf-8')
app = app.replace('async function api(path, body) {', 'async function api(path, body) {\n  return window.PromptPilotCloud.request(path, body);\n/* Local transport excluded from cloud build. */\n}\nasync function unusedLocalTransport(path, body) {')
app = app.replace("action(async()=>{await refresh();navigate('home');});", "action(async()=>{await window.PromptPilotCloud.ready;await refresh();navigate('home');});")
app = app.replace("localStorage.getItem('promptpilot.project')", "sessionStorage.getItem('promptpilot.cloud.project')").replace("localStorage.setItem('promptpilot.project',pid)","sessionStorage.setItem('promptpilot.cloud.project',pid)")
app = app.replace('f.elements.expected.value=pretty(c.expected);','f.elements.expected.value=c.expected_json||pretty(c.expected);')
app = app.replace('在项目根目录复制 .env.example 为 .env，设置对应 API Key 后重启服务。页面仅填写环境变量名，不接收密钥。已配置只代表环境变量存在，可用性以实际调用为准。', '管理员在 Supabase 的 Edge Functions → Secrets 设置 DEEPSEEK_API_KEY。页面只填写变量名，不接收密钥；当前仅允许批准的模型域名。已配置仅代表变量存在，连通性以实际调用为准。')
app = app.replace('value="OPENAI_API_KEY"','value="DEEPSEEK_API_KEY"')
app = app.replace('模型配置已保存。配置环境变量后重启服务。','模型配置已保存；密钥请由管理员在 Supabase Secrets 配置。')
app = app.replace('关闭页面不会中止服务端评测。','请保持网页开启以推进队列；关闭后待执行案件在下次登录时继续，已领取的调用不会自动重复。')
app = app.replace('后台串行逐例调用','云端逐例调用')
(OUT / 'app.js').write_text(app, encoding='utf-8')
for source in [ROOT/'static/style.css',ROOT/'cloud/cloud.css',ROOT/'cloud/config.js',ROOT/'cloud/auth.js']:
    shutil.copyfile(source,OUT/source.name)
(OUT / '.nojekyll').write_text('',encoding='utf-8')
# Single-file version for Supabase Dashboard's Edge Function editor.
bundle=(ROOT/'supabase/functions/promptpilot/core.mjs').read_text(encoding='utf-8')
main=(ROOT/'supabase/functions/promptpilot/main.mjs').read_text(encoding='utf-8').split('\n',1)[1]
bundle += '\n'+main+'\nDeno.serve(createHandler(name => Deno.env.get(name)));\n'
deploy=ROOT/'cloud/deploy';deploy.mkdir(exist_ok=True)
(deploy/'promptpilot.ts').write_text('// @ts-nocheck\n'+bundle,encoding='utf-8')
sql=(ROOT/'supabase/migrations/202610080001_promptpilot.sql').read_text(encoding='utf-8')
if args.admin_email:
    email=args.admin_email.strip().lower().replace("'","''")
    sql += f"\ninsert into public.pp_members(email,role) values ('{email}','admin') on conflict(email) do update set role='admin',enabled=true;\n"
(deploy/'01_database.sql').write_text(sql,encoding='utf-8')
print('Built dist/ (public website) and cloud/deploy/promptpilot.ts (Edge Function). No .env/database copied.')
