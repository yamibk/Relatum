"""Locked desktop environment and offline build operations (standard library only)."""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

PROJECT = Path(__file__).resolve().parent.parent
LOCK_PATH = PROJECT / 'packaging' / 'desktop-build-lock.json'


def load_lock():
    raw = LOCK_PATH.read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def atomic_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8', newline='')
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def is_reparse(path):
    return bool(path.lstat().st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT) if os.name == 'nt' else path.is_symlink()


def safe_path(path, parent):
    """Check lexical containment and every existing ancestor before file operations."""
    path, parent = Path(os.path.abspath(path)), Path(os.path.abspath(parent))
    if path == parent or not path.is_relative_to(parent):
        raise RuntimeError('Path is outside its expected parent: ' + str(path))
    for candidate in [path, *path.parents]:
        if candidate.exists() and is_reparse(candidate):
            raise RuntimeError('Refusing a linked/reparse path: ' + str(candidate))
    return path


def remove_inside(path, parent):
    path = safe_path(path, parent)
    if path.exists():
        for directory, folders, files in os.walk(path, followlinks=False):
            for name in folders + files:
                child = Path(directory) / name
                if is_reparse(child):
                    raise RuntimeError('Refusing to remove a reparse entry: ' + str(child))
        shutil.rmtree(path)


