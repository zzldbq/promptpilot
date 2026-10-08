import json
import os
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import storage as db
import server
from evaluator import evaluate, regressions
from workflow import LocalWorkflow, call_model


class ValidationTests(unittest.TestCase):
    def test_overflow_and_duplicate_keys_remain_reportable(self):
        for raw in ['{"amount":1e400}', '{"nested":[-1e400]}', '{"ok":false,"ok":true}', '{"nested":{"a":1,"a":2}}']:
            result = evaluate(raw, {'ok': True}, [], [])
            self.assertEqual(result['status'], 'fail')
            self.assertIsNone(result['parsed'])
            json.dumps(result, allow_nan=False)

    def test_invalid_json_and_non_object(self):
        for raw in ['not json', '```json\n{}\n```', '[]', 'null', '{"x":NaN}']:
            self.assertEqual(evaluate(raw, {}, [], [])['status'], 'fail')

    def test_missing_required(self):
        result = evaluate('{}', {'amount': 3}, ['evidence'], [])
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(len([c for c in result['checks'] if c['status'] == 'fail']), 2)

    def test_types_and_nested_fields(self):
        for actual in [True, '1', 1.0]:
            self.assertEqual(evaluate(json.dumps({'a': actual}), {'a': 1}, [], [])['status'], 'fail')
        self.assertEqual(evaluate('{"a":{"x":[1,2]}}', {'a': {'x': [1, 2]}}, [], [])['status'], 'pass')
        self.assertEqual(evaluate('{"a":{"x":[2,1]}}', {'a': {'x': [1, 2]}}, [], [])['status'], 'fail')

    def test_false_zero_and_null(self):
        data = {'a': False, 'b': 0, 'c': None}
        self.assertEqual(evaluate(json.dumps(data), data, [], [])['status'], 'pass')

    def test_manual_and_no_assertions(self):
        self.assertEqual(evaluate('{"conclusion":"different"}', {'conclusion': 'expected'}, [], ['conclusion'])['status'], 'review')
        self.assertEqual(evaluate('{}', {}, [], [])['status'], 'review')
        self.assertEqual(evaluate('{}', {}, [], ['conclusion'])['status'], 'fail')

    def test_failure_precedes_review(self):
        self.assertEqual(evaluate('{"a":2,"conclusion":"x"}', {'a': 1}, [], ['conclusion'])['status'], 'fail')

    def test_regression_respects_model_and_error(self):
        results = [dict(case_id=c, version_id=v, model_id=m, status=s) for c,v,m,s in [('C','v1','m','pass'),('C','v2','m','fail'),('D','v1','m','pass'),('D','v2','m','error'),('E','v1','other','pass'),('E','v2','m','fail')]]
        self.assertEqual(regressions(results, 'v1', 'v2', 'm'), ['C'])


class FakeProvider(BaseHTTPRequestHandler):
    requests = []
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.requests.append((self.path, self.headers.get('Authorization'), body))
        if body['model'] == 'broken':
            self.send_response(429)
            payload = {'error': 'rate limited secret-test-value'}
        else:
            self.send_response(200)
            payload = {'choices': [{'message': {'content': '{"ok":true}'}}]}
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())
    def log_message(self, *args):
        pass


