"""Research workspace V3 persistence isolated from every other Relatum data set."""

from __future__ import annotations

import hashlib
import json
import math
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Callable


RESEARCH_VERSION = 3
MAX_PAGES = 256
MAX_SUBCIRCUITS = 256
MAX_REVISIONS_PER_SUBCIRCUIT = 64
MAX_SUBCIRCUIT_DEPTH = 32
MAX_NODES_PER_PAGE = 100_000
MAX_EDGES_PER_PAGE = 200_000
MAX_ID_LENGTH = 256
MAX_LABEL_LENGTH = 1_000_000
ALLOWED_SPEEDS = {0.25, 0.5, 1, 2, 4}
VALUE_TYPES = {"number", "boolean", "string", "time", "bits"}
REGISTRY_PATH = Path(__file__).resolve().parent / "assets" / "research" / "research-node-definitions.json"


def _load_registry() -> dict:
    source = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    if source.get("version") != RESEARCH_VERSION or not isinstance(source.get("nodes"), list):
        raise RuntimeError("研究节点注册表版本无效")
    nodes = {}
    for definition in source["nodes"]:
        node_type = str(definition.get("type") or "")
        if not node_type or node_type in nodes:
            raise RuntimeError(f"研究节点注册表类型无效：{node_type}")
        nodes[node_type] = definition
    return nodes


NODE_DEFINITIONS = _load_registry()


class ResearchStoreError(ValueError):
    def __init__(self, message: str, *, code: str = "invalid-document", issues=None):
        super().__init__(message)
        self.code = code
        self.issues = list(issues or [])


class ResearchConflictError(ResearchStoreError):
    def __init__(self, revision: str):
        super().__init__("研究数据已在其他窗口更新，请重新打开后再编辑", code="revision-conflict")
        self.revision = revision


def empty_research_document() -> dict:
    return {
        "researchVersion": RESEARCH_VERSION,
        "subcircuits": [],
        "pages": [{
            "id": "research-page-1", "title": "", "nodes": [], "edges": [],
            "view": {"x": 0, "y": 0, "scale": 1}, "simulation": {"speed": 1},
        }],
        "activePageId": "research-page-1",
    }


def _issue(code: str, path: str, message: str, **extra) -> dict:
    return {"code": code, "path": path, "message": message, **extra}


def _finite(value, fallback: float, issues: list[dict], path: str) -> float:
    if isinstance(value, bool):
        issues.append(_issue("invalid-number", path, "必须是有限数值"))
        return fallback
    try:
        number = float(value)
    except (TypeError, ValueError):
        issues.append(_issue("invalid-number", path, "必须是有限数值"))
        return fallback
    if not math.isfinite(number):
        issues.append(_issue("invalid-number", path, "必须是有限数值"))
        return fallback
    return int(number) if number.is_integer() else number


def _identifier(value, fallback: str, issues: list[dict], path: str) -> str:
    result = str(value or fallback)
    if not result or len(result) > MAX_ID_LENGTH:
        issues.append(_issue("invalid-id", path, f"ID 长度必须为 1–{MAX_ID_LENGTH}"))
        return fallback
    return result


def _typed_value(source, fallback: dict, issues: list[dict], path: str) -> dict:
    value = source if isinstance(source, dict) else fallback
    value_type = str(value.get("type") or fallback.get("type") or "number")
    if value_type not in VALUE_TYPES:
        issues.append(_issue("invalid-value-type", f"{path}.type", f"不支持的值类型：{value_type}"))
        value_type = "number"
        value = {"type": "number", "value": 0}
    raw = value.get("value")
    if value_type in {"number", "time"}:
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
            issues.append(_issue("invalid-value", f"{path}.value", "数字必须为有限数值"))
            raw = 0
        return {"type": value_type, "value": raw}
    if value_type == "boolean":
        if not isinstance(raw, bool):
            issues.append(_issue("invalid-value", f"{path}.value", "布尔值必须是 true 或 false"))
            raw = False
        return {"type": "boolean", "value": raw}
    if value_type == "string":
        if not isinstance(raw, str):
            issues.append(_issue("invalid-value", f"{path}.value", "文本值必须是字符串"))
            raw = ""
        return {"type": "string", "value": raw}
    width = value.get("width")
    if isinstance(width, bool) or not isinstance(width, int) or not 1 <= width <= 64:
        issues.append(_issue("invalid-bits-width", f"{path}.width", "Bits 位宽必须是 1–64 的整数"))
        width = 1
    if not isinstance(raw, str):
        issues.append(_issue("invalid-bits-value", f"{path}.value", "Bits 必须使用十六进制字符串保存"))
        raw = "0x0"
    try:
        number = int(raw, 0)
    except (TypeError, ValueError):
        issues.append(_issue("invalid-bits-value", f"{path}.value", "Bits 必须使用十六进制字符串保存"))
        number = 0
    number &= (1 << width) - 1
    return {"type": "bits", "width": width, "value": hex(number)}


