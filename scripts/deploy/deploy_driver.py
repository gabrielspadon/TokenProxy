#!/usr/bin/env python3
"""Prepare and guard a TokenProxy package cutover. No action without a subcommand."""

import argparse
import base64
import contextlib
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

HOME = Path.home()
CHECKOUT = Path(os.environ.get("TOKENPROXY_BUILD_CHECKOUT", HOME / "Codebases/tokenproxy-deploy-build"))
SOURCE = Path(os.environ.get("TOKENPROXY_SOURCE", Path(__file__).resolve().parents[2]))
PACKAGE = Path(os.environ.get("TOKENPROXY_PACKAGE", HOME / ".npm-global/lib/node_modules/tokenproxy"))
DATABASE = Path(os.environ.get("TOKENPROXY_DATABASE", HOME / ".tokenproxy/db/data.sqlite"))
CONTROL = Path(os.environ.get("TOKENPROXY_FRONT_CONTROL", HOME / ".tokenproxy-front/front-control.sock"))
BUILD_NODE = Path(os.environ.get("TOKENPROXY_BUILD_NODE", shutil.which("node") or "/usr/bin/node"))
RUNTIME_NODE = Path(os.environ.get("TOKENPROXY_RUNTIME_NODE", shutil.which("node") or "/usr/bin/node"))
AI_DOTFILES = Path(os.environ.get("TOKENPROXY_AI_DOTFILES", HOME / "Codebases/ai-dotfiles"))
FRONT_SOURCE = AI_DOTFILES / "services/tokenproxy"
FRONT_PACKAGE = Path(os.environ.get("TOKENPROXY_FRONT_PACKAGE", HOME / ".local/lib/tokenproxy-front"))
FRONT_UNIT = Path(os.environ.get("TOKENPROXY_FRONT_UNIT", HOME / ".config/systemd/user/tokenproxy-front.service"))
BACKEND = "tokenproxy.service"
FRONT = "tokenproxy-front.service"
REF = "refs/remotes/origin/main"
PAUSE_BUDGET_SECONDS = 3.8


class GuardError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise GuardError(message)


@contextlib.contextmanager
def pause_budget(seconds):
    """Interrupt any blocking cutover operation before the front lease expires."""
    require(seconds > 0, "Pause budget must be positive")
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    require(previous_timer == (0.0, 0.0), "An existing process timer owns SIGALRM")
    previous_handler = signal.getsignal(signal.SIGALRM)

    def expired(_signum, _frame):
        raise GuardError(
            "Atomic pause budget exceeded; restoring the previous release"
        )

    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield time.monotonic() + seconds
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def run(argv, *, cwd=None, env=None, logfile=None, timeout=120):
    if logfile:
        with Path(logfile).open("ab") as output:
            result = subprocess.run(  # noqa: S603 - fixed argv, no shell
                argv,
                cwd=cwd,
                env=env,
                stdout=output,
                stderr=subprocess.STDOUT,
                timeout=timeout,
                check=False,
            )
        require(result.returncode == 0, f"Command failed; inspect {logfile}")
        return ""
    result = subprocess.run(  # noqa: S603 - fixed argv, no shell
        argv,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    require(
        result.returncode == 0, f"Command failed ({argv[0]}, exit {result.returncode})"
    )
    return result.stdout.strip()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".writing")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def front_source_manifest():
    """Record the exact front module closure and unit that must run at cutover."""
    require(FRONT_SOURCE.is_dir(), f"Front source directory is missing: {FRONT_SOURCE}")
    require(
        run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=AI_DOTFILES) == "",
        "Front source checkout has tracked changes",
    )
    queue = ["front-proxy.mjs"]
    seen = set()
    while queue:
        relative = queue.pop(0)
        if relative in seen:
            continue
        source = FRONT_SOURCE / relative
        require(source.is_file(), f"Front source module is missing: {relative}")
        seen.add(relative)
        for imported in re.findall(r'from\s+["\']\./([^"\']+)["\']', source.read_text()):
            queue.append(imported)
    files = {name: file_sha(FRONT_SOURCE / name) for name in sorted(seen)}
    files["tokenproxy-front.service"] = file_sha(FRONT_SOURCE / "tokenproxy-front.service")
    return {
        "schema": 1,
        "sourceSha": run(["git", "rev-parse", "HEAD"], cwd=AI_DOTFILES),
        "files": files,
    }


