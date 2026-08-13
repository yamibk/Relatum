import json
import tempfile
import unittest
from pathlib import Path

import app


class StudyGoalTreeV4Tests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_study_file = app.STUDY_FILE
        app.STUDY_FILE = Path(self.temp_dir.name) / "study.json"

    def tearDown(self):
        app.STUDY_FILE = self.original_study_file
        self.temp_dir.cleanup()

    def task(self, title, **patch):
        return app._study_task({"title": title, **patch})

    def data(self, *tasks):
        tree = app._study_goal_new_tree("目标 1", 0)
        return {
            "version": 6,
            "tasks": list(tasks),
            "trash": [],
            "goalTrees": [tree],
            "activeTreeId": tree["id"],
        }

    @staticmethod
    def primary(source=None, link_type="contains", **extra):
        value = {"from": source, "type": link_type, **extra}
        if link_type == "requires" and "trigger" not in value:
            value["trigger"] = {"kind": "complete"}
        return value

    def attach(self, data, task, primary=None, tree_id=None):
        body = {
            "command": "attach-task",
            "taskId": task["id"],
            "primaryLink": primary or self.primary(side="right"),
        }
        if tree_id:
            body["treeId"] = tree_id
        return app.apply_study_goal_tree_command(data, body)["nodeId"]

    def branch(self, data, title, primary=None, tree_id=None):
        body = {
            "command": "create-branch",
            "title": title,
            "primaryLink": primary or self.primary(side="right"),
        }
        if tree_id:
            body["treeId"] = tree_id
        return app.apply_study_goal_tree_command(data, body)["nodeId"]

    def test_fresh_and_strict_v6_roundtrip(self):
        fresh = app.load_study()
        self.assertEqual(fresh["version"], 6)
        self.assertNotIn("goalTree", fresh)
        self.assertEqual(fresh["goalTrees"][0]["version"], 2)
        self.assertEqual(fresh["goalTrees"][0]["links"], [])
        app.save_study(fresh)
        loaded = app.load_study()
        self.assertEqual(loaded, fresh)

    def test_old_version_is_rejected_without_overwrite(self):
        original = json.dumps({"version": 5, "tasks": [], "trash": []}, ensure_ascii=False)
        app.STUDY_FILE.write_text(original, encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "不兼容"):
            app.load_study()
        self.assertEqual(app.STUDY_FILE.read_text(encoding="utf-8"), original)

    def test_task_to_stage_and_milestone_to_stage(self):
        task = self.task("基础", progress={
            "target": 10,
            "milestones": [{"id": "half", "name": "一半", "at": 5}],
        })
        data = self.data(task)
        task_node = self.attach(data, task)
        complete_stage = self.branch(data, "完成后", self.primary(task_node, "requires"))
        point_stage = self.branch(data, "任务点后", self.primary(
            task_node, "requires", trigger={"kind": "milestone", "milestoneId": "half"},
        ))
        links = {link["to"]: link for link in data["goalTrees"][0]["links"]}
        self.assertEqual(links[complete_stage]["trigger"], {"kind": "complete"})
        self.assertEqual(links[point_stage]["trigger"]["milestoneId"], "half")

    def test_stage_to_stage_and_contains_rules(self):
        data = self.data()
        first = self.branch(data, "第一阶段")
        contained = self.branch(data, "子阶段", self.primary(first))
        following = self.branch(data, "下一阶段", self.primary(first, "requires"))
        links = {link["to"]: link for link in data["goalTrees"][0]["links"]}
        self.assertEqual(links[contained]["type"], "contains")
        self.assertEqual(links[following]["type"], "requires")

    def test_secondary_requirements_add_remove_and_primary_is_protected(self):
        first, second = self.task("A"), self.task("B")
        data = self.data(first, second)
        first_node = self.attach(data, first)
        second_node = self.attach(data, second)
        result = app.apply_study_goal_tree_command(data, {
            "command": "add-requirement", "fromNodeId": first_node,
            "toNodeId": second_node, "trigger": {"kind": "complete"},
        })
        app.apply_study_goal_tree_command(data, {
            "command": "remove-requirement", "linkId": result["linkId"],
        })
        self.assertFalse(any(not link["primary"] for link in data["goalTrees"][0]["links"]))
        primary_id = next(link["id"] for link in data["goalTrees"][0]["links"] if link["to"] == second_node)
        with self.assertRaisesRegex(ValueError, "移动节点"):
            app.apply_study_goal_tree_command(data, {
                "command": "remove-requirement", "linkId": primary_id,
            })

    def test_clear_primary_requirement_returns_subtree_to_same_root_side(self):
        first, child, guard = self.task("A"), self.task("B"), self.task("C")
        data = self.data(first, child, guard)
        first_node = self.attach(data, first, self.primary(side="left"))
        child_node = self.attach(data, child, self.primary(first_node, "requires"))
        child_stage = self.branch(data, "子阶段", self.primary(child_node, "requires"))
        guard_node = self.attach(data, guard)
        extra = app.apply_study_goal_tree_command(data, {
            "command": "add-requirement", "fromNodeId": guard_node,
            "toNodeId": child_node, "trigger": {"kind": "complete"},
        })["linkId"]

        app.apply_study_goal_tree_command(data, {
            "command": "clear-primary-requirement", "nodeId": child_node,
        })
        tree = data["goalTrees"][0]
        primary = next(link for link in tree["links"] if link["to"] == child_node and link["primary"])
        self.assertEqual(primary["type"], "contains")
        self.assertIsNone(primary["from"])
        self.assertEqual(primary["side"], "left")
        self.assertTrue(any(link["to"] == child_stage and link["from"] == child_node for link in tree["links"]))
        self.assertTrue(any(link["id"] == extra for link in tree["links"]))

    def test_semantic_duplicate_between_primary_and_secondary_is_rejected(self):
        first, second = self.task("A"), self.task("B")
        data = self.data(first, second)
        first_node = self.attach(data, first)
        second_node = self.attach(data, second, self.primary(first_node, "requires"))
        with self.assertRaisesRegex(ValueError, "已经存在"):
            app.apply_study_goal_tree_command(data, {
                "command": "add-requirement", "fromNodeId": first_node,
                "toNodeId": second_node, "trigger": {"kind": "complete"},
            })

    def test_route_availability_blocks_progress_until_all_conditions_complete(self):
        first, second = self.task("A"), self.task("B", progress={"target": 10})
        data = self.data(first, second)
        first_node = self.attach(data, first)
        self.attach(data, second, self.primary(first_node, "requires"))
        tree_id = data["activeTreeId"]
        with self.assertRaisesRegex(RuntimeError, "解锁"):
            app._study_goal_assert_task_available(data, tree_id, second["id"])
        first["status"] = "done"
        app._study_goal_assert_task_available(data, tree_id, second["id"])
        # 普通学习清单不携带目标树 ID，因此不会被某一棵共享路线锁死。
        app._study_goal_assert_task_available(data, "", second["id"])

    def test_route_api_rejects_locked_progress_but_plain_list_can_update(self):
        first = self.task("A")
        second = self.task("B", progress={"target": 10})
        data = self.data(first, second)
        first_node = self.attach(data, first)
        self.attach(data, second, self.primary(first_node, "requires"))
        app.save_study(data)

        class CaptureHandler:
            def __init__(self):
                self.response = None

            def _send_json(self, status, payload):
                self.response = (status, payload)
                return self.response

        handler = CaptureHandler()
        app.Handler._api_study_task_progress(handler, {
            "id": second["id"], "delta": 1, "goalTreeId": data["activeTreeId"],
        })
        self.assertEqual(handler.response[0], 409)
        self.assertEqual(app.load_study()["tasks"][1]["progress"]["current"], 0)

        app.Handler._api_study_task_progress(handler, {"id": second["id"], "delta": 1})
        self.assertEqual(handler.response[0], 200)
        self.assertEqual(app.load_study()["tasks"][1]["progress"]["current"], 1)

    def test_task_update_api_rejects_removing_referenced_milestone_without_overwrite(self):
        source = self.task("A", progress={
            "target": 10,
            "milestones": [{"id": "half", "name": "一半", "at": 5}],
        })
        target = self.task("B")
        data = self.data(source, target)
        source_node = self.attach(data, source)
        target_node = self.attach(data, target)
        app.apply_study_goal_tree_command(data, {
            "command": "add-requirement",
            "fromNodeId": source_node,
            "toNodeId": target_node,
            "trigger": {"kind": "milestone", "milestoneId": "half"},
        })
        app.save_study(data)

        class CaptureHandler:
            def __init__(self):
                self.response = None

            def _send_json(self, status, payload):
                self.response = (status, payload)
                return self.response

        handler = CaptureHandler()
        app.Handler._api_study_task_update(handler, {
            "id": source["id"],
            "progress": {"target": 10, "milestones": []},
        })

        self.assertEqual(handler.response[0], 400)
        self.assertIn("请先移除对应的解锁条件", handler.response[1]["error"])
        persisted = app.load_study()
        self.assertEqual(persisted["tasks"][0]["progress"]["milestones"][0]["id"], "half")
        self.assertTrue(any(
            link.get("trigger", {}).get("milestoneId") == "half"
            for link in persisted["goalTrees"][0]["links"]
        ))

    def test_dependency_cycle_is_rejected(self):
        first, second = self.task("A"), self.task("B")
        data = self.data(first, second)
        first_node = self.attach(data, first)
        second_node = self.attach(data, second, self.primary(first_node, "requires"))
        with self.assertRaisesRegex(ValueError, "循环"):
            app.apply_study_goal_tree_command(data, {
                "command": "add-requirement", "fromNodeId": second_node,
                "toNodeId": first_node, "trigger": {"kind": "complete"},
            })

    def test_primary_cycle_is_rejected(self):
        data = self.data()
        first = self.branch(data, "A")
        second = self.branch(data, "B", self.primary(first))
        with self.assertRaisesRegex(ValueError, "循环"):
            app.apply_study_goal_tree_command(data, {
                "command": "move-node", "nodeId": first,
                "primaryLink": self.primary(second),
            })

    def test_stage_self_lock_and_invalid_milestone_are_rejected(self):
        task = self.task("A", progress={"target": 3, "milestones": []})
        data = self.data(task)
        stage = self.branch(data, "阶段")
        task_node = self.attach(data, task, self.primary(stage))
        with self.assertRaisesRegex(ValueError, "自身"):
            app.apply_study_goal_tree_command(data, {
                "command": "add-requirement", "fromNodeId": task_node,
                "toNodeId": stage, "trigger": {"kind": "complete"},
            })
        data = self.data(task)
        task_node = self.attach(data, task)
        with self.assertRaisesRegex(ValueError, "任务点"):
            self.branch(data, "错误", self.primary(
                task_node, "requires", trigger={"kind": "milestone", "milestoneId": "missing"},
            ))

    def test_duplicate_task_and_dangling_reference_are_rejected(self):
        task = self.task("A")
        data = self.data(task)
        self.attach(data, task)
        with self.assertRaisesRegex(ValueError, "已经"):
            self.attach(data, task)
        tree = data["goalTrees"][0]
        tree["links"][0]["from"] = "missing"
        with self.assertRaisesRegex(ValueError, "引用"):
            app._study_goal_normalize_trees([tree], data["tasks"], strict=True)

    def test_delete_branch_cleans_subtree_and_all_related_links(self):
        first, outside = self.task("内部"), self.task("外部")
        data = self.data(first, outside)
        stage = self.branch(data, "阶段")
        inside_node = self.attach(data, first, self.primary(stage))
        outside_node = self.attach(data, outside)
        app.apply_study_goal_tree_command(data, {
            "command": "add-requirement", "fromNodeId": inside_node,
            "toNodeId": outside_node, "trigger": {"kind": "complete"},
        })
        app.apply_study_goal_tree_command(data, {"command": "delete-branch", "nodeId": stage})
        tree = data["goalTrees"][0]
        self.assertNotIn(stage, {node["id"] for node in tree["nodes"]})
        self.assertNotIn(inside_node, {node["id"] for node in tree["nodes"]})
        self.assertTrue(all(link.get("from") not in {stage, inside_node} for link in tree["links"]))
        self.assertIn(first, data["tasks"])

    def test_multi_tree_isolation_and_shared_task(self):
        task = self.task("共享")
        data = self.data(task)
        first_tree = data["activeTreeId"]
        first_node = self.attach(data, task)
        second_tree = app.apply_study_goal_tree_command(data, {"command": "create-tree"})["treeId"]
        second_node = self.attach(data, task, tree_id=second_tree)
        self.assertNotEqual(first_node, second_node)
        app.apply_study_goal_tree_command(data, {
            "command": "detach-task", "treeId": second_tree, "taskId": task["id"],
        })
        first = next(tree for tree in data["goalTrees"] if tree["id"] == first_tree)
        second = next(tree for tree in data["goalTrees"] if tree["id"] == second_tree)
        self.assertEqual(len(first["nodes"]), 1)
        self.assertEqual(second["nodes"], [])

    def test_safety_limits(self):
        tree = app._study_goal_new_tree("大树", 0)
        tree["nodes"] = [{"id": f"n{i}", "kind": "branch", "title": str(i)} for i in range(app.STUDY_GOAL_TREE_NODES_MAX + 1)]
        with self.assertRaisesRegex(ValueError, "节点数量"):
            app._study_goal_normalize_trees([tree], [], strict=True)

    def test_link_and_depth_limits(self):
        tree = app._study_goal_new_tree("links", 0)
        tree["links"] = [{} for _ in range(app.STUDY_GOAL_TREE_LINKS_MAX + 1)]
        with self.assertRaises(ValueError):
            app._study_goal_normalize_trees([tree], [], strict=True)

        tree = app._study_goal_new_tree("depth", 0)
        count = app.STUDY_GOAL_TREE_DEPTH_MAX + 2
        tree["nodes"] = [
            {"id": f"n{i}", "kind": "branch", "title": str(i)}
            for i in range(count)
        ]
        tree["links"] = [
            {
                "id": f"l{i}",
                "from": None if i == 0 else f"n{i - 1}",
                "to": f"n{i}",
                "type": "contains",
                "primary": True,
                "order": 0,
                "side": "right",
            }
            for i in range(count)
        ]
        with self.assertRaises(ValueError):
            app._study_goal_normalize_trees([tree], [], strict=True)


if __name__ == "__main__":
    unittest.main()