def _normalize_config(definition: dict, source, issues: list[dict], path: str) -> dict:
    config = source if isinstance(source, dict) else {}
    if definition.get("dynamicPorts") == "subcircuit":
        definition_id = _identifier(config.get("definitionId"), "missing-subcircuit", issues, f"{path}.definitionId")
        revision = config.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            issues.append(_issue("invalid-subcircuit-revision", f"{path}.revision", "子电路修订必须是正整数"))
            revision = 1
        return {"definitionId": definition_id, "revision": revision}
    result = {}
    for field in definition.get("configFields", []):
        key = str(field.get("key") or "")
        field_type = field.get("type")
        value = config.get(key, field.get("default"))
        if field_type == "typedValue":
            result[key] = _typed_value(value, field.get("default") or {"type": "number", "value": 0}, issues, f"{path}.{key}")
        elif field_type == "boolean":
            if not isinstance(value, bool):
                issues.append(_issue("invalid-config", f"{path}.{key}", "必须是布尔值"))
                value = bool(field.get("default"))
            result[key] = value
        elif field_type == "integer":
            minimum = int(field.get("min", -9_007_199_254_740_991))
            maximum = int(field.get("max", 9_007_199_254_740_991))
            if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                    or int(value) != value or not minimum <= value <= maximum):
                issues.append(_issue("invalid-config", f"{path}.{key}", f"必须是 {minimum}–{maximum} 的整数"))
                value = field.get("default", minimum)
            result[key] = int(value)
        elif field_type == "select":
            options = [str(option) for option in field.get("options", [])]
            value = str(value)
            if value not in options:
                issues.append(_issue("invalid-config", f"{path}.{key}", "不是允许的配置选项"))
                value = str(field.get("default") or (options[0] if options else ""))
            result[key] = value
    return result


def _normalize_saved_state(node_type: str, source: dict, config: dict, issues: list[dict], path: str) -> dict:
    state = source if isinstance(source, dict) else {}
    if node_type == "toggle":
        if not isinstance(state.get("current"), bool):
            issues.append(_issue("invalid-saved-state", f"{path}.current", "开关状态必须是布尔值"))
        return {"current": state.get("current") is True}
    if node_type == "clock":
        remaining = state.get("remainingMs")
        if isinstance(remaining, bool) or not isinstance(remaining, (int, float)) or not math.isfinite(remaining) or remaining < 0:
            issues.append(_issue("invalid-saved-state", f"{path}.remainingMs", "时钟剩余时间必须是非负有限数值"))
            remaining = config.get("periodMs", 1000)
        return {"remainingMs": remaining}
    if node_type in {"register", "counter"}:
        current = _typed_value(state.get("current"), config["initial"], issues, f"{path}.current")
        initial = config["initial"]
        if current["type"] != initial["type"] or (current["type"] == "bits" and current["width"] != initial["width"]):
            issues.append(_issue("invalid-saved-state", f"{path}.current", "保存状态必须匹配初值类型与位宽"))
        return {"current": current}
    if node_type == "edge-detector":
        if not isinstance(state.get("previous"), bool):
            issues.append(_issue("invalid-saved-state", f"{path}.previous", "边沿状态必须是布尔值"))
        return {"previous": state.get("previous") is True}
    if node_type == "timer":
        duration = state.get("durationMs")
        elapsed = state.get("elapsedMs")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
            issues.append(_issue("invalid-saved-state", f"{path}.durationMs", "计时器时长必须是正有限数值"))
            duration = config.get("durationMs", 1)
        if isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or not 0 <= elapsed <= duration:
            issues.append(_issue("invalid-saved-state", f"{path}.elapsedMs", "计时进度必须处于有效范围"))
            elapsed = 0
        for key in ("running", "done"):
            if not isinstance(state.get(key), bool):
                issues.append(_issue("invalid-saved-state", f"{path}.{key}", "计时器状态必须是布尔值"))
        return {"durationMs": duration, "elapsedMs": elapsed,
                "running": state.get("running") is True, "done": state.get("done") is True}
    return {}


def _port(definition: dict, port_id: str, direction: str):
    for port in definition.get("ports", []):
        if str(port.get("id") or "") == port_id and port.get("direction") == direction:
            return port
    return None


def _subcircuit_revision(catalog: dict, definition_id: str, revision: int):
    definition = catalog.get(str(definition_id or "")) if isinstance(catalog, dict) else None
    if not definition:
        return None
    return next((item for item in definition.get("revisions", []) if item.get("revision") == revision), None)