def verify_front_provenance(manifest):
    require(manifest.get("schema") == 1, "Unsupported front provenance manifest")
    files = manifest.get("files")
    require(isinstance(files, dict) and files, "Front provenance manifest has no files")
    for relative, expected in files.items():
        installed = FRONT_UNIT if relative == "tokenproxy-front.service" else FRONT_PACKAGE / relative
        require(installed.is_file(), f"Installed front file is missing: {relative}")
        require(file_sha(installed) == expected, f"Installed front file differs: {relative}")


def tree_sha(root):
    """Include content, relative names, modes and symlink targets; reject escapes."""
    root = Path(root).resolve(strict=True)
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        relative = str(path.relative_to(root))
        if path.is_symlink():
            require(
                path.resolve(strict=True).is_relative_to(root),
                f"External package symlink: {relative}",
            )
            content = "link:" + os.readlink(path)
        elif path.is_file():
            content = file_sha(path)
        elif path.is_dir():
            content = "directory"
        else:
            raise GuardError(f"Unexpected package entry: {relative}")
        digest.update(json.dumps([relative, info.st_mode, content]).encode())
    return digest.hexdigest()


def validate_sha(sha):
    require(
        bool(re.fullmatch(r"[0-9a-f]{40}", sha)),
        "An exact 40-character commit SHA is required",
    )
    return sha


def package_sha(path):
    return validate_sha((Path(path) / "BUILD_SHA").read_text().strip())


def clean_environment(node, data):
    return {
        "PATH": f"{node.parent}:/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "NODE_ENV": "production",
        "DATA_DIR": str(data),
        "TOKENPROXY_NO_UPDATE": "1",
        "NEXT_TELEMETRY_DISABLED": "1",
        # The webpack production build exceeded V8's default 4288 MB heap once the
        # audit backlog landed, and then exceeded 8192 MB as well. Compile time
        # across prep areas went 23.5s, 27.8s, 29.0s, 30.1s, 30.5s, 32.9s, 41s,
        # 44s, 61s, 92s, then 6.3min at ecb0a3ae (437 files, +20868 lines), which
        # was the last build to fit. Every build after it died with "Ineffective
        # mark-compacts near heap limit" at 410-470s, inside "Creating an
        # optimized production build". Verified as a ceiling rather than a
        # regression: reverting the tracing-excludes commit changed nothing and
        # the standalone output was never written. At 16384 MB the same tree
        # compiles in 7.8min and packs to a 121 MB package. The cap is the
        # build's, not the host's; this box has 66 GB available.
        # ponytail: a fixed ceiling, raise it again if the bundle grows rather
        # than deriving it from free memory.
        "NODE_OPTIONS": "--max-old-space-size=16384",
        "JWT_SECRET": secrets.token_hex(32),
        "INITIAL_PASSWORD": secrets.token_hex(24),
    }


def auth_headers(path):
    info = Path(path).stat()
    require(
        info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
        "Operator authentication file must be owner-only and owned by this user",
    )
    value = json.loads(Path(path).read_text())
    require(
        isinstance(value, dict)
        and len(value) == 1
        and set(value) <= {"Cookie", "x-tp-cli-token"},
        "Unsupported operator authentication file",
    )
    require(
        all(
            isinstance(v, str) and v and "\n" not in v and "\r" not in v
            for v in value.values()
        ),
        "Invalid operator authentication header",
    )
    return value


