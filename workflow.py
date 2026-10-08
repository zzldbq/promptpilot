"""Agent Flow integration seam and the real local workflow implementation."""
import json
import os
import time
import urllib.request
import urllib.error
from abc import ABC, abstractmethod
from evaluator import evaluate


def redact(text):
    for name, value in os.environ.items():
        if ('KEY' in name or 'TOKEN' in name or 'SECRET' in name) and value:
            text = text.replace(value, '[REDACTED]')
    return text


def call_model(config, prompt):
    key = os.environ.get(config['key_env'], '')
    if not key:
        raise ValueError('模型未配置：请在服务端环境变量 ' + config['key_env'] + ' 中设置 API Key 并重启服务')
    body = json.dumps({'model': config['model'], 'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0}).encode()
    req = urllib.request.Request(config['base_url'].rstrip('/') + '/chat/completions', data=body, headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key})
    try:
        # Do not follow redirects and forward credentials to another host.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        with urllib.request.build_opener(NoRedirect).open(req, timeout=60) as response:
            payload = json.loads(response.read(4_000_000))
        content = payload['choices'][0]['message']['content']
        if not isinstance(content, str):
            raise ValueError('模型响应 content 不是文本')
        return content
    except urllib.error.HTTPError as exc:
        try:
            message = redact(f'模型 HTTP {exc.code}: ' + exc.read(8000).decode('utf-8', errors='replace'))
        finally:
            exc.close()
        raise RuntimeError(message) from exc
    except Exception as exc:
        raise RuntimeError(redact('模型请求失败：' + str(exc))) from exc


class WorkflowAdapter(ABC):
    @abstractmethod
    def execute(self, version, case, model):
        """Return raw, rendered_prompt, parsed, checks, status, error, elapsed_ms."""


class LocalWorkflow(WorkflowAdapter):
    def execute(self, version, case, model):
        started = time.perf_counter()
        prompt = version['text'].replace('{{case_input}}', case['input'])
        result = {'raw': None, 'rendered_prompt': prompt, 'parsed': None, 'checks': [], 'error': None, 'status': 'error'}
        try:
            result['raw'] = call_model(model, prompt)
            result.update(evaluate(result['raw'], case['expected'], case['required'], case['manual_fields']))
        except Exception as exc:
            result['error'] = redact(str(exc))
        result['elapsed_ms'] = round((time.perf_counter() - started) * 1000)
        return result


class AgentFlowAdapter(WorkflowAdapter):
    def execute(self, version, case, model):
        raise NotImplementedError('尚未接入 Agent Flow；需要接口、鉴权、Workflow 版本及输入输出映射')