def _node_definition(node: dict, catalog: dict):
    base = NODE_DEFINITIONS.get(node.get("type"))
    if not base or node.get("type") != "subcircuit":
        return base
    config = node.get("config") if isinstance(node.get("config"), dict) else {}
    revision = _subcircuit_revision(catalog, config.get("definitionId"), config.get("revision"))
    if not revision:
        return {**base, "ports": []}
    ports = []
    for port in revision.get("ports", []):
        value_type = str(port.get("valueType") or "")
        dynamic = {
            "id": str(port.get("id") or ""), "direction": port.get("direction"),
            "channel": port.get("channel"),
            "types": ["pulse"] if port.get("channel") == "event" else [value_type],
            "required": False,
            "multiple": port.get("channel") == "event" and port.get("direction") == "input",
        }
        if value_type == "bits":
            dynamic["bitsWidths"] = [port.get("bitsWidth")]
        ports.append(dynamic)
    return {**base, "ports": ports}


def _port_for_node(node: dict, port_id: str, direction: str, catalog: dict):
    definition = _node_definition(node, catalog)
    return _port(definition, port_id, direction) if definition else None


def _ports_compatible(from_node: dict, from_port_id: str, to_node: dict, to_port_id: str, catalog: dict) -> bool:
    from_definition = _node_definition(from_node, catalog)
    to_definition = _node_definition(to_node, catalog)
    if not from_definition or not to_definition:
        return False
    from_port = _port(from_definition, from_port_id, "output")
    to_port = _port(to_definition, to_port_id, "input")
    if not from_port or not to_port or from_port.get("channel") != to_port.get("channel"):
        return False
    if from_port.get("channel") == "event":
        return True
    from_types = set(map(str, from_port.get("types", ["any"])))
    to_types = set(map(str, to_port.get("types", ["any"])))
    return "any" in from_types or "any" in to_types or bool(from_types & to_types)


def _value_descriptor(node_id: str, port_id: str, node_by_id: dict, edges: list[dict], catalog: dict, seen=None):
    seen = set(seen or ())
    key = (node_id, port_id)
    if key in seen:
        return None
    seen.add(key)
    node = node_by_id.get(node_id)
    if not node:
        return None

    def typed(value):
        if not isinstance(value, dict) or value.get("type") not in VALUE_TYPES:
            return None
        result = {"type": value["type"]}
        if value["type"] == "bits":
            result["width"] = int(value.get("width") or 1)
        return result

    def incoming(input_port):
        edge = next((item for item in edges if item.get("kind") == "wire"
                     and item["to"]["nodeId"] == node_id and item["to"]["portId"] == input_port), None)
        return (_value_descriptor(edge["from"]["nodeId"], edge["from"]["portId"], node_by_id, edges, catalog, seen)
                if edge else None)

    node_type = node["type"]
    config = node.get("config") or {}
    if node_type == "subcircuit":
        port = _port_for_node(node, port_id, "output", catalog)
        if not port or port.get("channel") != "value":
            return None
        types = list(map(str, port.get("types", [])))
        if len(types) != 1 or types[0] == "any":
            return None
        result = {"type": types[0]}
        widths = port.get("bitsWidths") or []
        if types[0] == "bits" and len(widths) == 1:
            result["width"] = widths[0]
        return result
    if node_type == "constant" and port_id == "out":
        return typed(config.get("value"))
    if node_type == "toggle" and port_id == "out":
        return {"type": "boolean"}
    if node_type == "current-time" and port_id == "out":
        return {"type": "time"}
    if node_type == "timer":
        return {"type": "number"} if port_id == "time" else ({"type": "boolean"} if port_id == "running" else None)
    if node_type in {"register", "counter"} and port_id == "out":
        return typed(config.get("initial"))
    if node_type == "compare" and port_id == "out":
        return {"type": "boolean"}
    if node_type == "convert" and port_id == "out":
        result = {"type": config.get("toType")}
        if result["type"] == "bits":
            result["width"] = int(config.get("width") or 1)
        return result
    if node_type in {"math", "logic"} and port_id == "out":
        return incoming("a")
    if node_type == "select" and port_id == "out":
        return incoming("whenTrue") or incoming("whenFalse")
    if node_type == "bits" and port_id == "out":
        if config.get("operation") in {"slice", "resize"}:
            return {"type": "bits", "width": int(config.get("width") or 1)}
        left = incoming("a")
        right = incoming("b")
        if config.get("operation") == "concat" and left and right:
            return {"type": "bits", "width": left.get("width", 0) + right.get("width", 0)}
        return left
    return None


def _same_descriptor(left, right) -> bool:
    return bool(left and right and left.get("type") == right.get("type")
                and (left.get("type") != "bits" or left.get("width") == right.get("width")))