def request_http(port, path, headers=None):
    # Fixed loopback origin with no proxy environment or redirect handling.
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request("GET", path, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def request_json(port, path, headers=None):
    status, content = request_http(port, path, headers)
    require(status == 200, f"Unexpected HTTP status {status} on {path}")
    return json.loads(content)


def verify_backend(port, sha, headers, *, features):
    require(
        request_json(port, "/api/ready").get("ready") is True,
        "Backend local readiness contract failed",
    )
    version = request_json(port, "/api/version", headers)
    require(
        version.get("buildSha") in {sha, sha[:12]},
        "Running version does not match the artifact",
    )
    if features:
        context = request_json(port, "/api/context", headers)
        tools = request_json(port, "/api/tools", headers)
        require(
            isinstance(context.get("summary"), dict)
            and isinstance(context.get("sessions"), list),
            "Context endpoint contract failed",
        )
        require(
            isinstance(tools.get("presets"), list)
            and tools.get("scope") == "local-process",
            "Tools endpoint contract failed",
        )
    return version


def wait_backend(port, sha, headers, *, features):
    deadline = time.monotonic() + 20
    while True:
        try:
            return verify_backend(port, sha, headers, features=features)
        except (OSError, ValueError, GuardError):
            if time.monotonic() >= deadline:
                raise GuardError("Backend validation deadline exceeded") from None
            time.sleep(0.2)


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(str(CONTROL))


def control(action="status"):
    connection = UnixHTTP("localhost", timeout=1)
    try:
        connection.request("GET" if action == "status" else "POST", f"/{action}")
        response = connection.getresponse()
        require(response.status == 200, "Front control request failed")
        return json.loads(response.read())
    finally:
        connection.close()


def unit_state(unit):
    raw = run(
        [
            "systemctl",
            "--user",
            "show",
            unit,
            "-p",
            "MainPID",
            "-p",
            "ActiveState",
            "-p",
            "BindReadOnlyPaths",
            "-p",
            "WorkingDirectory",
            "-p",
            "ExecStart",
        ]
    )
    return dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)


def service(action):
    run(["systemctl", "--user", action, BACKEND], timeout=40)


def fresh_units():
    backend, front = unit_state(BACKEND), unit_state(FRONT)
    require(
        backend.get("ActiveState") == front.get("ActiveState") == "active",
        "Services are not active",
    )
    require(
        int(backend.get("MainPID", 0)) > 0 and int(front.get("MainPID", 0)) > 0,
        "Missing service PID",
    )
    require(
        str(PACKAGE / "app/custom-server.js") in backend.get("ExecStart", ""),
        "Backend command changed",
    )
    require(
        backend.get("WorkingDirectory") == str(PACKAGE / "app"),
        "Backend working directory changed",
    )
    require(
        str(PACKAGE) + ":" in backend.get("BindReadOnlyPaths", ""),
        "Package bind boundary changed",
    )
    return backend, front


def quiet(status):
    return all(
        type(status.get(key)) is int and status[key] == 0
        for key in ("active", "dispatching", "queued")
    )


def require_quiet_front():
    state = control()
    require(
        state.get("activation_paused") is False and state.get("draining") is False,
        "Front already paused or draining; its state is owned by another operation",
    )
    require(
        state.get("backend_ready") is True
        and state.get("public_ready") is True
        and quiet(state),
        "Front is not quiescent; production remains unchanged",
    )
    return state


def stopped():
    state = unit_state(BACKEND)
    require(
        state.get("ActiveState") == "inactive" and state.get("MainPID") == "0",
        "Backend did not stop cleanly; package paths were not changed",
    )


def snapshot_database(destination):
    require(DATABASE.is_file(), "Production database is missing")
    source = sqlite3.connect(
        "file:" + urllib.parse.quote(str(DATABASE)) + "?mode=ro", uri=True
    )
    try:
        with sqlite3.connect(destination) as target:
            source.backup(target)
            require(
                target.execute("PRAGMA quick_check").fetchone()[0] == "ok",
                "Backup integrity failed",
            )
    finally:
        source.close()
    os.chmod(destination, 0o600)


