import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app


class TreePageTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_file = app.TREE_PAGE_FILE
        app.TREE_PAGE_FILE = Path(self.temp_dir.name) / "tree-page.json"
        self.data = app.load_tree_page()

    def tearDown(self):
        app.TREE_PAGE_FILE = self.original_file
        self.temp_dir.cleanup()

    def command(self, command, **body):
        if command not in {"create-tree", "switch-tree", "delete-tree"}:
            body.setdefault("treeId", self.data["activeTreeId"])
        return app.apply_tree_page_command(self.data, {"command": command, **body})

    def branch(self, title="阶段", parent=None, side="right"):
        primary = {"from": parent, "type": "contains"}
        if parent is None:
            primary["side"] = side
        return self.command("create-branch", title=title, primaryLink=primary)["nodeId"]

    def task(self, title="任务", parent=None, side="right", target=None):
        primary = {"from": parent, "type": "contains"}
        if parent is None:
            primary["side"] = side
        body = {"title": title, "primaryLink": primary}
        if target is not None:
            body["target"] = target
        return self.command("create-task", **body)

    def active_tree(self):
        return app._study_goal_tree(self.data, self.data["activeTreeId"])

    def test_fresh_v2_is_lazy_and_roundtrips(self):
        self.assertEqual(self.data["version"], 2)
        self.assertEqual(self.data["tasks"], [])
        self.assertEqual(len(self.data["goalTrees"]), 1)
        self.assertEqual(self.data["activeTreeId"], "goal_default")
        self.assertEqual(app.load_tree_page()["activeTreeId"], self.data["activeTreeId"])
        self.assertFalse(app.TREE_PAGE_FILE.exists())
        self.task("第一项")
        saved = app.save_tree_page(self.data)
        self.assertTrue(app.TREE_PAGE_FILE.exists())
        self.assertEqual(app.load_tree_page(), saved)

    def test_root_title_can_be_blank_and_roundtrips(self):
        self.command("rename-root", title="   ")
        self.assertEqual(self.active_tree()["title"], "")
        self.branch("空标题下继续编辑")
        self.assertEqual(self.active_tree()["title"], "")
        saved = app.save_tree_page(self.data)
        self.assertEqual(saved["goalTrees"][0]["title"], "")
        self.assertEqual(app.load_tree_page()["goalTrees"][0]["title"], "")

    def test_root_title_stays_blank_through_normalized_api_path(self):
        app.apply_tree_page_command(self.data, {
            "command": "rename-root",
            "treeId": self.data["activeTreeId"],
            "title": "",
        }, normalized=True)
        saved = app.save_tree_page(self.data, normalized=True)
        self.assertEqual(self.active_tree()["title"], "")
        self.assertEqual(saved["goalTrees"][0]["title"], "")
        self.assertEqual(app.load_tree_page()["goalTrees"][0]["title"], "")

    def test_v1_is_discarded_without_writing_until_first_change(self):
        old = {"version": 1, "activeTreeId": "tree_old", "trees": [{"id": "tree_old"}]}
        original = json.dumps(old, ensure_ascii=False)
        app.TREE_PAGE_FILE.write_text(original, encoding="utf-8")
        fresh = app.load_tree_page()
        self.assertEqual(fresh["version"], 2)
        self.assertEqual(fresh["tasks"], [])
        self.assertEqual(app.load_tree_page()["activeTreeId"], fresh["activeTreeId"])
        self.assertEqual(app.TREE_PAGE_FILE.read_text(encoding="utf-8"), original)
        app.apply_tree_page_command(fresh, {
            "command": "create-task", "treeId": fresh["activeTreeId"], "title": "新任务",
            "primaryLink": {"from": None, "type": "contains", "side": "right"},
        })
        app.save_tree_page(fresh)
        self.assertEqual(json.loads(app.TREE_PAGE_FILE.read_text(encoding="utf-8"))["version"], 2)

    def test_corrupt_or_unknown_version_is_not_overwritten(self):
        for original in ("{broken", json.dumps({"version": 9, "tasks": [], "goalTrees": []})):
            with self.subTest(original=original):
                app.TREE_PAGE_FILE.write_text(original, encoding="utf-8")
                with self.assertRaises(ValueError):
                    app.load_tree_page()
                self.assertEqual(app.TREE_PAGE_FILE.read_text(encoding="utf-8"), original)

    def test_total_node_and_link_limits_cover_all_trees(self):
        self.branch("第一棵阶段")
        self.command("create-tree", title="第二棵")
        self.branch("第二棵阶段一")
        self.branch("第二棵阶段二")
        with mock.patch.object(app, "TREE_PAGE_TOTAL_NODES_MAX", 2):
            with self.assertRaisesRegex(ValueError, "节点总量"):
                app._tree_page_normalize(copy.deepcopy(self.data))
        with mock.patch.object(app, "TREE_PAGE_TOTAL_LINKS_MAX", 2):
            with self.assertRaisesRegex(ValueError, "连接总量"):
                app._tree_page_normalize(copy.deepcopy(self.data))

    def test_task_is_unique_and_attach_detach_are_rejected(self):
        task_id = self.task("唯一任务")["taskId"]
        second = self.command("create-tree")["treeId"]
        for command in ("attach-task", "detach-task"):
            with self.subTest(command=command):
                with self.assertRaisesRegex(ValueError, "不提供"):
                    self.command(command, treeId=second, taskId=task_id)
        invalid = copy.deepcopy(self.data)
        invalid["goalTrees"][1]["nodes"].append({
            "id": "goal_node_duplicate", "kind": "task", "taskId": task_id,
        })
        invalid["goalTrees"][1]["links"].append({
            "id": "goal_link_duplicate", "from": None, "to": "goal_node_duplicate",
            "type": "contains", "primary": True, "order": 0, "side": "right",
        })
        with self.assertRaisesRegex(ValueError, "只能属于一棵树"):
            app._tree_page_normalize(invalid)

    def test_progress_status_milestones_and_appearance(self):
        task_id = self.task("练习", target=10)["taskId"]
        result = self.command("update-task", taskId=task_id, color="#f0caca", shape="pill",
                              progress={"current": 3, "target": 10, "milestones": [
                                  {"id": "sm_one", "name": "起步", "at": 2},
                              ]})
        self.assertEqual(result["task"]["progress"]["current"], 3)
        self.assertEqual(result["task"]["shape"], "pill")
        self.command("progress-task", taskId=task_id, delta=1)
        task = next(item for item in self.data["tasks"] if item["id"] == task_id)
        self.assertEqual(task["progress"]["current"], 4)
        self.assertEqual(task["color"], "#f0caca")
        self.command("update-task", taskId=task_id, status="done")
        self.assertEqual(self.data["tasks"][0]["status"], "done")

    def test_progress_command_accepts_coalesced_delta(self):
        task_id = self.task("连点", target=10)["taskId"]
        self.command("update-task", taskId=task_id, progress={
            "current": 2,
            "target": 10,
            "milestones": [{"id": "sm_mid", "name": "中点", "at": 5}],
        })
        result = self.command("progress-task", taskId=task_id, delta=5)
        self.assertEqual(result["task"]["progress"]["current"], 7)
        self.assertEqual(result["crossedMilestoneIds"], ["sm_mid"])
        with self.assertRaisesRegex(ValueError, "安全范围"):
            self.command("progress-task", taskId=task_id, delta=10000)

    def test_zero_target_removes_numeric_progress_state(self):
        task_id = self.task("取消量化", target=10)["taskId"]
        self.command("update-task", taskId=task_id, progress={
            "current": 6,
            "target": 10,
            "milestones": [{"id": "sm_clear", "name": "中点", "at": 5}],
        })
        result = self.command("update-task", taskId=task_id, progress={
            "current": 0, "target": 0, "milestones": [],
        })
        self.assertEqual(result["task"]["progress"], {
            "current": 0, "target": 0, "milestones": [],
        })

    def test_lower_target_accepts_the_clamped_current_value(self):
        task_id = self.task("缩短目标", target=10)["taskId"]
        self.command("update-task", taskId=task_id, progress={
            "current": 6, "target": 10, "milestones": [],
        })
        result = self.command("update-task", taskId=task_id, progress={
            "current": 4, "target": 4, "milestones": [],
        })
        self.assertEqual(result["task"]["progress"]["current"], 4)
        self.assertEqual(result["task"]["progress"]["target"], 4)

    def test_client_ids_make_task_and_branch_creation_optimistic(self):
        task_result = self.command(
            "create-task",
            title="立即出现",
            target=3,
            primaryLink={"from": None, "type": "contains", "side": "right"},
            clientTaskId="tree_task_optimistic_task",
            clientNodeId="goal_node_optimistic_task",
            clientLinkId="goal_link_optimistic_task",
        )
        self.assertEqual(task_result["taskId"], "tree_task_optimistic_task")
        self.assertEqual(task_result["nodeId"], "goal_node_optimistic_task")
        self.assertEqual(task_result["linkId"], "goal_link_optimistic_task")
        self.assertEqual(self.data["tasks"][-1]["progress"]["target"], 3)

        branch_result = self.command(
            "create-branch",
            title="立即出现的阶段",
            primaryLink={"from": None, "type": "contains", "side": "left"},
            clientNodeId="goal_node_optimistic_branch",
            clientLinkId="goal_link_optimistic_branch",
        )
        self.assertEqual(branch_result["nodeId"], "goal_node_optimistic_branch")
        self.assertEqual(branch_result["linkId"], "goal_link_optimistic_branch")

        with self.assertRaisesRegex(ValueError, "不能重复"):
            self.command(
                "create-branch",
                title="重复",
                primaryLink={"from": None, "type": "contains", "side": "right"},
                clientNodeId="goal_node_optimistic_branch",
                clientLinkId="goal_link_another_optimistic_branch",
            )

    def test_dependencies_and_move_use_goal_tree_protocol(self):
        first = self.task("先做")["nodeId"]
        second_result = self.task("后做")
        second = second_result["nodeId"]
        link = self.command("add-requirement", fromNodeId=first, toNodeId=second,
                            trigger={"kind": "complete"})
        self.assertTrue(link["linkId"].startswith("goal_link_"))
        with self.assertRaisesRegex(RuntimeError, "解锁条件"):
            self.command("update-task", taskId=second_result["taskId"], status="done")
        self.command("remove-requirement", linkId=link["linkId"])
        self.command("move-node", nodeId=second, primaryLink={
            "from": first, "type": "requires", "trigger": {"kind": "complete"},
        })
        with self.assertRaises(ValueError):
            self.command("move-node", nodeId=first, primaryLink={
                "from": second, "type": "requires", "trigger": {"kind": "complete"},
            })

    def test_removed_reference_commands_are_rejected(self):
        first = self.task("一")["nodeId"]
        with self.assertRaisesRegex(ValueError, "不支持"):
            self.command("create-reference", **{"from": "root", "to": first})
        with self.assertRaisesRegex(ValueError, "不支持"):
            self.command("delete-reference", referenceId="tree_ref_removed")
        self.assertNotIn("references", self.active_tree())

    def test_delete_task_removes_record_and_links(self):
        first = self.task("一")
        child = self.task("二")
        self.command("move-node", nodeId=child["nodeId"], primaryLink={
            "from": first["nodeId"], "type": "requires", "trigger": {"kind": "complete"},
        })
        self.command("delete-task", taskId=first["taskId"])
        self.assertNotIn(first["taskId"], {task["id"] for task in self.data["tasks"]})
        self.assertNotIn(first["nodeId"], {node["id"] for node in self.active_tree()["nodes"]})
        self.assertIn(child["nodeId"], {node["id"] for node in self.active_tree()["nodes"]})

    def test_delete_task_promotes_children_without_reordering_following_siblings(self):
        doomed = self.task("待删")
        following = self.task("原后续")
        first_child = self.task("子项一")
        second_child = self.task("子项二")
        for child in (first_child, second_child):
            self.command("move-node", nodeId=child["nodeId"], primaryLink={
                "from": doomed["nodeId"], "type": "requires", "trigger": {"kind": "complete"},
            })
        self.command("delete-task", taskId=doomed["taskId"])
        tree = self.active_tree()
        task_by_node = {
            node["id"]: next(task for task in self.data["tasks"] if task["id"] == node["taskId"])
            for node in tree["nodes"] if node["kind"] == "task"
        }
        root_tasks = [
            task_by_node[link["to"]]["title"]
            for link in sorted(
                (link for link in tree["links"] if link.get("primary") and link.get("from") is None),
                key=lambda link: link["order"],
            )
        ]
        self.assertEqual(root_tasks, ["子项一", "子项二", "原后续"])

    def test_delete_branch_cascades_tasks_and_dependencies(self):
        branch = self.branch()
        inside = self.task("内部", parent=branch)
        outside = self.task("外部")
        self.command("add-requirement", fromNodeId=inside["nodeId"], toNodeId=outside["nodeId"],
                     trigger={"kind": "complete"})
        self.command("delete-branch", nodeId=branch)
        tree = self.active_tree()
        self.assertNotIn(inside["taskId"], {task["id"] for task in self.data["tasks"]})
        self.assertIn(outside["taskId"], {task["id"] for task in self.data["tasks"]})
        self.assertFalse(any(link.get("from") == inside["nodeId"] for link in tree["links"]))

    def test_delete_tree_cascades_tasks_and_first_tree_is_protected(self):
        first = self.data["activeTreeId"]
        with self.assertRaisesRegex(ValueError, "第一棵"):
            self.command("delete-tree", treeId=first)
        second = self.command("create-tree")["treeId"]
        created = self.task("第二棵")
        self.command("delete-tree", treeId=second)
        self.assertEqual(self.data["activeTreeId"], first)
        self.assertNotIn(created["taskId"], {task["id"] for task in self.data["tasks"]})

    def test_root_branch_task_shapes_and_colors_roundtrip(self):
        branch = self.branch()
        task = self.task(parent=branch)
        self.command("update-root-appearance", shape="diamond", color="#dce7f4")
        self.command("update-branch", nodeId=branch, shape="rectangle", color="#eadcf4")
        self.command("update-task", taskId=task["taskId"], shape="circle", color="#dcebdc")
        saved = app.save_tree_page(self.data)
        loaded = app.load_tree_page()
        tree = app._study_goal_tree(loaded, loaded["activeTreeId"])
        self.assertEqual((tree["shape"], tree["color"]), ("diamond", "#dce7f4"))
        self.assertEqual(next(node for node in tree["nodes"] if node["id"] == branch)["shape"], "rectangle")
        self.assertEqual(next(item for item in loaded["tasks"] if item["id"] == task["taskId"])["shape"], "circle")
        self.assertEqual(saved, loaded)

    def test_study_data_is_never_touched(self):
        self.task("独立")
        app.save_tree_page(self.data)
        self.assertFalse((Path(self.temp_dir.name) / "study.json").exists())


if __name__ == "__main__":
    unittest.main()
