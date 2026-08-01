'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'assets', 'countdown.html'), 'utf8');
const countdown = fs.readFileSync(path.join(root, 'assets', 'countdown.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'assets', 'desktop-shell.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'assets', 'styles.css'), 'utf8');
const desktop = fs.readFileSync(path.join(root, 'desktop.py'), 'utf8');
const wallpaper = fs.readFileSync(path.join(root, 'windows_wallpaper.py'), 'utf8');
const build = fs.readFileSync(path.join(root, 'build-desktop.ps1'), 'utf8');

assert(html.includes('data-countdown-wallpaper hidden'));
assert(html.includes("dataset.countdownWallpaper = '1'"));
assert(html.includes('<kbd>F</kbd><span data-copy="focusHint">放大/取消放大</span>'));
assert(countdown.includes("const wallpaperMode = pageParams.get('wallpaper') === '1'"));
assert(countdown.includes("const wallpaperLanguage = wallpaperMode && pageParams.get('lang') === 'en'"));
assert(countdown.includes("setWallpaper: '设为桌面背景'"));
assert(countdown.includes("replaceWallpaper: '替换桌面背景'"));
assert(countdown.includes("stopWallpaper: '取消桌面背景'"));
assert(countdown.includes('wallpaper.eventId === selected.id'));
assert(countdown.includes("window.CanvasDesktop.startCountdownWallpaper(selected.id, language())"));
assert(countdown.includes("window.CanvasDesktop.stopCountdownWallpaper()"));
assert(countdown.includes("fetch('/api/countdown', { cache: 'no-store' })"));
assert(countdown.includes('scheduleWallpaperSync(3000)'));
assert(countdown.includes('document.hidden && !wallpaperMode'));
assert(countdown.includes("callWallpaperApi('countdown_wallpaper_event_missing'"));
assert(shell.includes("callApi('get_countdown_wallpaper_state')"));
assert(shell.includes("callApi('start_countdown_wallpaper', eventId, language)"));
assert(shell.includes("callApi('stop_countdown_wallpaper')"));
assert(styles.includes('html[data-countdown-wallpaper="1"] .countdown-workspace'));
assert(styles.includes('html[data-countdown-wallpaper="1"] .countdown-clock'));
assert(styles.includes('grid-template-columns: repeat(4, minmax(0, 1fr))'));
assert(desktop.includes('WallpaperController('));
assert(desktop.includes('run_wallpaper_child'));
assert(desktop.includes('--countdown-wallpaper-child'));
assert(desktop.includes('window.hide()'));
assert(wallpaper.includes('family="AF_PIPE"'));
assert(wallpaper.includes('FindWindowExW(None, owner, "WorkerW", None)'));
assert(!wallpaper.includes('Return SHELLDLL_DefView'));
assert(build.includes("'pystray==0.19.5'"));
assert(build.includes('--hidden-import pystray._win32'));

console.log('countdown wallpaper contract passed');