def smoke_inner(sha):
    """Runs inside a filesystem and network namespace; no host credentials exist."""
    package, data = Path("/package"), Path("/data")
    env = clean_environment(RUNTIME_NODE, data)
    env.update({"PORT": "20199", "HOSTNAME": "127.0.0.1"})

    def encode(raw):
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    payload = {
        "authenticated": True,
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
    }
    unsigned = (
        encode(b'{"alg":"HS256","typ":"JWT"}')
        + "."
        + encode(json.dumps(payload).encode())
    )
    token = (
        unsigned
        + "."
        + encode(hmac.digest(env["JWT_SECRET"].encode(), unsigned.encode(), "sha256"))
    )
    headers = {"Cookie": "auth_token=" + token}
    resolve_script = """
      const {createRequire}=require('node:module');const fs=require('node:fs');
      const cli=createRequire('/package/cli.js');const app=createRequire('/package/app/package.json');
      for(const [resolver,names] of [[cli,Object.keys(cli('/package/package.json').dependencies||{})],
        [app,['next','sql.js','open','undici','socks-proxy-agent','uuid','jose']]]){
        for(const name of names){const path=fs.realpathSync(resolver.resolve(name));
          if(!path.startsWith('/package/'))throw new Error('dependency outside package: '+name);}}
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.close();
    """
    run([str(RUNTIME_NODE), "-e", resolve_script], cwd=package, env=env)
    with (data / "server.log").open("wb") as log:
        child = subprocess.Popen(  # noqa: S603 - fixed sandbox paths
            [str(RUNTIME_NODE), str(package / "app/custom-server.js")],
            cwd=package / "app",
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        started = time.monotonic()
        try:
            version = wait_backend(20199, sha, headers, features=True)
            startup_seconds = time.monotonic() - started
            for route in ("/api/context", "/api/tools"):
                status, _ = request_http(20199, route)
                require(
                    status in {401, 403},
                    "Operator endpoint admitted an anonymous caller or failed",
                )
            for route in ("/dashboard/context", "/dashboard/tools"):
                status, content = request_http(20199, route, headers)
                require(
                    status == 200 and b"<html" in content.lower(),
                    "Dashboard route failed",
                )
            return {
                "passed": True,
                "runtime": run([str(RUNTIME_NODE), "--version"]),
                "buildSha": version["buildSha"],
                "startupSeconds": startup_seconds,
                "network": "isolated-loopback-only",
                "hostCredentials": "not-mounted",
                "dependencies": "resolved-inside-package",
                "sqlite": "node:sqlite-available",
            }
        finally:
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()  # This is the owned scratch server, never production.
                child.wait(timeout=5)


def qualify(package, sha, area):
    data = area / "smoke-data"
    data.mkdir(mode=0o700)
    command = [
        "bwrap",
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",  # noqa: S108 - private namespace tmpfs
        "--dir",
        "/etc",
        "--ro-bind",
        "/etc/machine-id",
        "/etc/machine-id",
        "--ro-bind",
        "/etc/passwd",
        "/etc/passwd",
        "--ro-bind",
        str(package),
        "/package",
        "--bind",
        str(data),
        "/data",
        "--ro-bind",
        str(Path(__file__).resolve()),
        "/driver.py",
        "/usr/bin/python3",
        "/driver.py",
        "smoke-inner",
        "--sha",
        sha,
    ]
    result = run(command, env={"PATH": "/usr/bin:/bin"}, timeout=90)
    return json.loads(result.splitlines()[-1])


def stage(sha):
    validate_sha(sha)
    require(
        run(["git", "rev-parse", REF], cwd=SOURCE) == sha,
        "Received integration ref is not the requested SHA",
    )
    require(
        run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=CHECKOUT)
        == "",
        "Build checkout has tracked changes",
    )
    run(["git", "switch", "--detach", sha], cwd=CHECKOUT)
    build_version = run([str(BUILD_NODE), "--version"])
    runtime_version = run([str(RUNTIME_NODE), "--version"])
    require(build_version.startswith("v24."), "Build runtime must be Node 24")
    require(runtime_version.startswith("v24."), "Production runtime must be Node 24")
    area = (
        CHECKOUT / ".deploy-prep" / f"{sha}-{int(time.time())}-{secrets.token_hex(3)}"
    )
    area.mkdir(parents=True, mode=0o700)
    env = clean_environment(BUILD_NODE, area / "build-data")
    env.pop(
        "NODE_ENV"
    )  # Install build-time dependencies as well as runtime dependencies.
    npm = [str(BUILD_NODE), str(BUILD_NODE.parent / "npm")]
    for folder in (CHECKOUT, CHECKOUT / "tests", CHECKOUT / "cli"):
        run(
            [
                *npm,
                "install",
                "--ignore-scripts",
                "--package-lock=false",
                "--no-audit",
                "--no-fund",
            ],
            cwd=folder,
            env=env,
            logfile=area / "dependencies.log",
            timeout=600,
        )
    run(
        [*npm, "run", "build"],
        cwd=CHECKOUT / "cli",
        env=env,
        logfile=area / "build.log",
        timeout=1800,
    )
    run(
        [*npm, "pack", "--ignore-scripts", "--pack-destination", str(area)],
        cwd=CHECKOUT / "cli",
        env=env,
        logfile=area / "pack.log",
        timeout=300,
    )
    archives = list(area.glob("*.tgz"))
    require(len(archives) == 1, "Expected one packed artifact")
    archive = archives[0]
    prefix = area / "prefix"
    run(
        [
            *npm,
            "install",
            "--global",
            "--prefix",
            str(prefix),
            "--install-strategy=nested",
            "--ignore-scripts",
            "--package-lock=false",
            "--no-audit",
            "--no-fund",
            str(archive),
        ],
        env=env,
        logfile=area / "stage-install.log",
        timeout=600,
    )
    candidate = prefix / "lib/node_modules/tokenproxy"
    require(
        candidate.is_dir() and not candidate.is_symlink(),
        "Staged package is not a real directory",
    )
    require(package_sha(candidate) == sha, "Package BUILD_SHA is wrong")
    for relative in (
        "cli.js",
        "app/custom-server.js",
        "app/open-sse/handlers/chatCore.js",
        "app/.next-cli-build/BUILD_ID",
        "app/.next-cli-build/server/app/api/context/route.js",
        "app/.next-cli-build/server/app/api/tools/route.js",
        "app/node_modules/sql.js/dist/sql-wasm.wasm",
    ):
        require(
            (candidate / relative).is_file(),
            f"Missing packaged runtime artifact: {relative}",
        )
    run(
        [*npm, "ls", "--all", "--omit=dev"],
        cwd=candidate,
        env=env,
        logfile=area / "dependency-tree.log",
        timeout=120,
    )
    digest = tree_sha(candidate)
    smoke = qualify(candidate, sha, area)
    require(
        smoke.get("passed") is True and tree_sha(candidate) == digest,
        "Staged smoke modified package or failed",
    )
    require(
        run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=CHECKOUT)
        == "",
        "Build changed tracked source",
    )
    manifest = {
        "schema": 1,
        "sha": sha,
        "createdAt": int(time.time()),
        "archive": str(archive),
        "archiveSha256": file_sha(archive),
        "package": str(candidate),
        "treeSha256": digest,
        "buildNode": build_version,
        "runtimeNode": runtime_version,
        "front": front_source_manifest(),
        "smoke": smoke,
        "buildId": (candidate / "app/.next-cli-build/BUILD_ID").read_text().strip(),
    }
    write_json(area / "manifest.json", manifest)
    return {
        "prepared": True,
        "manifest": str(area / "manifest.json"),
        "sha": sha,
        "smoke": smoke,
    }


