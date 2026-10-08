"""PromptPilot local-only HTTP server, Python 3.10+, no third-party packages."""
import json
import os
import re
import socket
import threading
import traceback
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = Path(__file__).parent


def load_env():
    path = ROOT / '.env'
    if path.exists():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                name, value = line.split('=', 1)
                os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))


load_env()
import storage as db
from workflow import LocalWorkflow, call_model, redact
from evaluator import regressions
from strict_json import loads
from demo import create_demo, seed_project

RUN_LOCK = threading.Lock()
MUTATION_LOCK = threading.Lock()


def text_value(body, key, limit=50000):
    value = body.get(key, '')
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f'{key} 必须是非空文本，长度不超过 {limit}')
    return value.strip()


def string_list(body, key):
    value = body.get(key, [])
    if not isinstance(value, list) or any(not isinstance(x, str) or not x.strip() for x in value):
        raise ValueError(key + ' 必须是字符串数组')
    return list(dict.fromkeys(value))


def model_public(model):
    return {**model, 'configured': bool(os.environ.get(model['key_env']))}


def execute_run(run):
    try:
        snapshot = run['snapshot']
        for version in snapshot['versions']:
            for model in snapshot['models']:
                for case in snapshot['cases']:
                    result = LocalWorkflow().execute(version, case, model)
                    db.save('result', {'run_id': run['id'], 'case_id': case['id'], 'version_id': version['id'], 'model_id': model['id'], **result})
                    run['completed'] += 1
                    db.save('run', run)
        run['status'] = 'completed'
    except Exception as exc:
        run['status'] = 'interrupted'
        run['error'] = redact(str(exc))
    finally:
        run['finished_at'] = db.now()
        db.save('run', run)
        RUN_LOCK.release()


def report(identifier):
    run = db.get('run', identifier)
    results = [r for r in db.all_items('result') if r['run_id'] == identifier]
    versions = run['snapshot']['versions']
    regression = {}
    if len(versions) >= 2:
        for model in run['snapshot']['models']:
            regression[model['id']] = regressions(results, versions[0]['id'], versions[1]['id'], model['id'])
    reviews = [r for r in db.all_items('review') if r['run_id'] == identifier]
    return {**run, 'results': results, 'reviews': reviews, 'regressions': regression}


