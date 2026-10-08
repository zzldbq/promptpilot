"""Fixed fictional fixtures only. Never invoked by the real model execution path."""
import json
import storage as db
from evaluator import evaluate


def seed_project(project):
    pid = project['id']
    base = '你是案件材料整理助手。仅根据虚构输入提取事实，不作法律判断。\n输出纯 JSON，包含 evidence_complete（布尔）、amount（数字）、needs_more_material（布尔）。\n'
    v1 = db.save('version', {'project_id': pid, 'number': 'V1', 'note': '完整规则，包含缺失材料及金额边界', 'text': base + '证据明确缺失时 evidence_complete=false、needs_more_material=true；金额为0也要保留。\n案件：{{case_input}}'})
    v2 = db.save('version', {'project_id': pid, 'number': 'V2', 'note': '故意简化规则，用于演示回归风险', 'text': base + '默认材料齐全；金额为0时可用自然语言简要说明。\n案件：{{case_input}}'})
    fixtures = [
        ('A 案 · 常见材料齐全', '常见', '虚构 A 案：材料齐全，记录金额100。', True, 100, False),
        ('B 案 · 多份材料', '多材料', '虚构 B 案：两份材料均完整，总金额250。', True, 250, False),
        ('C 案 · 缺失关键材料', '缺失信息', '虚构 C 案：记录金额80，但缺少关键材料，需要补充。', False, 80, True),
        ('D 案 · 零金额边界', '边界', '虚构 D 案：材料齐全，记录金额为0，仍需输出结构化字段。', True, 0, False),
    ]
    cases = []
    for name, tag, text, complete, amount, more in fixtures:
        cases.append(db.save('case', {'project_id': pid, 'name': name, 'tag': tag, 'suite': '虚构回归集', 'input': text, 'expected': {'evidence_complete': complete, 'amount': amount, 'needs_more_material': more}, 'required': ['evidence_complete', 'amount', 'needs_more_material'], 'manual_fields': []}))
    return v1, v2, cases


def create_demo():
    project = db.save('project', {'name': '虚构案件 · 版本回归演示', 'goal': '整理材料完整性及金额，发现提示词简化导致的回归', 'requirements': '纯 JSON：evidence_complete、amount、needs_more_material；仅作材料整理，不作法律判断'})
    v1, v2, cases = seed_project(project)
    models = [{'id': 'demo-a', 'name': '演示模型 A（固定样例）', 'model': 'fixture-a'}, {'id': 'demo-b', 'name': '演示模型 B（固定样例）', 'model': 'fixture-b'}]
    run = db.save('run', {'project_id': project['id'], 'source': 'demo', 'status': 'completed', 'snapshot': {'project': project, 'cases': cases, 'versions': [v1, v2], 'models': models, 'adapter': '固定演示数据（未调用模型）', 'temperature': 0}, 'total': 16, 'completed': 16, 'finished_at': db.now()})
    for mi, model in enumerate(models):
        for version in [v1, v2]:
            for i, case in enumerate(cases):
                output = dict(case['expected'])
                if version['id'] == v2['id'] and i == 2:
                    output.update(evidence_complete=True, needs_more_material=False)
                raw = '材料齐全，金额为零。' if version['id'] == v2['id'] and i == 3 else json.dumps(output, ensure_ascii=False)
                db.save('result', {'run_id': run['id'], 'case_id': case['id'], 'version_id': version['id'], 'model_id': model['id'], 'raw': raw, 'rendered_prompt': version['text'].replace('{{case_input}}', case['input']), **evaluate(raw, case['expected'], case['required'], case['manual_fields']), 'error': None, 'elapsed_ms': 420 + mi * 160 + i * 70})
    return project