def _normalize_page(source, index: int, issues: list[dict], catalog=None, path_override: str | None = None) -> dict:
    catalog = catalog or {}
    path = path_override or f"pages[{index}]"
    page = source if isinstance(source, dict) else {}
    page_id = _identifier(page.get("id"), f"research-page-{index + 1}", issues, f"{path}.id")
    raw_nodes = page.get("nodes")
    if not isinstance(raw_nodes, list):
        issues.append(_issue("invalid-nodes", f"{path}.nodes", "nodes 必须是数组"))
        raw_nodes = []
    if len(raw_nodes) > MAX_NODES_PER_PAGE:
        issues.append(_issue("too-many-nodes", f"{path}.nodes", "单页节点数量超过安全上限"))
        raw_nodes = raw_nodes[:MAX_NODES_PER_PAGE]
    nodes = []
    node_by_id = {}
    for node_index, raw_node in enumerate(raw_nodes):
        node_path = f"{path}.nodes[{node_index}]"
        node = raw_node if isinstance(raw_node, dict) else {}
        node_id = _identifier(node.get("id"), f"node-{node_index + 1}", issues, f"{node_path}.id")
        if node_id in node_by_id:
            issues.append(_issue("duplicate-node-id", f"{node_path}.id", f"节点 ID 重复：{node_id}"))
            continue
        node_type = str(node.get("type") or "")
        definition = NODE_DEFINITIONS.get(node_type)
        if not definition:
            issues.append(_issue("unsupported-node-type", f"{node_path}.type", f"不支持的节点：{node_type}"))
            definition = {"configFields": [], "stateful": False}
        label = str(node.get("label") or definition.get("defaultLabel") or "")
        if len(label) > MAX_LABEL_LENGTH:
            issues.append(_issue("label-too-large", f"{node_path}.label", "节点标签超过安全上限"))
            label = label[:MAX_LABEL_LENGTH]
        state_policy = "persist" if definition.get("stateful") and node.get("statePolicy") == "persist" else "reset"
        normalized = {
            "id": node_id, "type": node_type, "label": label,
            "x": _finite(node.get("x"), 0, issues, f"{node_path}.x"),
            "y": _finite(node.get("y"), 0, issues, f"{node_path}.y"),
            "width": max(96, _finite(node.get("width"), 176, issues, f"{node_path}.width")),
            "height": max(48, _finite(node.get("height"), 72, issues, f"{node_path}.height")),
            "config": _normalize_config(definition, node.get("config"), issues, f"{node_path}.config"),
            "statePolicy": state_policy,
        }
        if node_type == "subcircuit" and not _subcircuit_revision(
                catalog, normalized["config"].get("definitionId"), normalized["config"].get("revision")):
            issues.append(_issue("missing-subcircuit-revision", f"{node_path}.config", "子电路实例引用了不存在的修订"))
        if state_policy == "persist" and isinstance(node.get("savedState"), dict):
            saved_json = json.dumps(node["savedState"], ensure_ascii=False)
            if len(saved_json.encode("utf-8")) <= 64_000:
                normalized["savedState"] = _normalize_saved_state(
                    node_type, node["savedState"], normalized["config"], issues, f"{node_path}.savedState"
                )
            else:
                issues.append(_issue("state-too-large", f"{node_path}.savedState", "节点状态超过安全上限"))
        if node_type == "subcircuit" and isinstance(node.get("savedState"), dict):
            saved_json = json.dumps(node["savedState"], ensure_ascii=False)
            if len(saved_json.encode("utf-8")) <= 64_000:
                normalized["savedState"] = node["savedState"]
            else:
                issues.append(_issue("state-too-large", f"{node_path}.savedState", "子电路实例状态超过安全上限"))
        nodes.append(normalized)
        node_by_id[node_id] = normalized

    raw_edges = page.get("edges")
    if not isinstance(raw_edges, list):
        issues.append(_issue("invalid-edges", f"{path}.edges", "edges 必须是数组"))
        raw_edges = []
    if len(raw_edges) > MAX_EDGES_PER_PAGE:
        issues.append(_issue("too-many-edges", f"{path}.edges", "单页连线数量超过安全上限"))
        raw_edges = raw_edges[:MAX_EDGES_PER_PAGE]
    edges = []
    edge_ids = set()
    occupied_value_inputs = set()
    for edge_index, raw_edge in enumerate(raw_edges):
        edge_path = f"{path}.edges[{edge_index}]"
        edge = raw_edge if isinstance(raw_edge, dict) else {}
        edge_id = _identifier(edge.get("id"), f"edge-{edge_index + 1}", issues, f"{edge_path}.id")
        if edge_id in edge_ids:
            issues.append(_issue("duplicate-edge-id", f"{edge_path}.id", f"连线 ID 重复：{edge_id}"))
            continue
        edge_ids.add(edge_id)
        if edge.get("kind") == "wire":
            from_value = edge.get("from") if isinstance(edge.get("from"), dict) else {}
            to_value = edge.get("to") if isinstance(edge.get("to"), dict) else {}
            from_node_id = str(from_value.get("nodeId") or "")
            to_node_id = str(to_value.get("nodeId") or "")
            from_port_id = str(from_value.get("portId") or "")
            to_port_id = str(to_value.get("portId") or "")
            from_node = node_by_id.get(from_node_id)
            to_node = node_by_id.get(to_node_id)
            if not from_node or not to_node or from_node_id == to_node_id:
                issues.append(_issue("invalid-wire-endpoint", edge_path, "导线端点无效", edgeId=edge_id))
            elif not _ports_compatible(from_node, from_port_id, to_node, to_port_id, catalog):
                issues.append(_issue("incompatible-wire", edge_path, "导线端口不兼容", edgeId=edge_id))
            else:
                target_port = _port_for_node(to_node, to_port_id, "input", catalog)
                if target_port and target_port.get("channel") == "value":
                    input_key = (to_node_id, to_port_id)
                    if input_key in occupied_value_inputs:
                        issues.append(_issue("duplicate-value-input", edge_path, "值输入端口只能连接一条导线", edgeId=edge_id))
                    occupied_value_inputs.add(input_key)
            edges.append({"id": edge_id, "kind": "wire", "from": {"nodeId": from_node_id, "portId": from_port_id}, "to": {"nodeId": to_node_id, "portId": to_port_id}})
        else:
            from_node_id = str(edge.get("fromNodeId") or "")
            to_node_id = str(edge.get("toNodeId") or "")
            if from_node_id not in node_by_id or to_node_id not in node_by_id or from_node_id == to_node_id:
                issues.append(_issue("invalid-relation-endpoint", edge_path, "关系线端点无效", edgeId=edge_id))
            edges.append({"id": edge_id, "kind": "relation", "fromNodeId": from_node_id, "toNodeId": to_node_id})

    for edge_index, edge in enumerate(edges):
        if edge.get("kind") != "wire":
            continue
        source = _value_descriptor(edge["from"]["nodeId"], edge["from"]["portId"], node_by_id, edges, catalog)
        target_node = node_by_id.get(edge["to"]["nodeId"])
        if not source or not target_node:
            continue
        target_port = _port_for_node(target_node, edge["to"]["portId"], "input", catalog)
        if not target_port or target_port.get("channel") != "value":
            continue
        allowed_widths = target_port.get("bitsWidths") or []
        if source.get("type") == "bits" and allowed_widths and source.get("width") not in allowed_widths:
            issues.append(_issue("incompatible-bits-width", f"{path}.edges[{edge_index}]",
                                 "Bits 位宽与目标端口不兼容", edgeId=edge["id"]))
        match_group = str(target_port.get("matchGroup") or "")
        if match_group:
            target_definition = _node_definition(target_node, catalog) or {"ports": []}
            peer_ports = {str(port.get("id")) for port in target_definition.get("ports", [])
                          if port.get("direction") == "input" and port.get("matchGroup") == match_group
                          and str(port.get("id")) != edge["to"]["portId"]}
            peer_edge = next((item for item in edges if item.get("kind") == "wire"
                              and item["to"]["nodeId"] == target_node["id"]
                              and item["to"]["portId"] in peer_ports), None)
            peer = (_value_descriptor(peer_edge["from"]["nodeId"], peer_edge["from"]["portId"], node_by_id, edges, catalog)
                    if peer_edge else None)
            if peer and not _same_descriptor(source, peer):
                issues.append(_issue("mismatched-value-inputs", f"{path}.edges[{edge_index}]",
                                     "同组输入必须使用相同类型与 Bits 位宽", edgeId=edge["id"]))
        if ((target_node["type"] == "register" and edge["to"]["portId"] == "data")
                or (target_node["type"] == "counter" and edge["to"]["portId"] == "loadValue")):
            expected = {"type": target_node["config"]["initial"]["type"]}
            if expected["type"] == "bits":
                expected["width"] = target_node["config"]["initial"]["width"]
            if not _same_descriptor(source, expected):
                issues.append(_issue("state-input-type-mismatch", f"{path}.edges[{edge_index}]",
                                     "状态输入必须匹配节点初值类型与位宽", edgeId=edge["id"]))
    view = page.get("view") if isinstance(page.get("view"), dict) else {}
    simulation = page.get("simulation") if isinstance(page.get("simulation"), dict) else {}
    speed = simulation.get("speed", 1)
    if speed not in ALLOWED_SPEEDS:
        issues.append(_issue("invalid-speed", f"{path}.simulation.speed", "仿真速度无效"))
        speed = 1
    return {
        "id": page_id, "title": str(page.get("title") or ""), "nodes": nodes, "edges": edges,
        "view": {"x": _finite(view.get("x"), 0, issues, f"{path}.view.x"), "y": _finite(view.get("y"), 0, issues, f"{path}.view.y"), "scale": min(3.5, max(0.18, _finite(view.get("scale"), 1, issues, f"{path}.view.scale")))},
        "simulation": {"speed": speed},
    }