def validate_manifest(path):
    manifest = json.loads(Path(path).read_text())
    sha = validate_sha(manifest["sha"])
    candidate = Path(manifest["package"])
    require(
        candidate.resolve().is_relative_to(CHECKOUT / ".deploy-prep"),
        "Package is outside the owned preparation area",
    )
    require(
        not candidate.is_symlink() and package_sha(candidate) == sha,
        "Candidate provenance changed",
    )
    require(
        manifest.get("schema") == 1 and manifest.get("smoke", {}).get("passed") is True,
        "Artifact is unqualified",
    )
    require(
        file_sha(manifest["archive"]) == manifest["archiveSha256"],
        "Packed artifact checksum changed",
    )
    require(
        tree_sha(candidate) == manifest["treeSha256"],
        "Staged package changed after qualification",
    )
    require(
        run([str(RUNTIME_NODE), "--version"]) == manifest["runtimeNode"],
        "Production runtime differs from qualification",
    )
    verify_front_provenance(manifest.get("front") or {})
    return manifest


def require_no_backend_sockets() -> None:
    deadline = time.monotonic() + 0.750
    refusal = "Established backend sockets did not settle before the paused gate deadline; resuming immediately"
    while True:
        remaining = deadline - time.monotonic()
        require(remaining > 0, refusal)
        sockets = run(
            [
                "ss",
                "-Htn",
                "state",
                "established",
                "( sport = :20127 or dport = :20127 )",
            ],
            timeout=remaining,
        )
        remaining = deadline - time.monotonic()
        require(remaining >= 0, refusal)
        if sockets == "":
            return
        require(remaining > 0, refusal)
        time.sleep(min(0.050, remaining))


