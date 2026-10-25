"""Native resource chooser, with an in-process desktop entry for saved sessions."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from feature_profile import CATALOG, FEATURES, HANDOFF_ARGUMENT, PROFILE_FILENAME, RESOURCE_ROOT, LaunchProfile, ProfileError, read_preferences, save_preferences, read_launcher_settings, saved_canvas
from desktop_instance import workspace_conflicts, conflict_message
from desktop_preferences import read_launcher_language


FEATURE_TEXT_EN = {
    "daily": ("Daily workspace", "Daily tasks, calendar, focus and ledger."),
    "daily.tasks": ("Daily tasks", "Daily check-ins, groups and goals."),
    "daily.ledger": ("Ledger", "Independent income and expense ledger."),
    "canvas": ("Canvas workspace", "Canvas library, editor, review, activity, quick notes, trees and study."),
    "canvas.library": ("Canvas library", "Recent canvases, groups, favorites, imports and trash. Can be selected separately from the editor."),
    "canvas.editor": (".canvas editor", "Open and edit canvases. Select an existing file when enabling only the editor."),
    "editor.ai": ("AI assistant", "AI chat and reviewed canvas plans. Disabling this also disables AI loading and preloading."),
    "editor.graph": ("Canvas graph", "The editor's graph overlay. Disabling this also disables graph loading and preloading."),
    "canvas.review": ("Review", "A separate card library and review sessions."),
    "daily.calendar": ("Calendar", "Calendar, journals and countdowns."),
    "daily.calendar.wallpaper": ("Live desktop background", "Allow countdowns to launch a separate desktop background process. No background host is created when disabled."),
    "canvas.activity": ("Activity", "Activity heatmap and constellation."),
    "canvas.quicknotes": ("Quick Notes", "A wall of quick sticky notes."),
    "canvas.tree": ("Tree", "The independent Tree page."),
    "canvas.study": ("Study", "Study tasks, goal trees and routes."),
    "daily.focus": ("Focus", "Focus timer, session records and sounds."),
    "notes": ("Notes workspace", "Markdown file tree, editing and reading in multiple tabs."),
    "notes.graph": ("Note graph", "Notebook relationship graph. Disabling this skips graph scripts, data and the rendering engine."),
    "notes.ai": ("Note AI", "Independent chat, prompt presets and local conversation history. Disabling this skips AI resources, configuration and service access."),
    "notes.mermaid": ("Mermaid diagrams", "Mermaid diagrams in notes, using the offline Pele engine. When disabled, code remains visible without loading dedicated scripts, styles or the engine."),
    "notes.canvas": ("Embedded note canvases", "Canvas blocks inside notes. When disabled, references remain visible without loading the engine or canvas files."),
    "research": ("Research workspace", "Research canvases, subcircuits and simulation."),
    "career": ("Career workspace", "Local saved usage reports. Reports are not preloaded when disabled."),
    "runtime.preload": ("Background preloading", "Prepare unopened pages, the note editor and display fonts in advance. Disable to load them on first use and reduce startup memory. All selected features remain available."),
}

TEXT_EN = {
    "选择本次需要的功能": "Choose features for this session",
    "点击或聚焦选项查看说明。\n\n可重复启动，分别打开不同工作区。同一工作区只能在一个窗口中运行。\n\n关闭父项会暂时禁用子项，子项原有勾选会保留。": "Click or focus an option to view its description.\n\nLaunch again to open different workspaces. Each workspace can run in only one window.\n\nDisabling a parent temporarily disables its children while keeping their selections.",
    "未指定画布 · 默认进入已启用工作区": "No canvas selected · Open enabled workspaces",
    "选择 .canvas…": "Choose .canvas…",
    "选择要打开的画布": "Choose a canvas to open",
    "全部启用": "Enable all",
    "取消": "Cancel",
    "启动 Relatum": "Start Relatum",
    "仅启用画布编辑器时，请先选择一个 .canvas 文件": "Select a .canvas file when enabling only the canvas editor.",
    "请选择有效的 .canvas 文件，并启用画布编辑器": "Select a valid .canvas file and enable the canvas editor.",
    "同目录中未找到 Relatum.exe，请保留完整发布文件夹": "Relatum.exe was not found beside the launcher. Keep the complete release folder together.",
    "请至少选择一个工作区、页面或画布编辑器": "Select at least one workspace, page or canvas editor.",
    "上次启动器配置无法读取，已显示默认选择。确认启动后会保存新选择。": "Could not read the last launcher configuration. Default choices are shown; starting will save your new choices.",
}


def launcher_text(source: str, language: str) -> str:
    if language != "en":
        return source
    prefix = "以下工作区已在运行："
    suffix = "。\n请取消这些工作区的勾选，或先退出占用它们的窗口。当前选择已保留。"
    if source.startswith(prefix) and source.endswith(suffix):
        labels = {item["label"]: FEATURE_TEXT_EN[key][0] for key, item in FEATURES.items()}
        names = ", ".join(labels.get(name, name) for name in source[len(prefix):-len(suffix)].split("、"))
        return f"These workspaces are already running: {names}.\nDeselect them or close their windows first. Your choices have been kept."
    return TEXT_EN.get(source, source)


def launcher_root() -> Path:
    override = os.environ.get("RELATUM_DATA_ROOT", "").strip()
    return Path(override).expanduser().resolve() if override else (Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent)


def feature_rows():
    """Keep each subtree contiguous even when the catalog interleaves features."""
    def children(parent, depth):
        items = [item for item in CATALOG["features"] if item.get("parent") == parent]
        preferred = FEATURES.get(parent, {}).get("availableWhenAny", [])
        if preferred:
            items.sort(key=lambda item: preferred.index(item["id"]) if item["id"] in preferred else len(preferred))
        for item in items:
            yield item, depth
            yield from children(item["id"], depth + 1)
    yield from children(None, 0)


def session_arguments(profile: LaunchProfile, file: str = "") -> list[str]:
    profile.validate()
    if not profile.has_home and not file:
        raise ProfileError("仅启用画布编辑器时，请先选择一个 .canvas 文件")
    if file and (not profile.enabled("canvas.editor") or not Path(file).is_file() or Path(file).suffix.lower() != ".canvas"):
        raise ProfileError("请选择有效的 .canvas 文件，并启用画布编辑器")
    arguments = [HANDOFF_ARGUMENT, profile.encode()]
    if file:
        arguments.append(str(Path(file).resolve()))
    return arguments


def launch_command(profile: LaunchProfile, file: str = "") -> list[str]:
    arguments = session_arguments(profile, file)
    if getattr(sys, "frozen", False):
        executable = Path(sys.executable).resolve().with_name("Relatum.exe")
        if not executable.is_file():
            raise ProfileError("同目录中未找到 Relatum.exe，请保留完整发布文件夹")
        command = [str(executable)]
    else:
        command = [sys.executable, str(Path(__file__).resolve().with_name("desktop.py"))]
    command.append("--remember-launch-choice")
    command.extend(arguments)
    return command


def create_form(root: Path, *, initial_profile=None, initial_file="", notice=""):
    # Imported only by the launcher. pythonnet and WinForms already ship with
    # the desktop application; this adds no frontend framework or runtime.
    import clr
    clr.AddReference("System.Windows.Forms")
    clr.AddReference("System.Drawing")
    from System.Drawing import Color, Font, FontStyle, Icon, Point, Size
    from System.Windows.Forms import Button, CheckBox, DialogResult, DockStyle, FlowDirection, FlowLayoutPanel, Form, FormStartPosition, Label, MessageBox, MessageBoxButtons, MessageBoxIcon, OpenFileDialog, Padding, Panel, AutoScaleMode, Screen

    saved, warning = read_preferences(root)
    language = read_launcher_language(root)
    text = lambda source: launcher_text(source, language)
    if initial_profile is not None:
        saved = initial_profile
    form = Form()
    form.Text = "Relatum Launcher"
    available_height = Screen.PrimaryScreen.WorkingArea.Height
    form.ClientSize = Size(680, min(780, max(480, available_height - 80)))
    form.MinimumSize = Size(696, min(650, available_height))
    form.StartPosition = FormStartPosition.CenterScreen
    form.AutoScaleMode = AutoScaleMode.Dpi
    form.BackColor = Color.FromArgb(251, 251, 250)
    form.Font = Font("Microsoft YaHei UI", 9)
    icon = RESOURCE_ROOT / "assets" / "launcher-icon.ico"
    if not icon.is_file():
        icon = RESOURCE_ROOT / "assets" / "app-icon.ico"
    if icon.is_file():
        form.Icon = Icon(str(icon))
    header = Panel()
    header.Dock = DockStyle.Top
    header.Height = 68
    heading = Label()
    heading.Text = text("选择本次需要的功能")
    heading.Font = Font(form.Font.FontFamily, 17, FontStyle.Bold)
    heading.AutoSize = True
    heading.Location = Point(24, 20)
    header.Controls.Add(heading)
    footer = Panel()
    footer.Dock = DockStyle.Bottom
    footer.Height = 140
    body = Panel()
    body.Dock = DockStyle.Fill
    body.Padding = Padding(24, 0, 24, 0)
    choices_panel = FlowLayoutPanel()
    choices_panel.Dock = DockStyle.Left
    choices_panel.Width = 300
    choices_panel.FlowDirection = FlowDirection.TopDown
    choices_panel.WrapContents = False
    choices_panel.AutoScroll = True
    detail = Label()
    detail.Dock = DockStyle.Fill
    detail.Padding = Padding(18, 18, 8, 8)
    detail.Text = text(notice or warning or "点击或聚焦选项查看说明。\n\n可重复启动，分别打开不同工作区。同一工作区只能在一个窗口中运行。\n\n关闭父项会暂时禁用子项，子项原有勾选会保留。")
    body.Controls.Add(detail)
    body.Controls.Add(choices_panel)
    buttons = {}
    changing = [False]
    selected_file = [initial_file]

    def current():
        return LaunchProfile({key: bool(button.Checked) for key, button in buttons.items()}, restricted=True)

    def sync(*_):
        if changing[0]:
            return
        profile = current()
        for key, button in buttons.items():
            parent = FEATURES[key].get("parent")
            button.Enabled = (not parent or profile.enabled(parent)) and all(profile.enabled(dependency) for dependency in FEATURES[key].get("requires", []))
        pick.Enabled = profile.enabled("canvas.editor")
        if not pick.Enabled:
            selected_file[0] = ""
            file_label.Text = text("未指定画布 · 默认进入已启用工作区")

    for item, depth in feature_rows():
        key = item["id"]
        button = CheckBox()
        label, explanation = FEATURE_TEXT_EN[key] if language == "en" else (item["label"], item["description"])
        button.Text = label
        button.Checked = saved.choices[key]
        button.Width = 265 - depth * 20
        button.Height = 28
        button.Margin = Padding(depth * 20, 2, 0, 2)
        if depth == 0:
            button.Font = Font(form.Font, FontStyle.Bold)
        description = label + "\n\n" + explanation
        def show_detail(_sender, _event, text=description):
            detail.Text = text
        button.Enter += show_detail
        button.MouseEnter += show_detail
        button.CheckedChanged += sync
        buttons[key] = button
        choices_panel.Controls.Add(button)

    pick = Button()
    pick.Text = text("选择 .canvas…")
    pick.Location = Point(24, 10)
    pick.Size = Size(140, 32)
    file_label = Label()
    file_label.Text = initial_file or text("未指定画布 · 默认进入已启用工作区")
    file_label.AutoEllipsis = True
    file_label.Location = Point(175, 17)
    file_label.Size = Size(450, 26)
    def choose_file(*_):
        dialog = OpenFileDialog()
        dialog.Filter = "Relatum Canvas (*.canvas)|*.canvas"
        dialog.CheckFileExists = True
        dialog.Title = text("选择要打开的画布")
        try:
            if dialog.ShowDialog(form) == DialogResult.OK:
                selected_file[0] = str(dialog.FileName)
                file_label.Text = selected_file[0]
        finally:
            dialog.Dispose()
    pick.Click += choose_file
    reset = Button()
    reset.Text = text("全部启用")
    reset.Location = Point(24, 73)
    reset.Size = Size(100, 36)
    def select_all(*_):
        changing[0] = True
        for button in buttons.values():
            button.Checked = True
        changing[0] = False
        sync()
    reset.Click += select_all
    cancel = Button()
    cancel.Text = text("取消")
    cancel.Location = Point(424, 73)
    cancel.Size = Size(100, 36)
    cancel.Click += lambda *_: form.Close()
    start = Button()
    start.Text = text("启动 Relatum")
    start.Location = Point(534, 73)
    start.Size = Size(122, 36)
    start.BackColor = Color.FromArgb(35, 40, 36)
    start.ForeColor = Color.White
    def start_application(*_):
        try:
            profile = current()
            profile.validate()
            conflicts = workspace_conflicts(root, profile.workspaces)
            if conflicts:
                MessageBox.Show(form, text(conflict_message(conflicts)), "Relatum Launcher", MessageBoxButtons.OK, MessageBoxIcon.Information)
                return
            if not profile.has_home and not selected_file[0]:
                choose_file()
                if not selected_file[0]:
                    return
            command = launch_command(profile, selected_file[0])
            subprocess.Popen(command, cwd=str(root), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            form.Close()
        except (OSError, ProfileError) as err:
            MessageBox.Show(form, text(str(err)), "Relatum Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning)
    start.Click += start_application
    for control in (pick, file_label, reset, cancel, start):
        footer.Controls.Add(control)
    form.Controls.Add(body)
    form.Controls.Add(footer)
    form.Controls.Add(header)
    form.AcceptButton = start
    form.CancelButton = cancel
    sync()
    # Keep delegates and managed controls alive for the lifetime of the form.
    form._relatum_controls = (buttons, pick, detail, start, selected_file)
    return form


def quick_launch(root: Path) -> list[str] | None:
    """Resolve a saved session without importing WinForms or spawning a process.

    The desktop entry still strictly decodes these arguments and acquires the
    shared instance mutex. None means the chooser must repair the saved choices.
    """
    if not read_launcher_settings(root)["skipSelection"]:
        return None
    profile, warning = read_preferences(root)
    if warning or not (Path(root) / "data" / PROFILE_FILENAME).is_file():
        return None
    file = saved_canvas(root) if not profile.has_home else ""
    try:
        return session_arguments(profile, file)
    except (OSError, ProfileError):
        return None


def main(*, choose_only: bool = False, initial_profile=None, initial_file="", notice="") -> int:
    if sys.platform != "win32":
        raise RuntimeError("Relatum Launcher 仅支持 Windows 桌面版")
    root = launcher_root()
    try:
        arguments = None if choose_only else quick_launch(root)
        if arguments is not None:
            sys.argv = [sys.argv[0], *arguments]
            from desktop import main as desktop_main
            return desktop_main()
    except OSError as err:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, str(err), "Relatum Launcher", 0x10)
        return 1
    import clr
    clr.AddReference("System.Windows.Forms")
    from System.Threading import ApartmentState, Thread, ThreadStart
    from System.Windows.Forms import Application
    errors = []
    def run():
        try:
            Application.EnableVisualStyles()
            Application.Run(create_form(root, initial_profile=initial_profile, initial_file=initial_file, notice=notice))
        except Exception as err:
            errors.append(err)
    thread = Thread(ThreadStart(run))
    thread.SetApartmentState(ApartmentState.STA)
    thread.Start()
    thread.Join()
    if errors:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, str(errors[0]), "Relatum Launcher", 0x10)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