def _normalize_subcircuits(source, issues: list[dict]):
    raw_items = source if isinstance(source, list) else []
    if not isinstance(source, list):
        issues.append(_issue("invalid-subcircuits", "subcircuits", "subcircuits 必须是数组"))
    if len(raw_items) > MAX_SUBCIRCUITS:
        issues.append(_issue("too-many-subcircuits", "subcircuits", "子电路定义数量超过安全上限"))
        raw_items = raw_items[:MAX_SUBCIRCUITS]
    definitions = []
    catalog = {}
    for definition_index, raw_definition in enumerate(raw_items):
        path = f"subcircuits[{definition_index}]"
        item = raw_definition if isinstance(raw_definition, dict) else {}
        definition_id = _identifier(item.get("id"), f"subcircuit-{definition_index + 1}", issues, f"{path}.id")
        if definition_id in catalog:
            issues.append(_issue("duplicate-subcircuit-id", f"{path}.id", "子电路定义 ID 重复"))
            continue
        raw_revisions = item.get("revisions") if isinstance(item.get("revisions"), list) else []
        if not raw_revisions:
            issues.append(_issue("invalid-subcircuit-revisions", f"{path}.revisions", "子电路必须至少包含一个修订"))
        if len(raw_revisions) > MAX_REVISIONS_PER_SUBCIRCUIT:
            issues.append(_issue("too-many-subcircuit-revisions", f"{path}.revisions", "子电路修订数量超过安全上限"))
            raw_revisions = raw_revisions[:MAX_REVISIONS_PER_SUBCIRCUIT]
        revisions = []
        revision_numbers = set()
        for revision_index, raw_revision in enumerate(raw_revisions):
            revision_path = f"{path}.revisions[{revision_index}]"
            revision_source = raw_revision if isinstance(raw_revision, dict) else {}
            revision_number = revision_source.get("revision")
            if isinstance(revision_number, bool) or not isinstance(revision_number, int) or revision_number < 1:
                issues.append(_issue("invalid-subcircuit-revision", f"{revision_path}.revision", "修订号必须是正整数"))
                revision_number = revision_index + 1
            if revision_number in revision_numbers:
                issues.append(_issue("duplicate-subcircuit-revision", f"{revision_path}.revision", "子电路修订号重复"))
                continue
            revision_numbers.add(revision_number)
            ports = []
            port_ids = set()
            raw_ports = revision_source.get("ports") if isinstance(revision_source.get("ports"), list) else []
            for port_index, raw_port in enumerate(raw_ports):
                port_path = f"{revision_path}.ports[{port_index}]"
                port = raw_port if isinstance(raw_port, dict) else {}
                port_id = _identifier(port.get("id"), f"port-{port_index + 1}", issues, f"{port_path}.id")
                if port_id in port_ids:
                    issues.append(_issue("duplicate-subcircuit-port", f"{port_path}.id", "子电路端口 ID 重复"))
                    continue
                port_ids.add(port_id)
                direction = "output" if port.get("direction") == "output" else "input"
                channel = "event" if port.get("channel") == "event" else "value"
                value_type = "pulse" if channel == "event" else str(port.get("valueType") or "")
                if channel == "value" and value_type not in VALUE_TYPES:
                    issues.append(_issue("invalid-subcircuit-port-type", f"{port_path}.valueType", "子电路值端口类型无效"))
                    value_type = "number"
                normalized_port = {
                    "id": port_id, "name": str(port.get("name") or port_id), "direction": direction,
                    "channel": channel, "valueType": value_type,
                    "nodeId": _identifier(port.get("nodeId"), "missing-node", issues, f"{port_path}.nodeId"),
                    "portId": _identifier(port.get("portId"), "missing-port", issues, f"{port_path}.portId"),
                }
                if value_type == "bits":
                    width = port.get("bitsWidth")
                    if isinstance(width, bool) or not isinstance(width, int) or not 1 <= width <= 64:
                        issues.append(_issue("invalid-bits-width", f"{port_path}.bitsWidth", "Bits 位宽必须是 1–64"))
                        width = 1
                    normalized_port["bitsWidth"] = width
                ports.append(normalized_port)
            revisions.append({
                "revision": revision_number, "ports": ports,
                "nodes": revision_source.get("nodes") if isinstance(revision_source.get("nodes"), list) else [],
                "edges": revision_source.get("edges") if isinstance(revision_source.get("edges"), list) else [],
            })
        revisions.sort(key=lambda revision: revision["revision"])
        requested_latest = item.get("latestRevision")
        latest = revisions[-1]["revision"] if revisions else 0
        if requested_latest != latest:
            issues.append(_issue("invalid-latest-revision", f"{path}.latestRevision", "最新修订必须指向最大修订号"))
        definition = {"id": definition_id, "name": str(item.get("name") or f"子电路 {definition_index + 1}"),
                      "latestRevision": latest, "revisions": revisions}
        definitions.append(definition)
        catalog[definition_id] = definition

    for definition_index, definition in enumerate(definitions):
        for revision_index, revision in enumerate(definition["revisions"]):
            path = f"subcircuits[{definition_index}].revisions[{revision_index}]"
            normalized_graph = _normalize_page(
                {"id": f"definition-{definition_index}-{revision_index}", "nodes": revision["nodes"], "edges": revision["edges"],
                 "view": {"x": 0, "y": 0, "scale": 1}, "simulation": {"speed": 1}},
                revision_index, issues, catalog, path,
            )
            revision["nodes"] = normalized_graph["nodes"]
            revision["edges"] = normalized_graph["edges"]
            for node in revision["nodes"]:
                node.pop("savedState", None)
            node_by_id = {node["id"]: node for node in revision["nodes"]}
            for port_index, port in enumerate(revision["ports"]):
                node = node_by_id.get(port["nodeId"])
                bound = _port_for_node(node, port["portId"], port["direction"], catalog) if node else None
                if not bound:
                    issues.append(_issue("invalid-subcircuit-port-binding", f"{path}.ports[{port_index}]", "子电路端口绑定不存在"))
                elif bound.get("channel") != port["channel"]:
                    issues.append(_issue("invalid-subcircuit-port-channel", f"{path}.ports[{port_index}]", "子电路端口通道不一致"))
                elif port["channel"] == "value" and "any" not in bound.get("types", ["any"]) and port["valueType"] not in bound.get("types", []):
                    issues.append(_issue("invalid-subcircuit-port-type", f"{path}.ports[{port_index}]", "子电路端口类型与绑定不一致"))
                elif (port["valueType"] == "bits" and bound.get("bitsWidths")
                      and port.get("bitsWidth") not in bound.get("bitsWidths")):
                    issues.append(_issue("invalid-subcircuit-port-width", f"{path}.ports[{port_index}]", "子电路 Bits 位宽与绑定不一致"))

    colors = {}
    def visit(definition_id, revision_number, stack):
        key = (definition_id, revision_number)
        revision = _subcircuit_revision(catalog, definition_id, revision_number)
        if not revision:
            issues.append(_issue("missing-subcircuit-revision", "subcircuits", "子电路实例引用了不存在的修订"))
            return
        if len(stack) >= MAX_SUBCIRCUIT_DEPTH:
            issues.append(_issue("subcircuit-depth", "subcircuits", "子电路嵌套深度超过 32 层"))
            return
        if colors.get(key) == 1:
            issues.append(_issue("subcircuit-cycle", "subcircuits", "子电路修订不能形成递归依赖"))
            return
        if colors.get(key) == 2:
            return
        colors[key] = 1
        for node in revision["nodes"]:
            if node.get("type") == "subcircuit":
                config = node.get("config") or {}
                visit(config.get("definitionId"), config.get("revision"), stack + [key])
        colors[key] = 2
    for definition in definitions:
        for revision in definition["revisions"]:
            visit(definition["id"], revision["revision"], [])
    return definitions, catalog