def cutover_transaction(candidate, old, sha, old_sha, headers, front_pid):
    """Only this function pauses/stops/swaps. Failure after resume never kills new traffic."""
    require_quiet_front()
    paused = False
    old_moved = False
    new_placed = False
    resumed = False
    backend_usable = True
    started = time.monotonic()
    pause_deadline = None
    resumed_at = None

    def require_pause_budget():
        require(
            pause_deadline is None or time.monotonic() < pause_deadline,
            "Atomic pause budget exceeded; restoring the previous release",
        )

    try:
        with pause_budget(PAUSE_BUDGET_SECONDS) as pause_deadline:
            paused = True  # A timed-out request can still have persisted pause.
            status = control("pause")
            require_pause_budget()
            require(
                status.get("activation_paused") is True and quiet(status),
                "A request raced the pause; resuming immediately",
            )
            require(
                unit_state(FRONT).get("MainPID") == front_pid,
                "Front process changed during the gate",
            )
            require_no_backend_sockets()
            require_pause_budget()
            backend_usable = False
            service("stop")
            stopped()
            require_pause_budget()
            PACKAGE.rename(old)
            old_moved = True
            candidate.rename(PACKAGE)
            new_placed = True
            service("start")
            wait_backend(20127, sha, headers, features=True)
            require_pause_budget()
            require(
                unit_state(FRONT).get("MainPID") == front_pid,
                "Front process changed during cutover",
            )
            backend_usable = True
            resumed = True  # Resume may dispatch if its HTTP response times out.
            control("resume")
            resumed_at = time.monotonic()
            paused = False
        verify_backend(20128, sha, headers, features=True)
        final = control()
        require(
            final.get("activation_paused") is False
            and final.get("backend_ready") is True,
            "Front did not return to ready admission",
        )
        return {
            "deployed": True,
            "sha": sha,
            "oldPackage": str(old),
            "frontPID": front_pid,
            "pausedBackendSocketGate": {
                "port": 20127,
                "establishedSockets": 0,
                "frontPID": front_pid,
            },
            "elapsedSeconds": time.monotonic() - started,
            "pauseToResumeSeconds": resumed_at - (pause_deadline - PAUSE_BUDGET_SECONDS),
            "front": final,
        }
    except BaseException:
        if resumed:
            # New generations may already exist. Never roll them back blindly.
            with contextlib.suppress(OSError, GuardError):
                control("resume")
            raise GuardError(
                "Validation failed after resume; backend left running for inspection"
            ) from None
        # Reconcile from the filesystem as well as flags. SIGALRM can arrive
        # after an atomic rename returns but before the following assignment.
        if old_moved or old.exists():
            service("stop")
            stopped()
            if new_placed or PACKAGE.exists():
                require(
                    not candidate.exists(),
                    "Rollback candidate path is unexpectedly occupied",
                )
                PACKAGE.rename(candidate)
            old.rename(PACKAGE)
        if not backend_usable:
            service("start")
            wait_backend(20127, old_sha, headers, features=False)
            backend_usable = True
        raise
    finally:
        if paused and not resumed and backend_usable:
            control("resume")


