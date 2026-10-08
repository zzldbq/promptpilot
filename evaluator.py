"""Deterministic assertions; no LLM judge and no legal conclusions inferred."""
import json
from strict_json import loads


def compare_value(expected, actual):
    # bool is an int subclass in Python; require exact JSON types.
    if type(expected) is not type(actual):
        return False
    if isinstance(expected, dict):
        return expected.keys() == actual.keys() and all(compare_value(v, actual[k]) for k, v in expected.items())
    if isinstance(expected, list):
        return len(expected) == len(actual) and all(compare_value(x, y) for x, y in zip(expected, actual))
    return expected == actual


def evaluate(raw, expected, required, manual_fields):
    checks = []
    try:
        parsed = loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError('顶层必须是 JSON 对象')
    except (ValueError, TypeError) as exc:
        return {'status': 'fail', 'parsed': None, 'checks': [{'field': '$', 'status': 'fail', 'reason': 'JSON 解析失败：' + str(exc)}]}
    checks.append({'field': '$', 'status': 'pass', 'reason': 'JSON 对象可解析'})
    for field in sorted(set(required) | set(expected) | set(manual_fields)):
        if field not in parsed:
            checks.append({'field': field, 'status': 'fail', 'reason': '缺少必填字段', 'expected': expected.get(field)})
        elif field in manual_fields:
            checks.append({'field': field, 'status': 'review', 'reason': '业务结论或依据需人工复核，未自动判定正确性', 'expected': expected.get(field), 'actual': parsed[field]})
        elif field in expected:
            ok = compare_value(expected[field], parsed[field])
            checks.append({'field': field, 'status': 'pass' if ok else 'fail', 'reason': '类型和值一致' if ok else '类型或值不匹配（数组按顺序比较，对象按内容比较）', 'expected': expected[field], 'actual': parsed[field]})
        else:
            checks.append({'field': field, 'status': 'pass', 'reason': '必填字段存在；未设置该字段的值断言', 'actual': parsed[field]})
    # Without any value assertion the output must not be advertised as business-correct.
    if not expected:
        checks.append({'field': '$', 'status': 'review', 'reason': '没有预期值断言，需人工复核'})
    status = 'fail' if any(c['status'] == 'fail' for c in checks) else 'review' if any(c['status'] == 'review' for c in checks) else 'pass'
    return {'status': status, 'parsed': parsed, 'checks': checks}


def regressions(results, old_id, new_id, model_id):
    old = {r['case_id']: r for r in results if r['version_id'] == old_id and r['model_id'] == model_id}
    return [r['case_id'] for r in results if r['version_id'] == new_id and r['model_id'] == model_id and r['status'] == 'fail' and old.get(r['case_id'], {}).get('status') == 'pass']