def mutate(path, body):
    if path == '/api/projects':
        return db.save('project', {'name': text_value(body, 'name', 150), 'goal': text_value(body, 'goal'), 'requirements': text_value(body, 'requirements')})
    if path == '/api/demo':
        return create_demo()
    if path == '/api/seed':
        project = db.get('project', body.get('project_id'))
        if any(v['project_id'] == project['id'] for v in db.all_items('version')) or any(c['project_id'] == project['id'] for c in db.all_items('case')):
            raise ValueError('示例仅可导入空项目，避免重复或覆盖已有数据')
        seed_project(project)
        return {'ok': True}
    if path in ['/api/versions', '/api/cases']:
        pid = body.get('project_id')
        db.get('project', pid)
        kind = 'version' if path.endswith('versions') else 'case'
        previous = db.get(kind, body['id']) if body.get('id') else {}
        if previous and previous['project_id'] != pid:
            raise ValueError('记录不属于本项目')
        item = {**previous, 'project_id': pid, 'updated_at': db.now()}
        if kind == 'version':
            number = text_value(body, 'number', 60)
            if any(v['project_id'] == pid and v['number'] == number and v['id'] != previous.get('id') for v in db.all_items(kind)):
                raise ValueError('项目内版本号不能重复')
            text = text_value(body, 'text')
            if '{{case_input}}' not in text:
                raise ValueError('提示词必须包含 {{case_input}} 占位符')
            item.update(number=number, text=text, note=text_value(body, 'note', 2000))
        else:
            expected = loads(body['expected_json']) if 'expected_json' in body else body.get('expected')
            if not isinstance(expected, dict):
                raise ValueError('预期结果必须是 JSON 对象')
            item.update(name=text_value(body, 'name', 150), tag=text_value(body, 'tag', 150), suite=text_value(body, 'suite', 150), input=text_value(body, 'input'), expected=expected, required=string_list(body, 'required'), manual_fields=string_list(body, 'manual_fields'))
        return db.save(kind, item)
    if path == '/api/cases/delete':
        db.get('case', body.get('id'))
        db.delete('case', body['id'])
        return {'ok': True}
    if path == '/api/models':
        base = text_value(body, 'base_url', 2000).rstrip('/')
        url = urlparse(base)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('Base URL 必须是无凭据、无查询参数的 http(s) 地址')
        env = text_value(body, 'key_env', 100)
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*(?:KEY|TOKEN)', env):
            raise ValueError('环境变量名使用大写字母、数字和下划线，并以 KEY 或 TOKEN 结尾')
        previous = db.get('model', body['id']) if body.get('id') else {}
        return model_public(db.save('model', {**previous, 'name': text_value(body, 'name', 100), 'base_url': base, 'model': text_value(body, 'model', 150), 'key_env': env}))
    if path == '/api/draft':
        model = db.get('model', body.get('model_id'))
        prompt = '请起草中文案件材料整理提示词，避免擅自判断法律结论。输出可直接编辑的提示词正文，必须包含字面占位符 {{case_input}}。明确只输出 JSON，不含 Markdown。\n业务目标：' + text_value(body, 'goal') + '\n要件：' + text_value(body, 'elements') + '\n输出格式：' + text_value(body, 'format')
        return {'draft': call_model(model, prompt), 'notice': 'AI 草稿，待人工审核'}
    if path == '/api/runs':
        project = db.get('project', body.get('project_id'))
        versions = [db.get('version', x) for x in string_list(body, 'version_ids')]
        cases = [db.get('case', x) for x in string_list(body, 'case_ids')]
        models = [db.get('model', x) for x in string_list(body, 'model_ids')]
        if not (1 <= len(versions) <= 2 and cases and models):
            raise ValueError('请选择 1–2 个版本、至少一个案件及一个模型')
        if any(x['project_id'] != project['id'] for x in versions + cases):
            raise ValueError('版本和案件必须属于同一项目')
        if any(not os.environ.get(m['key_env']) for m in models):
            raise ValueError('所选模型缺少服务端 API Key，请配置并重启服务')
        total = len(versions) * len(cases) * len(models)
        if total > 200:
            raise ValueError('MVP 单次最多 200 个调用')
        if not RUN_LOCK.acquire(blocking=False):
            raise ValueError('已有评测正在运行，请完成后再试')
        try:
            run = db.save('run', {'project_id': project['id'], 'source': 'real', 'status': 'running', 'total': total, 'completed': 0, 'snapshot': {'project': project, 'versions': versions, 'cases': cases, 'models': models, 'adapter': 'LocalWorkflow v1', 'temperature': 0, 'timeout_seconds': 60, 'validation': 'strict-json-exact-types-v1'}})
            threading.Thread(target=execute_run, args=(run,), daemon=True).start()
            return run
        except Exception:
            RUN_LOCK.release()
            raise
    if path == '/api/reviews':
        result = db.get('result', body.get('result_id'))
        conclusion = body.get('conclusion')
        if conclusion not in ['认可', '不认可', '需补充材料']:
            raise ValueError('无效复核结论')
        return db.save('review', {'run_id': result['run_id'], 'result_id': result['id'], 'conclusion': conclusion, 'note': text_value(body, 'note', 5000)})
    raise ValueError('未知 API')


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def trusted_host(self):
        return self.headers.get('Host') in {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}

    def do_GET(self):
        try:
            if not self.trusted_host():
                return self.send_json(403, {'error': '仅允许本机访问'})
            path = urlparse(self.path).path
            if path == '/api/state':
                return self.send_json(200, {'projects': db.all_items('project'), 'versions': db.all_items('version'), 'cases': db.all_items('case'), 'models': [model_public(m) for m in db.all_items('model')], 'runs': [{k: v for k, v in r.items() if k != 'snapshot'} for r in db.all_items('run')]})
            if path.startswith('/api/runs/'):
                return self.send_json(200, report(path.split('/')[-1]))
            files = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
            if path not in files:
                return self.send_json(404, {'error': '页面不存在'})
            name, mime = files[path]
            data = (ROOT / 'static' / name).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mime + '; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(data)
        except ValueError as exc:
            self.send_json(404, {'error': str(exc)})

    def do_POST(self):
        if not self.trusted_host() or self.headers.get('Origin', f'http://{self.headers.get("Host")}') != f'http://{self.headers.get("Host")}':
            return self.send_json(403, {'error': '拒绝跨站请求'})
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.send_json(415, {'error': '需要 application/json'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1_000_000:
                raise ValueError('请求大小无效')
            body = loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('请求必须是 JSON 对象')
            # Draft calls may take 60s; avoid blocking ordinary edits.
            if self.path == '/api/draft':
                result = mutate(self.path, body)
            else:
                with MUTATION_LOCK:
                    result = mutate(self.path, body)
            self.send_json(200, result)
        except (ValueError, KeyError, TypeError) as exc:
            self.send_json(400, {'error': redact(str(exc))})
        except Exception as exc:
            self.send_json(500, {'error': redact(str(exc))})


def initialize():
    db.init()
    for run in db.all_items('run'):
        if run['status'] == 'running':
            db.save('run', {**run, 'status': 'interrupted', 'error': '服务重启，未完成的调用没有自动重试；已完成结果仍保留', 'finished_at': db.now()})
    if not db.all_items('model'):
        db.save('model', {'name': '默认 OpenAI 兼容模型', 'base_url': os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1'), 'model': os.environ.get('OPENAI_MODEL', 'gpt-4.1-mini'), 'key_env': 'OPENAI_API_KEY'})


class LocalHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        # Windows SO_REUSEADDR can allow two listeners on the same port.
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def create_server(port):
    # Claim the listening port before changing persisted run states.
    server = LocalHTTPServer(('127.0.0.1', port), Handler)
    try:
        initialize()
    except Exception:
        server.server_close()
        raise
    return server


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8765'))
    server = create_server(port)
    print(f'PromptPilot running at http://127.0.0.1:{port} (Ctrl+C to stop)', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