def _expanded_graph_size(nodes: list[dict], edges: list[dict], catalog: dict, stack=None, memo=None):
    stack = set(stack or ())
    memo = memo if memo is not None else {}
    node_count = 0
    edge_count = len(edges)
    for node in nodes:
        if node.get("type") != "subcircuit":
            node_count += 1
            continue
        config = node.get("config") or {}
        key = (config.get("definitionId"), config.get("revision"))
        if key in stack:
            continue
        if key not in memo:
            revision = _subcircuit_revision(catalog, key[0], key[1])
            memo[key] = _expanded_graph_size(revision.get("nodes", []), revision.get("edges", []), catalog,
                                             stack | {key}, memo) if revision else (0, 0)
        child_nodes, child_edges = memo[key]
        node_count += child_nodes
        edge_count += child_edges
        if node_count > MAX_NODES_PER_PAGE or edge_count > MAX_EDGES_PER_PAGE:
            break
    return node_count, edge_count


def normalize_research_document(source) -> dict:
    if not isinstance(source, dict):
        raise ResearchStoreError("研究数据顶层必须是对象")
    issues: list[dict] = []
    if source.get("researchVersion") != RESEARCH_VERSION or isinstance(source.get("researchVersion"), bool):
        issues.append(_issue("unsupported-version", "researchVersion", f"不支持的研究数据版本：{source.get('researchVersion')}"))
    subcircuits, catalog = _normalize_subcircuits(source.get("subcircuits"), issues)
    raw_pages = source.get("pages")
    if not isinstance(raw_pages, list) or not raw_pages:
        issues.append(_issue("invalid-pages", "pages", "研究数据必须至少包含一页"))
        raw_pages = empty_research_document()["pages"]
    if len(raw_pages) > MAX_PAGES:
        issues.append(_issue("too-many-pages", "pages", "研究页数量超过安全上限"))
        raw_pages = raw_pages[:MAX_PAGES]
    pages = []
    page_ids = set()
    for index, raw_page in enumerate(raw_pages):
        page = _normalize_page(raw_page, index, issues, catalog)
        if page["id"] in page_ids:
            issues.append(_issue("duplicate-page-id", f"pages[{index}].id", f"页面 ID 重复：{page['id']}"))
            continue
        page_ids.add(page["id"])
        pages.append(page)
    active_page_id = str(source.get("activePageId") or "")
    if active_page_id not in page_ids:
        issues.append(_issue("invalid-active-page", "activePageId", "活动页不存在"))
        active_page_id = pages[0]["id"] if pages else "research-page-1"
    expansion_memo = {}
    for index, page in enumerate(pages):
        expanded_nodes, expanded_edges = _expanded_graph_size(page["nodes"], page["edges"], catalog, memo=expansion_memo)
        if expanded_nodes > MAX_NODES_PER_PAGE or expanded_edges > MAX_EDGES_PER_PAGE:
            issues.append(_issue("subcircuit-expansion-budget", f"pages[{index}]", "子电路展开后的图超过单页安全上限"))
    if issues:
        raise ResearchStoreError("研究数据校验失败", issues=issues)
    return {"researchVersion": RESEARCH_VERSION, "subcircuits": subcircuits,
            "pages": pages, "activePageId": active_page_id}


