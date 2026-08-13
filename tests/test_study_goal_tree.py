import json
import tempfile
import unittest
from pathlib import Path

import app


class DummyHandler:
    def _send_json(self, status, payload):
        self.response = (status, payload)
        return payload


class StudyGoalTreeTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_study_file = app.STUDY_FILE
        self.original_archive_dir = app.STUDY_ARCHIVE_DIR
        root = Path(self.temp_dir.name)
        app.STUDY_FILE = root / "study.json"
        app.STUDY_ARCHIVE_DIR = root / "archives"

    def tearDown(self):
        app.STUDY_FILE = self.original_study_file
        app.STUDY_ARCHIVE_DIR = self.original_archive_dir
        self.temp_dir.cleanup()

    def task(self, title, **patch):
        return app._study_task({"title": title, **patch})

    def data(self, *tasks):
        return {
            "version": 5,
            "tasks": list(tasks),
            "trash": [],
            "goalTree": app._study_goal_empty(),
        }

    def test_empty_payload_uses_v5_fresh_tree(self):
        loaded = app.load_study()
        self.assertEqual(loaded["version"], 5)
        self.assertEqual(loaded["tasks"], [])
        self.assertEqual(loaded["trash"], [])
        self.assertEqual(len(loaded["goalTrees"]), 1)
        tree = loaded["goalTrees"][0]
        self.assertEqual(tree["title"], "目标 1")
        self.assertEqual(tree["nodes"], [])
        self.assertEqual(tree["focusTaskIds"], [])
        self.assertEqual(loaded["activeTreeId"], tree["id"])
        self.assertIs(loaded["goalTree"], tree)

    def test_v4_keeps_tasks_and_restores_first_legacy_tree(self):
        task = self.task("保留任务", progress={
            "target": 10,
            "milestones": [{"id": "half", "name": "一半", "at": 5}],
        })
        app.STUDY_FILE.write_text(json.dumps({
            "version": 4,
            "tasks": [task],
            "trash": [],
            "goalTrees": [{"id": "legacy", "title": "旧树", "nodes": [
                {"id": "left", "kind": "branch", "parentId": None,
                 "title": "左侧", "order": 0, "side": "left"},
                {"id": "task", "kind": "task", "parentId": "left",
                 "taskId": task["id"], "order": 0},
                {"id": "next", "kind": "task", "parentId": "task",
                 "taskId": "missing", "order": 0,
                 "taskSlot": {"kind": "milestone", "milestoneId": "half"}},
            ]}],
        }, ensure_ascii=False), encoding="utf-8")
        loaded = app.load_study()
        self.assertEqual(loaded["version"], 5)
        self.assertEqual([item["title"] for item in loaded["tasks"]], ["保留任务"])
        self.assertEqual(loaded["goalTree"]["title"], "旧树")
        self.assertEqual(loaded["goalTree"]["nodes"][0]["side"], "left")
        self.assertEqual(loaded["goalTree"]["nodes"][1]["parentId"], "left")
        self.assertEqual(len(loaded["goalTrees"]), 1)
        self.assertEqual(loaded["activeTreeId"], "legacy")
        self.assertIs(loaded["goalTree"], loaded["goalTrees"][0])

    def test_commands_create_one_route_with_branch_and_shared_task(self):
        existing = self.task("已有任务", progress={"target": 3})
        data = self.data(existing)
        app.apply_study_goal_tree_command(data, {"command": "rename-root", "title": "计算机网络"})
        branch_id = app.apply_study_goal_tree_command(data, {
            "command": "create-branch", "title": "传输层",
        })["nodeId"]
        attached = app.apply_study_goal_tree_command(data, {
            "command": "attach-task", "parentId": branch_id, "taskId": existing["id"],
        })
        created = app.apply_study_goal_tree_command(data, {
            "command": "create-task", "parentId": branch_id, "title": "完成练习", "target": 10,
        })
        tree = data["goalTree"]
        self.assertEqual(tree["title"], "计算机网络")
        self.assertEqual(len(tree["nodes"]), 3)
        self.assertIs(app._study_goal_task_owner(data, existing["id"])[0], tree)
        self.assertEqual(app._study_goal_node(tree, attached["nodeId"])["parentId"], branch_id)
        self.assertEqual(next(task for task in data["tasks"] if task["id"] == created["taskId"])["progress"]["target"], 10)
        with self.assertRaisesRegex(ValueError, "已经在这棵目标树中"):
            app.apply_study_goal_tree_command(data, {
                "command": "attach-task", "taskId": existing["id"],
            })

    def test_branches_and_tasks_keep_their_original_parent_rules(self):
        task = self.task("前置", progress={
            "target": 10,
            "milestones": [{"id": "half", "name": "一半", "at": 5}],
        })
        following = self.task("后续")
        data = self.data(task, following)
        first = app.apply_study_goal_tree_command(data, {"command": "create-branch", "title": "一"})["nodeId"]
        second = app.apply_study_goal_tree_command(data, {
            "command": "create-branch", "parentId": first, "title": "二",
        })["nodeId"]
        leaf = app.apply_study_goal_tree_command(data, {
            "command": "attach-task", "parentId": second, "taskId": task["id"],
        })["nodeId"]
        chained = app.apply_study_goal_tree_command(data, {
            "command": "attach-task", "parentId": leaf, "taskId": following["id"],
            "taskSlot": {"kind": "milestone", "milestoneId": "half"},
        })["nodeId"]
        chained_node = app._study_goal_node(data["goalTree"], chained)
        self.assertEqual(chained_node["parentId"], leaf)
        self.assertEqual(chained_node["taskSlot"], {"kind": "milestone", "milestoneId": "half"})
        with self.assertRaisesRegex(ValueError, "父级类型不支持"):
            app.apply_study_goal_tree_command(data, {
                "command": "create-branch", "parentId": leaf, "title": "非法",
            })
        with self.assertRaisesRegex(ValueError, "自己的子分支"):
            app.apply_study_goal_tree_command(data, {
                "command": "move-node", "nodeId": first, "parentId": second,
            })

    def test_root_side_and_task_slot_survive_move_and_normalization(self):
        first = self.task("第一", progress={
            "target": 4,
            "milestones": [{"id": "m2", "name": "二", "at": 2}],
        })
        second = self.task("第二")
        data = self.data(first, second)
        first_node = app.apply_study_goal_tree_command(data, {
            "command": "attach-task", "taskId": first["id"], "side": "left",
        })["nodeId"]
        second_node = app.apply_study_goal_tree_command(data, {
            "command": "attach-task", "taskId": second["id"], "side": "right",
        })["nodeId"]
        self.assertEqual(app._study_goal_node(data["goalTree"], first_node)["side"], "left")
        app.apply_study_goal_tree_command(data, {
            "command": "move-node", "nodeId": second_node, "parentId": first_node,
            "taskSlot": {"kind": "milestone", "milestoneId": "m2"},
        })
        moved = app._study_goal_node(data["goalTree"], second_node)
        self.assertEqual(moved["parentId"], first_node)
        self.assertEqual(moved["taskSlot"], {"kind": "milestone", "milestoneId": "m2"})

    def test_detaching_task_promotes_its_following_tasks(self):
        first = self.task("第一", progress={
            "target": 4,
            "milestones": [{"id": "m2", "name": "二", "at": 2}],
        })
        at_start, at_milestone, at_end = self.task("开始"), self.task("节点"), self.task("末尾")
        data = self.data(first, at_start, at_milestone, at_end)
        first_node = app.apply_study_goal_tree_command(data, {
            "command": "attach-task", "taskId": first["id"], "side": "left",
        })["nodeId"]
        child_nodes = []
        for task, slot in (
            (at_start, {"kind": "start"}),
            (at_milestone, {"kind": "milestone", "milestoneId": "m2"}),
            (at_end, {"kind": "end"}),
        ):
            child_nodes.append(app.apply_study_goal_tree_command(data, {
                "command": "attach-task", "taskId": task["id"], "parentId": first_node,
                "taskSlot": slot,
            })["nodeId"])
        app.apply_study_goal_tree_command(data, {"command": "detach-task", "taskId": first["id"]})
        promoted = sorted(
            (app._study_goal_node(data["goalTree"], node_id) for node_id in child_nodes),
            key=lambda node: node["order"],
        )
        self.assertTrue(all(node["parentId"] is None for node in promoted))
        self.assertTrue(all(node["side"] == "left" for node in promoted))
        self.assertEqual([node["taskId"] for node in promoted], [
            at_start["id"], at_milestone["id"], at_end["id"],
        ])

    def test_move_reorders_siblings(self):
        data = self.data()
        ids = [app.apply_study_goal_tree_command(data, {
            "command": "create-branch", "title": title,
        })["nodeId"] for title in ("A", "B", "C")]
        app.apply_study_goal_tree_command(data, {
            "command": "move-node", "nodeId": ids[2], "beforeId": ids[0],
        })
        ordered = sorted(data["goalTree"]["nodes"], key=lambda node: node["order"])
        self.assertEqual([node["title"] for node in ordered], ["C", "A", "B"])

    def test_delete_branch_removes_subtree_but_keeps_tasks(self):
        first, second = self.task("第一项"), self.task("第二项")
        data = self.data(first, second)
        parent = app.apply_study_goal_tree_command(data, {"command": "create-branch", "title": "父"})["nodeId"]
        child = app.apply_study_goal_tree_command(data, {
            "command": "create-branch", "parentId": parent, "title": "子",
        })["nodeId"]
        app.apply_study_goal_tree_command(data, {"command": "attach-task", "parentId": parent, "taskId": first["id"]})
        app.apply_study_goal_tree_command(data, {"command": "attach-task", "parentId": child, "taskId": second["id"]})
        result = app.apply_study_goal_tree_command(data, {"command": "delete-branch", "nodeId": parent})
        self.assertEqual(data["goalTree"]["nodes"], [])
        self.assertEqual({task["id"] for task in data["tasks"]}, {first["id"], second["id"]})
        self.assertEqual(len(result["removedNodeIds"]), 4)

    def test_metrics_average_progress_and_done_state(self):
        partial = self.task("推进中", progress={"target": 4})
        partial["progress"]["current"] = 2
        done = self.task("已完成", status="done")
        data = self.data(partial, done)
        for task in data["tasks"]:
            app.apply_study_goal_tree_command(data, {"command": "attach-task", "taskId": task["id"]})
        metrics = app._study_goal_tree_metrics(data["goalTree"], data["tasks"])
        self.assertEqual(metrics["leafCount"], 2)
        self.assertAlmostEqual(metrics["progress"], .75)
        self.assertFalse(metrics["complete"])

    def test_save_normalizes_to_v5(self):
        task = self.task("保存")
        data = self.data(task)
        app.apply_study_goal_tree_command(data, {"command": "attach-task", "taskId": task["id"]})
        app.save_study(data)
        raw = json.loads(app.STUDY_FILE.read_text(encoding="utf-8"))
        self.assertEqual(raw["version"], 5)
        self.assertIn("goalTrees", raw)
        self.assertIn("activeTreeId", raw)
        self.assertNotIn("goalTree", raw)
        self.assertEqual(app.load_study()["goalTree"]["nodes"][0]["taskId"], task["id"])

    def test_trash_and_archive_detach_tasks_without_snapshots(self):
        task = self.task("路线任务", status="done")
        data = self.data(task)
        app.apply_study_goal_tree_command(data, {"command": "attach-task", "taskId": task["id"]})
        app.save_study(data)
        handler = DummyHandler()
        app.Handler._api_study_task_trash(handler, {"id": task["id"]})
        self.assertEqual(handler.response[0], 200)
        loaded = app.load_study()
        self.assertEqual(loaded["goalTree"]["nodes"], [])
        self.assertNotIn("goalTreePlacement", loaded["trash"][0])

        restored_id = loaded["trash"][0]["task"]["id"]
        app.Handler._api_study_task_restore(handler, {"id": restored_id})
        self.assertEqual(app.load_study()["goalTree"]["nodes"], [])

    def test_handler_returns_active_tree_payload(self):
        app.save_study(self.data())
        handler = DummyHandler()
        app.Handler._api_study_goal_tree_command(handler, {
            "command": "create-branch", "title": "分支",
        })
        self.assertEqual(handler.response[0], 200)
        self.assertIn("goalTree", handler.response[1])
        self.assertIn("goalTrees", handler.response[1])
        self.assertEqual(
            handler.response[1]["activeTreeId"], handler.response[1]["goalTree"]["id"]
        )
        self.assertEqual(
            handler.response[1]["goalTrees"],
            app.load_study()["goalTrees"],
        )

    def test_create_switch_and_delete_trees_keep_active_invariant(self):
        app.save_study(self.data())
        data = app.load_study()
        first = data["activeTreeId"]
        second = app.apply_study_goal_tree_command(data, {"command": "create-tree"})["treeId"]
        self.assertEqual(data["activeTreeId"], second)
        self.assertEqual(data["goalTree"]["title"], "目标 2")
        app.apply_study_goal_tree_command(data, {"command": "switch-tree", "treeId": first})
        self.assertEqual(data["activeTreeId"], first)
        result = app.apply_study_goal_tree_command(data, {"command": "delete-tree", "treeId": first})
        self.assertEqual(result["removedTreeId"], first)
        self.assertEqual(data["activeTreeId"], second)
        self.assertEqual([tree["order"] for tree in data["goalTrees"]], [0])
        result = app.apply_study_goal_tree_command(data, {"command": "delete-tree", "treeId": second})
        self.assertEqual(result["createdTreeId"], data["activeTreeId"])
        self.assertEqual(len(data["goalTrees"]), 1)
        self.assertEqual(data["goalTree"]["title"], "目标 1")
        self.assertEqual(data["goalTree"]["nodes"], [])

    def test_create_tree_title_skips_deleted_numbers(self):
        # 删除中间编号的树后新建：编号必须从现有最大值接续，不能重名
        app.save_study(self.data())
        data = app.load_study()
        app.apply_study_goal_tree_command(data, {"command": "create-tree"})  # 目标 2
        second = data["activeTreeId"]
        app.apply_study_goal_tree_command(data, {"command": "create-tree"})  # 目标 3
        app.apply_study_goal_tree_command(data, {"command": "switch-tree", "treeId": second})
        app.apply_study_goal_tree_command(data, {"command": "delete-tree", "treeId": second})
        created = app.apply_study_goal_tree_command(data, {"command": "create-tree"})["treeId"]
        self.assertEqual(
            sorted(tree["title"] for tree in data["goalTrees"]),
            ["目标 1", "目标 3", "目标 4"],
        )
        self.assertEqual(data["activeTreeId"], created)

    def test_task_can_attach_to_multiple_trees_and_detach_is_scoped(self):
        task = self.task("共享任务")
        app.save_study(self.data(task))
        data = app.load_study()
        first = data["activeTreeId"]
        branch_a = app.apply_study_goal_tree_command(data, {
            "command": "create-branch", "title": "甲",
        })["nodeId"]
        app.apply_study_goal_tree_command(data, {
            "command": "attach-task", "parentId": branch_a, "taskId": task["id"],
        })
        second = app.apply_study_goal_tree_command(data, {"command": "create-tree"})["treeId"]
        branch_b = app.apply_study_goal_tree_command(data, {
            "command": "create-branch", "title": "乙",
        })["nodeId"]
        app.apply_study_goal_tree_command(data, {
            "command": "attach-task", "parentId": branch_b, "taskId": task["id"],
        })
        trees = {tree["id"]: tree for tree in data["goalTrees"]}
        self.assertEqual(
            len([node for node in trees[first]["nodes"] if node.get("taskId") == task["id"]]), 1
        )
        self.assertEqual(
            len([node for node in trees[second]["nodes"] if node.get("taskId") == task["id"]]), 1
        )
        # 同一棵树内不允许重复挂同一个任务
        with self.assertRaisesRegex(ValueError, "已经在这棵目标树中"):
            app.apply_study_goal_tree_command(data, {
                "command": "attach-task", "taskId": task["id"],
            })
        # 从当前树摘除不影响另一棵
        app.apply_study_goal_tree_command(data, {"command": "detach-task", "taskId": task["id"]})
        self.assertEqual(
            len([node for node in trees[second]["nodes"] if node.get("taskId") == task["id"]]), 0
        )
        self.assertEqual(
            len([node for node in trees[first]["nodes"] if node.get("taskId") == task["id"]]), 1
        )


if __name__ == "__main__":
    unittest.main()