def run(arguments, *, timeout=600, cwd=PROJECT, env=None):
    """Keep native stderr visible without PowerShell 5.1's native-error handling."""
    arguments = list(arguments)
    if Path(arguments[0]).name.lower() in {'python.exe', 'python', 'python3'}:
        arguments[1:1] = ['-X', 'utf8']
    print('> ' + subprocess.list2cmdline([str(arg) for arg in arguments]), flush=True)
    started = time.monotonic()
    process = subprocess.Popen([str(arg) for arg in arguments], cwd=cwd, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    expired = threading.Event()

    def expire():
        expired.set()
        if os.name == 'nt':
            subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            process.kill()

    timer = threading.Timer(timeout, expire)
    timer.start()
    try:
        for line in iter(process.stdout.readline, b''):
            print(line.decode('utf-8', errors='replace').rstrip(), flush=True)
        code = process.wait()
    finally:
        timer.cancel()
        process.stdout.close()
    print('Step elapsed: %.1fs' % (time.monotonic() - started), flush=True)
    if expired.is_set():
        raise RuntimeError('Step timed out after %ss; its child processes were stopped.' % timeout)
    if code:
        raise RuntimeError('Command failed (exit %s).' % code)


def offline_env(home=None):
    environment = os.environ.copy()
    for key in ['PYTHONPATH', 'PYTHONHOME', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS', 'PIP_TARGET', 'PIP_PREFIX', 'PIP_USER']:
        environment.pop(key, None)
    environment.update(PIP_CONFIG_FILE=os.devnull, PIP_NO_INDEX='1', PIP_DISABLE_PIP_VERSION_CHECK='1',
                       PYTHONNOUSERSITE='1', PYTHONUTF8='1', PYTHONUNBUFFERED='1')
    if home is not None:
        environment['PIP_CACHE_DIR'] = str(home / 'cache' / 'pip')
    return environment


def pointer_path(home):
    return home / ('active-' + load_lock()[1] + '.json')


def active_environment(home):
    path = pointer_path(home)
    if not path.is_file():
        raise RuntimeError('No prepared environment for this lock. Run prepare-desktop.ps1 first.')
    active = json.loads(path.read_text(encoding='utf-8-sig'))
    if active.get('fingerprint') != load_lock()[1]:
        raise RuntimeError('Environment lock mismatch. Run prepare-desktop.ps1.')
    relative = Path(active['environment'])
    if relative.parts[0] != 'envs' or len(relative.parts) != 2:
        raise RuntimeError('Invalid environment path in preparation record.')
    return safe_path(home / relative, home / 'envs')


def probe(home):
    lock, _ = load_lock()
    version = '.'.join(map(str, sys.version_info[:3]))
    if version != lock['runtime']['version'] or struct.calcsize('P') != 8:
        raise RuntimeError('Expected fixed x64 Python %s; found %s.' % (lock['runtime']['version'], version))
    expected = active_environment(home)
    if Path(sys.prefix).resolve() != expected.resolve():
        raise RuntimeError('Interpreter does not belong to the prepared environment.')
    verify_packages(lock)


def verify_packages(lock):
    problems = []
    for package in lock['packages']:
        try:
            actual = importlib.metadata.version(package['name'])
        except importlib.metadata.PackageNotFoundError:
            actual = 'MISSING'
        if actual != package['version']:
            problems.append('%s: expected %s, found %s' % (package['name'], package['version'], actual))
    if problems:
        raise RuntimeError('Build dependency mismatch. Run prepare-desktop.ps1:\n' + '\n'.join(problems))
    for module in ['webview', 'PyInstaller.archive.readers', 'PIL.Image', 'pystray', 'pythonnet', 'clr_loader', 'proxy_tools']:
        if importlib.util.find_spec(module) is None:
            raise RuntimeError('Build module missing: ' + module)
        importlib.import_module(module)


def verify(home):
    probe(home)
    print('Fixed build Python: ' + sys.executable, flush=True)
    run([sys.executable, '-I', '-B', '-m', 'pip', 'check'], timeout=60, env=offline_env(home))
    run([sys.executable, '-I', '-B', PROJECT / 'scripts' / 'check-note-sqlite.py'], timeout=30, env=offline_env(home))


def download(package, target, *, offline=False, timeout=60, attempts=2):
    if target.is_file() and digest(target) == package['sha256']:
        print('Using verified cache: ' + target.name, flush=True)
        return
    if offline:
        raise RuntimeError('Offline cache missing or corrupt: ' + target.name)
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.part')
    try:
        for attempt in range(attempts):
            try:
                print('Downloading %s (attempt %s/%s)...' % (target.name, attempt + 1, attempts), flush=True)
                started = time.monotonic()
                request = urllib.request.Request(package['url'], headers={'User-Agent': 'Relatum-build-setup'})
                with urllib.request.urlopen(request, timeout=timeout) as response, temporary.open('wb') as output:
                    while chunk := response.read(256 * 1024):
                        output.write(chunk)
                        if time.monotonic() - started > 180:
                            raise TimeoutError('Download exceeded 180s')
                if digest(temporary) != package['sha256']:
                    raise RuntimeError('SHA-256 mismatch: ' + target.name)
                os.replace(temporary, target)
                return
            except Exception as error:
                if attempt + 1 == attempts:
                    raise
                print('Download failed: ' + str(error), flush=True)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(home, offline):
    lock, fingerprint = load_lock()
    try:
        current = active_environment(home) / 'Scripts' / 'python.exe'
        run([current, '-I', '-B', '-u', __file__, 'check', '--home', home], timeout=120, env=offline_env(home))
        print('Environment already matches the lock. No installation needed.', flush=True)
        return
    except Exception as error:
        print('Preparing a new environment; existing records remain untouched: ' + str(error), flush=True)
    packages = home / 'cache' / 'packages'
    packages.mkdir(parents=True, exist_ok=True)
    for package in lock['packages']:
        download(package, packages / package['filename'], offline=offline)
    candidate = home / 'envs' / (fingerprint[:16] + '-' + uuid.uuid4().hex)
    candidate.parent.mkdir(parents=True, exist_ok=True)
    safe_path(candidate, home / 'envs')
    # Venvs embed absolute paths: create at the final unique path, never rename.
    run([sys.executable, '-I', '-B', '-m', 'venv', candidate], timeout=120, env=offline_env(home))
    python = candidate / 'Scripts' / 'python.exe'
    bootstrap = {'pip': 0, 'setuptools': 1, 'wheel': 2}
    ordered = sorted(lock['packages'], key=lambda item: (not item['filename'].endswith('.whl'), bootstrap.get(item['name'], 3)))
    for package in ordered:
        run([python, '-I', '-B', '-m', 'pip', 'install', '--no-index', '--no-deps', '--no-build-isolation',
             '--disable-pip-version-check', packages / package['filename']], timeout=180, env=offline_env(home))
    run([python, '-I', '-B', '-u', __file__, 'candidate-check'], timeout=60, env=offline_env(home))
    run([python, '-I', '-B', '-m', 'pip', 'check'], timeout=60, env=offline_env(home))
    run([python, '-I', '-B', PROJECT / 'scripts' / 'check-note-sqlite.py'], timeout=30, env=offline_env(home))
    atomic_json(pointer_path(home), {'fingerprint': fingerprint, 'environment': candidate.relative_to(home).as_posix()})
    print('Environment ready. Daily builds are offline. Cache: ' + str(packages), flush=True)


def data_findings(root):
    findings = []
    if not root.exists():
        return findings
    if not root.is_dir() or is_reparse(root):
        raise RuntimeError('Release is not a regular directory: ' + str(root))
    for directory, folders, files in os.walk(root, followlinks=False):
        for name in folders + files:
            child = Path(directory) / name
            lower = name.casefold()
            if is_reparse(child):
                raise RuntimeError('Linked/reparse release entry: ' + str(child))
            if lower in {'data', 'canvases', 'notes', 'ai.json'} or lower.endswith(('.canvas', '.assets', '.pem', '.key')) or lower == '.env' or lower.startswith('.env.'):
                findings.append(child)
    return findings


def validate_release(root):
    findings = data_findings(root)
    if findings:
        raise RuntimeError('User data or sensitive files in release: ' + ', '.join(map(str, findings[:10])))
    required = ['Relatum.exe', 'RelatumLauncher.exe', 'Relatum.exe.config', 'RelatumLauncher.exe.config',
                '_internal/assets/app-icon.ico', '_internal/assets/launcher-icon.ico', '_internal/assets/feature-catalog.json']
    for relative in required:
        if not (root / relative).is_file():
            raise RuntimeError('Release file missing: ' + relative)
    if (root / '_internal/assets/fonts/kose-font.ttf').exists():
        raise RuntimeError('Build-only TTF leaked into release.')


def validate_output(release):
    if release == PROJECT or release in PROJECT.parents or release.is_relative_to(PROJECT):
        raise RuntimeError('Output must be outside the source repository: ' + str(release))
    safe_path(release, release.parent)


def publish(staged, release, force=False):
    validate_release(staged)
    findings = data_findings(release)
    if findings and not force:
        raise RuntimeError('Release contains user data; back it up or move it first: ' + str(release))
    suffix = uuid.uuid4().hex
    incoming = safe_path(release.with_name(release.name + '.incoming-' + suffix), release.parent)
    backup = safe_path(release.with_name(release.name + '.previous-' + suffix), release.parent)
    old_moved = False
    try:
        shutil.copytree(staged, incoming)
        validate_release(incoming)
        # Recheck immediately before switching; user data can appear while building.
        findings = data_findings(release)
        if findings and not force:
            raise RuntimeError('User data appeared in the previous release during the build.')
        if release.exists():
            os.replace(release, backup)
            old_moved = True
        try:
            os.replace(incoming, release)
        except BaseException as install_error:
            if old_moved:
                try:
                    os.replace(backup, release)
                except OSError as rollback_error:
                    raise RuntimeError('Release switch failed; rollback was blocked. Previous release is preserved at %s. %s' % (backup, rollback_error)) from install_error
            raise
        if old_moved:
            if findings:
                print('Previous user data preserved at: ' + str(backup), flush=True)
            else:
                try:
                    remove_inside(backup, release.parent)
                except (OSError, RuntimeError) as error:
                    print('Previous release retained at %s: %s' % (backup, error), flush=True)
    finally:
        if incoming.exists():
            remove_inside(incoming, release.parent)


def build(home, output, keep=False, force=False):
    verify(home)
    release = Path(os.path.abspath(output or PROJECT.parent / 'Relatum-release'))
    validate_output(release)
    findings = data_findings(release)
    if findings and not force:
        raise RuntimeError('Release contains user data; back it up or move it first: ' + str(release))
    release.parent.mkdir(parents=True, exist_ok=True)
    work = home / 'work' / uuid.uuid4().hex
    work.mkdir(parents=True)
    environment = offline_env(home)
    environment['PYINSTALLER_CONFIG_DIR'] = str(home / 'cache' / 'pyinstaller')
    print('[1/5] Checking public source...', flush=True)
    shell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    git = shutil.which('git')
    if not git:
        for variable in ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']:
            base = os.environ.get(variable)
            if base:
                for relative in ['Git/cmd/git.exe', 'Programs/Git/cmd/git.exe']:
                    candidate = Path(base) / relative
                    if candidate.is_file():
                        git = str(candidate)
                        break
            if git:
                break
    if not git or not (PROJECT / '.git').exists():
        raise RuntimeError('Source check requires Git and a Git checkout. Git was not found; install Git for Windows.')
    check_environment = environment.copy()
    check_environment['PATH'] = str(Path(git).parent) + os.pathsep + check_environment.get('PATH', '')
    run([shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PROJECT / 'scripts/check-public.ps1'], timeout=120, env=check_environment)
    print('[2/5] Staging offline assets: ' + str(work), flush=True)
    assets = work / 'assets'
    shutil.copytree(PROJECT / 'assets', assets)
    icon = next((path for path in [PROJECT / 'Relatum.ico', PROJECT / 'assets/app-icon.ico'] if path.is_file()), None)
    if icon is None:
        icon = work / 'app-icon.ico'
        run([sys.executable, '-I', '-B', PROJECT / 'packaging/make_icon.py', icon], env=environment)
    shutil.copy2(icon, assets / 'app-icon.ico')
    (assets / 'fonts/kose-font.ttf').unlink(missing_ok=True)
    launcher = PROJECT / 'packaging/make_launcher.py'
    run([sys.executable, '-I', '-B', launcher, 'icon', icon, assets / 'launcher-icon.ico'], env=environment)
    print('[3/5] Running PyInstaller (offline)...', flush=True)
    run([sys.executable, '-I', '-B', '-m', 'PyInstaller', '--noconfirm', '--clean', '--windowed', '--onedir',
         '--name', 'Relatum', '--icon', icon, '--add-data', str(assets) + ';assets',
         '--hidden-import', 'webview.platforms.winforms', '--hidden-import', 'webview.platforms.edgechromium',
         '--hidden-import', 'pystray._win32', '--specpath', work, '--workpath', work / 'work',
         '--distpath', work / 'dist', PROJECT / 'desktop.py'], timeout=1800, env=environment)
    built = work / 'dist/Relatum'
    print('[4/5] Creating and checking launcher...', flush=True)
    run([sys.executable, '-I', '-B', launcher, 'exe', built / 'Relatum.exe', built / 'RelatumLauncher.exe', assets / 'launcher-icon.ico'], env=environment)
    for name in ['Relatum.exe.config', 'RelatumLauncher.exe.config']:
        shutil.copy2(PROJECT / 'packaging/Relatum.exe.config', built / name)
    validate_release(built)
    print('[5/5] Publishing verified release...', flush=True)
    publish(built, release, force)
    if not keep:
        remove_inside(work, home / 'work')
    print('Build complete: ' + str(release), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'check', 'candidate-check', 'runtime-check', 'build'])
    parser.add_argument('--home', type=Path)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--output')
    parser.add_argument('--keep-build-artifacts', action='store_true')
    parser.add_argument('--force-replace-user-data', action='store_true')
    args = parser.parse_args()
    try:
        if args.mode in {'candidate-check', 'runtime-check'}:
            lock, _ = load_lock()
            if '.'.join(map(str, sys.version_info[:3])) != lock['runtime']['version'] or struct.calcsize('P') != 8:
                raise RuntimeError('Candidate Python version/architecture does not match the lock.')
            if args.mode == 'candidate-check':
                verify_packages(lock)
            else:
                import ensurepip
                import ssl
                import sqlite3
                import venv
                print('Fixed runtime checked: ' + sys.version.split()[0], flush=True)
        elif args.home is None:
            parser.error('--home is required')
        elif args.mode == 'prepare':
            prepare(args.home.resolve(), args.offline)
        elif args.mode == 'check':
            verify(args.home.resolve())
        else:
            build(args.home.resolve(), args.output, args.keep_build_artifacts, args.force_replace_user_data)
    except Exception as error:
        print('ERROR: ' + str(error), flush=True)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
