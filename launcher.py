"""Native Windows resource chooser; never starts the HTTP server or WebView2."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from feature_profile import CATALOG, FEATURES, HANDOFF_ARGUMENT, PROFILE_FILENAME, RESOURCE_ROOT, LaunchProfile, ProfileError, read_preferences, save_preferences, read_launcher_settings, saved_canvas
from desktop_instance import desktop_instance_running


def launcher_root() -> Path:
    override = os.environ.get("RELATUM_DATA_ROOT", "").strip()
    return Path(override).expanduser().resolve() if override else (Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent)


def launch_command(profile: LaunchProfile, file: str = "") -> list[str]:
    profile.validate()
    if not profile.has_home and not file:
        raise ProfileError("仅启用画布编辑器时，请先选择一个 .canvas 文件")
    if file and (not profile.enabled("canvas.editor") or not Path(file).is_file() or Path(file).suffix.lower() != ".canvas"):
        raise ProfileError("请选择有效的 .canvas 文件，并启用画布编辑器")
    if getattr(sys, "frozen", False):
        executable = Path(sys.executable).resolve().with_name("Relatum.exe")
        if not executable.is_file():
            raise ProfileError("同目录中未找到 Relatum.exe，请保留完整发布文件夹")
        command = [str(executable)]
    else:
        command = [sys.executable, str(Path(__file__).resolve().with_name("desktop.py"))]
    command.extend([HANDOFF_ARGUMENT, profile.encode()])
    if file:
        command.append(str(Path(file).resolve()))
    return command


def create_form(root: Path):
    # Imported only by the launcher. pythonnet and WinForms already ship with
    # the desktop application; this adds no frontend framework or runtime.
    import clr
    clr.AddReference("System.Windows.Forms")
    clr.AddReference("System.Drawing")
    from System.Drawing import Color, Font, FontStyle, Icon, Point, Size
    from System.Windows.Forms import Button, CheckBox, DialogResult, DockStyle, FlowDirection, FlowLayoutPanel, Form, FormStartPosition, Label, MessageBox, MessageBoxButtons, MessageBoxIcon, OpenFileDialog, Padding, Panel, AutoScaleMode, Screen

    saved, warning = read_preferences(root)
    form = Form()
    form.Text = "Relatum Launcher"
    available_height = Screen.PrimaryScreen.WorkingArea.Height
    form.ClientSize = Size(680, min(780, max(480, available_height - 80)))
    form.MinimumSize = Size(696, min(650, available_height))
    form.StartPosition = FormStartPosition.CenterScreen
    form.AutoScaleMode = AutoScaleMode.Dpi
    form.BackColor = Color.FromArgb(251, 251, 250)
    form.Font = Font("Microsoft YaHei UI", 9)
    icon = RESOURCE_ROOT / "assets" / "app-icon.ico"
    if icon.is_file():
        form.Icon = Icon(str(icon))
    header = Panel()
    header.Dock = DockStyle.Top
    header.Height = 68
    heading = Label()
    heading.Text = "选择本次需要的功能"
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
    detail.Text = warning or "点击或聚焦选项查看说明。\n\n关闭父项会暂时禁用子项，子项原有勾选会保留。\n\nAI、图谱依赖画布编辑器；动态背景依赖日历。"
    body.Controls.Add(detail)
    body.Controls.Add(choices_panel)
    buttons = {}
    changing = [False]
    selected_file = [""]

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
            file_label.Text = "未指定画布 · 默认进入已启用工作区"

    for item in CATALOG["features"]:
        key = item["id"]
        depth, parent = 0, item.get("parent")
        while parent:
            depth += 1
            parent = FEATURES[parent].get("parent")
        button = CheckBox()
        button.Text = item["label"]
        button.Checked = saved.choices[key]
        button.Width = 265 - depth * 20
        button.Height = 28
        button.Margin = Padding(depth * 20, 2, 0, 2)
        if depth == 0:
            button.Font = Font(form.Font, FontStyle.Bold)
        description = item["label"] + "\n\n" + item["description"]
        def show_detail(_sender, _event, text=description):
            detail.Text = text
        button.Enter += show_detail
        button.MouseEnter += show_detail
        button.CheckedChanged += sync
        buttons[key] = button
        choices_panel.Controls.Add(button)

    pick = Button()
    pick.Text = "选择 .canvas…"
    pick.Location = Point(24, 10)
    pick.Size = Size(140, 32)
    file_label = Label()
    file_label.Text = "未指定画布 · 默认进入已启用工作区"
    file_label.AutoEllipsis = True
    file_label.Location = Point(175, 17)
    file_label.Size = Size(450, 26)
    def choose_file(*_):
        dialog = OpenFileDialog()
        dialog.Filter = "Relatum Canvas (*.canvas)|*.canvas"
        dialog.CheckFileExists = True
        dialog.Title = "选择要打开的画布"
        try:
            if dialog.ShowDialog(form) == DialogResult.OK:
                selected_file[0] = str(dialog.FileName)
                file_label.Text = selected_file[0]
        finally:
            dialog.Dispose()
    pick.Click += choose_file
    reset = Button()
    reset.Text = "全部启用"
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
    cancel.Text = "取消"
    cancel.Location = Point(424, 73)
    cancel.Size = Size(100, 36)
    cancel.Click += lambda *_: form.Close()
    start = Button()
    start.Text = "启动 Relatum"
    start.Location = Point(534, 73)
    start.Size = Size(122, 36)
    start.BackColor = Color.FromArgb(35, 40, 36)
    start.ForeColor = Color.White
    def start_application(*_):
        try:
            profile = current()
            profile.validate()
            if desktop_instance_running(root):
                MessageBox.Show(form, "Relatum 已在运行。请先退出已有窗口，再按启动。\n当前选择会保留在启动器中。", "Relatum Launcher", MessageBoxButtons.OK, MessageBoxIcon.Information)
                return
            if not profile.has_home and not selected_file[0]:
                choose_file()
                if not selected_file[0]:
                    return
            command = launch_command(profile, selected_file[0])
            save_preferences(root, profile, selected_file[0])
            subprocess.Popen(command, cwd=str(root), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            form.Close()
        except (OSError, ProfileError) as err:
            MessageBox.Show(form, str(err), "Relatum Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning)
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


def quick_launch(root: Path) -> bool:
    """Return false to open the chooser when saved choices cannot be launched."""
    if not read_launcher_settings(root)["skipSelection"]:
        return False
    profile, warning = read_preferences(root)
    if warning or not (Path(root) / "data" / PROFILE_FILENAME).is_file():
        return False
    file = saved_canvas(root) if not profile.has_home else ""
    try:
        command = launch_command(profile, file)
    except (OSError, ProfileError):
        return False
    if desktop_instance_running(root):
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, "Relatum 已在运行。请先退出已有窗口，再启动。", "Relatum Launcher", 0x40)
        return True
    subprocess.Popen(command, cwd=str(root), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return True


def main() -> int:
    if sys.platform != "win32":
        raise RuntimeError("Relatum Launcher 仅支持 Windows 桌面版")
    root = launcher_root()
    try:
        if quick_launch(root):
            return 0
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
            Application.Run(create_form(root))
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
