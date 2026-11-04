'use strict';
// Real source WinForms/WebView2, including Windows mouse input. No release or user data.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.RELATUM_PLAYWRIGHT || 'playwright');
const repo = path.resolve(__dirname, '..'), root = fs.mkdtempSync(path.join(os.tmpdir(), 'relatum-window-native-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const catalog = JSON.parse(fs.readFileSync(path.join(repo, 'assets/feature-catalog.json')));
const profile = { version: 1, features: Object.fromEntries(catalog.features.map(item => [item.id, item.id === 'notes'])) };
const stateFile = path.join(root, 'data/desktop-sessions/notes/window-state.json');
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ version: 2, x: 100, y: 100, width: 990, height: 660, maximized: false }));
const host = `import sys, ctypes, time, desktop
u = ctypes.windll.user32
u.SendMessageW.argtypes = [desktop.wintypes.HWND,desktop.wintypes.UINT,desktop.wintypes.WPARAM,desktop.wintypes.LPARAM]
u.SendMessageW.restype = ctypes.c_ssize_t
saves = 0
save = desktop._save_window_state
def counted(*args, **kwargs):
    global saves
    saves += 1
    return save(*args, **kwargs)
desktop._save_window_state = counted
def geometry(self):
    h = desktop._hwnd(self._window)
    r = desktop.wintypes.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    tracking = desktop._MINMAXINFO()
    u.SendMessageW(h, desktop.WM_GETMINMAXINFO, 0, ctypes.addressof(tracking))
    return dict(rect=[r.left,r.top,r.right,r.bottom], scale=desktop._window_scale(self._window),
        size=self.get_restored_size(), maximized=bool(u.IsZoomed(h)), minimized=bool(u.IsIconic(h)),
        writes=saves, pending=self._geometry_timer is not None,
        tracking=[tracking.ptMinTrackSize.x,tracking.ptMinTrackSize.y,tracking.ptMaxTrackSize.x,tracking.ptMaxTrackSize.y])
def drag(self, direction, dx, dy):
    h = desktop._hwnd(self._window)
    r = desktop.wintypes.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    x = r.left+4 if 'left' in direction else r.right-5 if 'right' in direction else (r.left+r.right)//2
    y = r.top+4 if 'top' in direction else r.bottom-5 if 'bottom' in direction else (r.top+r.bottom)//2
    old = desktop.wintypes.POINT()
    u.GetCursorPos(ctypes.byref(old))
    u.SetForegroundWindow(h)
    u.SetCursorPos(x,y)
    time.sleep(.08)
    cursor = desktop.wintypes.POINT()
    u.GetCursorPos(ctypes.byref(cursor))
    u.WindowFromPoint.argtypes = [desktop.wintypes.POINT]
    u.WindowFromPoint.restype = desktop.wintypes.HWND
    target = u.WindowFromPoint(cursor)
    class_name = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(target, class_name, 256)
    hit = u.SendMessageW(h, desktop.WM_NCHITTEST, 0, ((y & 65535)<<16)|(x & 65535))
    try:
        u.mouse_event(2,0,0,0,0)
        time.sleep(.08)
        for step in range(1,9):
            u.SetCursorPos(x+round(dx*step/8),y+round(dy*step/8))
            time.sleep(.025)
    finally:
        u.mouse_event(4,0,0,0,0)
        time.sleep(.1)
        u.SetCursorPos(old.x,old.y)
    return dict(hit=hit, geometry=geometry(self), targetClass=class_name.value, cursor=[cursor.x,cursor.y], intended=[x,y], foreground=int(u.GetForegroundWindow()), hwnd=h)
def move(self):
    u.SetWindowPos(desktop._hwnd(self._window),None,100,100,0,0,desktop.SWP_NOSIZE|desktop.SWP_NOZORDER)
def restore(self):
    desktop._show_window(self._window, desktop.SW_RESTORE)
def system_restore(self):
    u.PostMessageW(desktop._hwnd(self._window), desktop.WM_SYSCOMMAND, desktop.SC_RESTORE, 0)
def screenshot(self, target):
    from PIL import ImageGrab
    h = desktop._hwnd(self._window)
    u.SetForegroundWindow(h)
    r = desktop.wintypes.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    time.sleep(.4)
    ctypes.windll.dwmapi.DwmFlush()
    ImageGrab.grab(bbox=(r.left,r.top,r.right,r.bottom),all_screens=True).save(target)
desktop.DesktopBridge.window_test_geometry = geometry
desktop.DesktopBridge.window_test_drag = drag
desktop.DesktopBridge.window_test_move = move
desktop.DesktopBridge.window_test_restore = restore
desktop.DesktopBridge.window_test_system_restore = system_restore
desktop.DesktopBridge.window_test_screenshot = screenshot
sys.argv = ['desktop.py','--launch-profile',sys.argv[1]]
sys.exit(desktop.main())`;
let child, browser, page, port;
async function wait(check, label) {
  for (let attempt=0; attempt<200; attempt++) { if (await check()) return; await pause(100); }
  throw new Error('Timed out: '+label);
}
async function open() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port; await new Promise(resolve => server.close(resolve));
  let logs = '';
  child = spawn(process.env.RELATUM_PYTHON || 'python', ['-B','-c',host,JSON.stringify(profile)], {
    cwd: repo, windowsHide: true, stdio: ['ignore','pipe','pipe'],
    env: { ...process.env, RELATUM_DATA_ROOT: root, LOCALAPPDATA: root, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port='+port },
  });
  child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
  await wait(async () => { assert.equal(child.exitCode, null, logs); try { return (await fetch('http://127.0.0.1:'+port+'/json/version')).ok; } catch { return false; } }, 'WebView2');
  browser = await chromium.connectOverCDP('http://127.0.0.1:'+port);
  await wait(() => { page = browser.contexts()[0].pages()[0]; return !!page; }, 'page');
  await page.waitForFunction(() => window.RelatumGlobalSettings && typeof window.pywebview?.api?.window_test_geometry === 'function');
  return page.evaluate(() => pywebview.api.window_test_geometry());
}
const geometry = () => page.evaluate(() => pywebview.api.window_test_geometry());
async function close() {
  await page.evaluate(async () => { await CanvasDesktop.flushBeforeClose(); await pywebview.api.close_window(); });
  await wait(() => child.exitCode !== null, 'close'); assert.equal(child.exitCode,0);
  await browser.close(); browser = null; await pause(300);
}
(async () => {
  try {
    const first = await open(); assert.equal(first.size.width,990); assert.equal(first.size.height,660);
    await page.evaluate(() => RelatumGlobalSettings.open({ category:'system' }));
    await page.waitForFunction(() => !document.querySelector('[data-role="global-window-size-form"] input').disabled);
    const directions = [['left',10,-24,0],['right',11,24,0],['top',12,0,-24],['bottom',15,0,24],
      ['top-left',13,-24,-24],['top-right',14,24,-24],['bottom-left',16,-24,24],['bottom-right',17,24,24]];
    for (const [direction,hit,dx,dy] of directions) {
      await page.evaluate(async () => { await CanvasDesktop.setRestoredSize(900,600); await pywebview.api.window_test_move(); });
      const before = await geometry();
      const result = await page.evaluate(([direction,dx,dy]) => pywebview.api.window_test_drag(direction,dx,dy),[direction,dx,dy]);
      assert.equal(result.hit,hit,direction+' native hit');
      const after = result.geometry;
      const dw = (after.rect[2]-after.rect[0])-(before.rect[2]-before.rect[0]);
      const dh = (after.rect[3]-after.rect[1])-(before.rect[3]-before.rect[1]);
      assert(Math.abs(dw-Math.abs(dx))<=2 && Math.abs(dh-Math.abs(dy))<=2, JSON.stringify({direction,before,result,dw,dh}));
      await wait(async () => !(await geometry()).pending,'gesture commit');
      assert.equal(JSON.parse(fs.readFileSync(stateFile)).width, after.size.width, direction+' saves real size');
      await page.waitForFunction(width => Number(document.querySelector('[data-role="global-window-size-form"] [name="width"]').value) === width,after.size.width);
      console.log(direction+': native mouse resize and settings synchronization passed');
    }
    const settled = await geometry(); await pause(700); const idle = await geometry();
    assert.equal(idle.writes,settled.writes,'idle has no geometry writes'); assert.equal(idle.pending,false);
    const limits = idle.size.limits;
    assert.deepEqual(idle.tracking,[Math.round(720*idle.scale),Math.round(480*idle.scale),Math.round(limits.maxWidth*idle.scale),Math.round(limits.maxHeight*idle.scale)],'native tracking and settings share the same limits');
    const minimum = await page.evaluate(() => CanvasDesktop.setRestoredSize(1,1)); assert.deepEqual([minimum.width,minimum.height],[720,480]);
    const maximum = await page.evaluate(() => CanvasDesktop.setRestoredSize(99999,99999)); assert.deepEqual([maximum.width,maximum.height],[limits.maxWidth,limits.maxHeight]);
    await page.evaluate(() => CanvasDesktop.setRestoredSize(960,640));
    await page.evaluate(() => pywebview.api.toggle_maximize()); await wait(async () => (await geometry()).maximized,'maximize');
    await close(); assert.deepEqual([JSON.parse(fs.readFileSync(stateFile)).width,JSON.parse(fs.readFileSync(stateFile)).height],[960,640]);
    const second = await open(); assert.equal(second.maximized,true); assert.deepEqual([second.size.width,second.size.height],[960,640]);
    await page.evaluate(() => pywebview.api.window_test_system_restore()); await wait(async () => !(await geometry()).maximized,'system restore');
    assert.deepEqual([(await geometry()).size.width,(await geometry()).size.height],[960,640],JSON.stringify(await geometry()));
    await page.evaluate(() => pywebview.api.minimize()); await wait(async () => (await geometry()).minimized,'minimize');
    await page.evaluate(() => pywebview.api.window_test_restore()); await wait(async () => !(await geometry()).minimized,'restore minimized');
    assert.deepEqual([(await geometry()).size.width,(await geometry()).size.height],[960,640]);
    await page.evaluate(() => RelatumGlobalSettings.close({instant:true}));
    await page.locator('[data-window-action="maximize"]:visible').first().click(); await wait(async () => (await geometry()).maximized,'titlebar maximize');
    await page.locator('[data-window-action="maximize"]:visible').first().click(); await wait(async () => !(await geometry()).maximized,'titlebar restore');
    assert.deepEqual([(await geometry()).size.width,(await geometry()).size.height],[960,640]);
    await page.evaluate(() => RelatumGlobalSettings.open({ category:'system' }));
    await page.screenshot({path:path.join(root,'native-settings.png')});
    await page.evaluate(target => pywebview.api.window_test_screenshot(target),path.join(root,'native-frame.png'));
    await close(); const third = await open(); assert.deepEqual([third.size.width,third.size.height],[960,640]); assert.equal(third.maximized,false); await close();
    console.log('Native WebView2: v2 restore, eight real edge/corner drags, idle, bounds, maximize/reopen, minimize/restore and normal reopen passed. Artifacts: '+root);
  } catch (error) { if (page) await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{}); throw error; }
  finally {
    if (browser) await browser.close().catch(()=>{});
    if (child?.exitCode === null) execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  }
})().catch(error => {console.error(error); process.exitCode=1;});
