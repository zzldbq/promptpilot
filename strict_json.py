"""JSON input boundaries: reject ambiguous objects and non-finite numbers."""
import json
import math


def loads(raw):
    def number(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError('数字超出有限范围：' + value)
        return parsed

    def constant(value):
        raise ValueError('不支持非有限数字：' + value)

    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('JSON 字段重复：' + key)
            result[key] = value
        return result

    try:
        return json.loads(raw, parse_float=number, parse_constant=constant, object_pairs_hook=object_pairs)
    except RecursionError as exc:
        raise ValueError('JSON 嵌套层级过深') from exc