def cutover(
    manifest_path,
    expected_old_sha,
    authentication,
    *,
    direct_backend_traffic_accounted=False,
):
    require(
        direct_backend_traffic_accounted,
        "The operator must first account for inference callers bypassing the front on port 20127",
    )
    require_quiet_front()  # Refuse a busy attempt before copying packages or the database.
    validate_sha(expected_old_sha)
    manifest = validate_manifest(manifest_path)
    headers = auth_headers(authentication)
    require(
        PACKAGE.is_dir() and not PACKAGE.is_symlink(),
        "Live package is not a real directory",
    )
    require(
        package_sha(PACKAGE) == expected_old_sha,
        "Installed package differs from expected previous release",
    )
    _, front = fresh_units()
    verify_backend(20127, expected_old_sha, headers, features=False)
    area = Path(manifest_path).parent
    stamp = f"{int(time.time())}-{secrets.token_hex(3)}"
    backup_dir = area / f"rollback-{stamp}"
    backup_dir.mkdir(mode=0o700)
    snapshot_database(backup_dir / "data.sqlite")
    shutil.copytree(PACKAGE, backup_dir / "package", symlinks=True)
    old_digest = tree_sha(PACKAGE)
    require(
        tree_sha(backup_dir / "package") == old_digest, "Old package backup differs"
    )
    candidate = PACKAGE.parent / f".tokenproxy-prepared-{manifest['sha'][:12]}-{stamp}"
    old = PACKAGE.parent / f".tokenproxy-rollback-{expected_old_sha[:12]}-{stamp}"
    require(
        not old.exists() and not candidate.exists(),
        "Prepared or rollback path already exists",
    )
    shutil.copytree(manifest["package"], candidate, symlinks=True)
    require(
        candidate.stat().st_dev == PACKAGE.stat().st_dev,
        "Package swap would cross filesystems",
    )
    require(
        tree_sha(candidate) == manifest["treeSha256"],
        "Prepared replacement differs from qualification",
    )
    require(
        tree_sha(PACKAGE) == old_digest and package_sha(PACKAGE) == expected_old_sha,
        "Live package changed during preparation",
    )
    _, current_front = fresh_units()
    require(
        current_front["MainPID"] == front["MainPID"],
        "Front process changed during preparation",
    )
    try:
        result = cutover_transaction(
            candidate, old, manifest["sha"], expected_old_sha, headers, front["MainPID"]
        )
        result["backup"] = str(backup_dir)
        result["directBackendTraffic"] = "operator-attested direct-caller inventory"
        write_json(backup_dir / "result.json", result)
        return result
    except BaseException:
        write_json(
            backup_dir / "result.json",
            {
                "verified": False,
                "sha": manifest["sha"],
                "installedSha": package_sha(PACKAGE) if PACKAGE.exists() else None,
                "candidate": str(candidate),
                "oldPackage": str(old),
                "databaseRestored": False,
            },
        )
        raise


def main():
    os.umask(0o077)

    def interrupted(signum, _frame):
        raise InterruptedError(f"Driver interrupted by signal {signum}")

    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="action", required=True)
    prepare = subcommands.add_parser(
        "stage",
        help="Build and qualify an exact received SHA without production changes",
    )
    prepare.add_argument("--sha", required=True)
    deploy = subcommands.add_parser(
        "cutover", help="Explicitly perform the guarded production package switch"
    )
    deploy.add_argument("--manifest", required=True)
    deploy.add_argument("--expected-old-sha", required=True)
    deploy.add_argument("--operator-auth-file", required=True)
    deploy.add_argument(
        "--direct-backend-traffic-accounted",
        action="store_true",
        required=True,
        help="Operator attestation that inference bypassing the front on 20127 is absent or accounted for",
    )
    smoke = subcommands.add_parser("smoke-inner", help=argparse.SUPPRESS)
    smoke.add_argument("--sha", required=True)
    args = parser.parse_args()
    if args.action == "stage":
        result = stage(args.sha)
    elif args.action == "cutover":
        result = cutover(
            args.manifest,
            args.expected_old_sha,
            args.operator_auth_file,
            direct_backend_traffic_accounted=args.direct_backend_traffic_accounted,
        )
    else:
        require(
            Path("/package").is_dir() and Path("/data").is_dir(),
            "Internal smoke requires its sandbox",
        )
        result = smoke_inner(validate_sha(args.sha))
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (GuardError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(
            f"Deployment driver refused or failed: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        sys.exit(1)