def _encoded(document: dict) -> bytes:
    return json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8")


def _revision(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _immutable_revision_issues(previous: dict, incoming: dict) -> list[dict]:
    """Reject in-place edits and revision-number reuse for surviving definitions."""
    issues = []
    previous_definitions = {item["id"]: item for item in previous.get("subcircuits", [])}
    for definition_index, definition in enumerate(incoming.get("subcircuits", [])):
        old_definition = previous_definitions.get(definition["id"])
        if not old_definition:
            continue
        old_revisions = {item["revision"]: item for item in old_definition.get("revisions", [])}
        old_maximum = max(old_revisions, default=0)
        for revision_index, revision in enumerate(definition.get("revisions", [])):
            number = revision["revision"]
            path = f"subcircuits[{definition_index}].revisions[{revision_index}]"
            if number in old_revisions:
                if revision != old_revisions[number]:
                    issues.append(_issue(
                        "immutable-subcircuit-revision", path,
                        "已发布的子电路修订不可修改；请发布新修订",
                        definitionId=definition["id"], revision=number,
                    ))
            elif number <= old_maximum:
                issues.append(_issue(
                    "nonmonotonic-subcircuit-revision", f"{path}.revision",
                    "新子电路修订号必须大于已有修订号",
                    definitionId=definition["id"], revision=number,
                ))
    return issues


class ResearchWorkspaceStore:
    def __init__(self, root: Path, *, atomic_json: Callable[[Path, dict], None]):
        self.root = Path(root)
        self.primary = self.root / "workspace.json"
        self.backup = self.root / "workspace.backup.json"
        self.atomic_json = atomic_json

    def _read_valid(self, path: Path):
        content = path.read_bytes()
        document = normalize_research_document(json.loads(content.decode("utf-8-sig")))
        return document, _revision(content)

    def _quarantine(self) -> str:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = self.root / f"workspace.corrupt-{stamp}.json"
        if target.exists():
            target = self.root / f"workspace.corrupt-{stamp}-{uuid.uuid4().hex[:6]}.json"
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            os.replace(self.primary, target)
        except OSError:
            target.write_bytes(self.primary.read_bytes())
            self.primary.unlink(missing_ok=True)
        return target.name

    def load(self) -> dict:
        if self.primary.is_file():
            try:
                content = self.primary.read_bytes()
                source = json.loads(content.decode("utf-8-sig"))
                if isinstance(source, dict) and source.get("researchVersion") != RESEARCH_VERSION:
                    return {"document": empty_research_document(), "revision": _revision(content), "recovered": False, "legacyDiscarded": True}
                document = normalize_research_document(source)
                return {"document": document, "revision": _revision(content), "recovered": False}
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ResearchStoreError):
                return self._recover(self._quarantine())
        if self.backup.is_file():
            return self._recover(None)
        return {"document": empty_research_document(), "revision": "", "recovered": False}

    def _recover(self, corrupt_name: str | None) -> dict:
        source = "empty"
        document = empty_research_document()
        if self.backup.is_file():
            try:
                document, _ = self._read_valid(self.backup)
                source = "backup"
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ResearchStoreError):
                pass
        self.atomic_json(self.primary, document)
        return {"document": document, "revision": _revision(_encoded(document)), "recovered": True, "recovery": {"source": source, "corruptFile": corrupt_name or ""}}

    def save(self, source, expected_revision: str) -> dict:
        document = normalize_research_document(source)
        current = self.load()
        current_revision = str(current.get("revision") or "")
        if str(expected_revision or "") != current_revision:
            raise ResearchConflictError(current_revision)
        if not current.get("legacyDiscarded"):
            immutable_issues = _immutable_revision_issues(current["document"], document)
            if immutable_issues:
                raise ResearchStoreError("子电路修订校验失败", issues=immutable_issues)
        if self.primary.is_file() and not current.get("legacyDiscarded"):
            try:
                previous, _ = self._read_valid(self.primary)
                self.atomic_json(self.backup, previous)
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ResearchStoreError):
                pass
        self.atomic_json(self.primary, document)
        return {"document": document, "revision": _revision(_encoded(document)), "recovered": False}