class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.old_path = db.DB_PATH
        db.DB_PATH = Path(cls.temp.name) / 'test.sqlite3'
        cls.env = patch.dict(os.environ, {'TEST_API_KEY': 'secret-test-value'})
        cls.env.start()
        server.initialize()
        cls.provider = ThreadingHTTPServer(('127.0.0.1', 0), FakeProvider)
        cls.app = server.LocalHTTPServer(('127.0.0.1', 0), server.Handler)
        for service in [cls.provider, cls.app]:
            threading.Thread(target=service.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.app.server_port}'
        cls.model_config = {'name': 'test provider', 'base_url': f'http://127.0.0.1:{cls.provider.server_port}/v1', 'model': 'test', 'key_env': 'TEST_API_KEY'}

    @classmethod
    def tearDownClass(cls):
        for service in [cls.app, cls.provider]:
            service.shutdown()
            service.server_close()
        cls.env.stop()
        db.DB_PATH = cls.old_path
        cls.temp.cleanup()

    def request(self, path, body=None, origin=None):
        headers = {'Content-Type': 'application/json'}
        if origin:
            headers['Origin'] = origin
        request = urllib.request.Request(self.url + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def test_compatible_request_and_real_errors(self):
        self.assertEqual(call_model(self.model_config, 'test input'), '{"ok":true}')
        path, auth, body = FakeProvider.requests[-1]
        self.assertEqual(path, '/v1/chat/completions')
        self.assertEqual(auth, 'Bearer secret-test-value')
        self.assertEqual(body['messages'][0]['content'], 'test input')
        with self.assertRaisesRegex(RuntimeError, 'HTTP 429') as caught:
            call_model({**self.model_config, 'model': 'broken'}, 'input')
        self.assertNotIn('secret-test-value', str(caught.exception))

    def test_missing_key_no_fake_output(self):
        config = {**self.model_config, 'key_env': 'NONEXISTENT_API_KEY'}
        result = LocalWorkflow().execute({'text': '{{case_input}}'}, {'input': 'a', 'expected': {}, 'required': [], 'manual_fields': []}, config)
        self.assertEqual(result['status'], 'error')
        self.assertIsNone(result['raw'])
        self.assertIn('未配置', result['error'])

    def test_demo_c_d_and_immutable_snapshot_review(self):
        project = self.request('/api/demo', {})
        state = self.request('/api/state')
        run = next(r for r in state['runs'] if r['project_id'] == project['id'])
        report = self.request('/api/runs/' + run['id'])
        self.assertEqual(report['source'], 'demo')
        for ids in report['regressions'].values():
            names = [c['name'][0] for c in report['snapshot']['cases'] if c['id'] in ids]
            self.assertEqual(names, ['C', 'D'])
        version = report['snapshot']['versions'][0]
        self.request('/api/versions', {**version, 'text': 'changed {{case_input}}'})
        self.assertEqual(self.request('/api/runs/'+run['id'])['snapshot']['versions'][0]['text'], version['text'])
        result = report['results'][0]
        self.request('/api/reviews', {'result_id': result['id'], 'conclusion': '不认可', 'note': '人工测试备注'})
        self.assertEqual(db.get('result', result['id']), result)
        self.assertEqual(len(self.request('/api/runs/'+run['id'])['reviews']), 1)
        self.assertNotIn('secret-test-value', json.dumps(report))

    def test_real_batch_and_snapshot_case_delete(self):
        project = self.request('/api/projects', {'name':'test','goal':'extract','requirements':'JSON'})
        version = self.request('/api/versions', {'project_id':project['id'],'number':'V1','note':'first','text':'extract {{case_input}}'})
        case = self.request('/api/cases', {'project_id':project['id'],'name':'fictional','tag':'normal','suite':'suite','input':'fictional input','expected':{'ok':True},'required':['ok'],'manual_fields':[]})
        model = self.request('/api/models', self.model_config)
        run = self.request('/api/runs', {'project_id':project['id'],'version_ids':[version['id']],'case_ids':[case['id']],'model_ids':[model['id']]})
        for _ in range(100):
            report = self.request('/api/runs/'+run['id'])
            if report['status'] != 'running':
                break
            time.sleep(.02)
        self.assertEqual(report['status'], 'completed')
        self.assertEqual(report['results'][0]['status'], 'pass')
        self.assertEqual(report['results'][0]['rendered_prompt'], 'extract fictional input')
        self.request('/api/cases/delete', {'id':case['id']})
        self.assertEqual(self.request('/api/runs/'+run['id'])['snapshot']['cases'][0]['input'], 'fictional input')

    def test_draft_uses_provider(self):
        model = self.request('/api/models', self.model_config)
        draft = self.request('/api/draft', {'model_id':model['id'],'goal':'goal','elements':'elements','format':'JSON'})
        self.assertEqual(draft['draft'], '{"ok":true}')
        self.assertIn('{{case_input}}', FakeProvider.requests[-1][2]['messages'][0]['content'])

    def test_cross_origin_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('/api/demo', {}, 'https://foreign.example')
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()

    def test_persistence_and_restart_interruption(self):
        project = db.save('project', {'name':'persistent'})
        run = db.save('run', {'status':'running','completed':0})
        server.initialize()
        self.assertEqual(db.get('project',project['id'])['name'], 'persistent')
        self.assertEqual(db.get('run',run['id'])['status'], 'interrupted')

    def test_duplicate_start_does_not_interrupt_active_run(self):
        run = db.save('run', {'status': 'running', 'completed': 3})
        with self.assertRaises(OSError):
            server.create_server(self.app.server_port)
        self.assertEqual(db.get('run', run['id'])['status'], 'running')
        self.assertEqual(db.get('run', run['id'])['completed'], 3)
        db.save('run', {**run, 'status': 'completed'})

    def test_invalid_expected_json_is_not_persisted(self):
        project = self.request('/api/projects', {'name': 'strict', 'goal': 'goal', 'requirements': 'JSON'})
        original = len(db.all_items('case'))
        for raw in ['{"amount":1e400}', '{"ok":false,"ok":true}']:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.request('/api/cases', {'project_id': project['id'], 'name': 'fictional', 'tag': 'test', 'suite': 'test', 'input': 'fictional', 'expected_json': raw})
            self.assertEqual(caught.exception.code, 400)
            caught.exception.close()
        self.assertEqual(len(db.all_items('case')), original)

    def test_storage_rejects_nonfinite_numbers(self):
        original = len(db.all_items('case'))
        with self.assertRaises(ValueError):
            db.save('case', {'expected': {'amount': float('inf')}})
        self.assertEqual(len(db.all_items('case')), original)


if __name__ == '__main__':
    unittest.main()
