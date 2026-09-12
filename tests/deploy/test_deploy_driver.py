"""Filesystem swaps are real temporary directories; every service/control action is mocked."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "deploy_driver", Path(__file__).parents[2] / "scripts/deploy/deploy_driver.py"
)
driver = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(driver)
OLD_SHA = "a" * 40
NEW_SHA = "b" * 40


class CutoverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.live, self.candidate, self.old = (self.root / name for name in ("live", "candidate", "old"))
        self.live.mkdir()
        self.candidate.mkdir()
        (self.live / "BUILD_SHA").write_text(OLD_SHA)
        (self.candidate / "BUILD_SHA").write_text(NEW_SHA)
        self.actions = []
        self.paused = False
        self.active = 0
        self.dispatching = 0
        self.running = True
        self.race = False
        self.pause_timeout = False
        self.start_failure = False
        self.stop_failure = False
        self.front_failure = False
        self.front_pid = "front-1"
        self.socket_output = ""
        self.socket_returncode = 0
        self.socket_error = None
        self.socket_outputs = []
        self.socket_timeouts = []
        self.socket_scan_seconds = 0.0
        self.verify_seconds = 0.0
        self.clock = 0.0
        socket_command = patch.object(driver.subprocess, "run", self.scan_sockets)
        socket_command.start()
        self.addCleanup(socket_command.stop)
        for name, value in (("monotonic", lambda: self.clock), ("sleep", self.sleep)):
            clock_mock = patch.object(driver.time, name, value)
            clock_mock.start()
            self.addCleanup(clock_mock.stop)
        for name, value in (
            ("PACKAGE", self.live),
            ("control", self.control),
            ("service", self.service),
            ("unit_state", self.unit),
            ("wait_backend", self.verify),
            ("verify_backend", self.verify),
            (
                "wait_existing_backend",
                lambda port, sha, headers: self.verify(port, sha, headers, features=False),
            ),
            (
                "verify_existing_backend",
                lambda port, sha, headers, _unit: self.verify(port, sha, headers, features=False),
            ),
        ):
            mock = patch.object(driver, name, value)
            mock.start()
            self.addCleanup(mock.stop)

    def status(self):
        return {
            "activation_paused": self.paused,
            "draining": False,
            "backend_ready": True,
            "public_ready": True,
            "active": self.active,
            "dispatching": self.dispatching,
            "queued": 0,
        }

    def scan_sockets(self, argv, **kwargs):
        self.assertEqual(
            argv,
            [
                "ss",
                "-Htn",
                "state",
                "established",
                "( sport = :20127 or dport = :20127 )",
            ],
        )
        self.assertGreater(kwargs["timeout"], 0)
        self.assertLessEqual(kwargs["timeout"], 0.750)
        self.socket_timeouts.append(kwargs["timeout"])
        self.assertTrue(self.paused)
        self.assertTrue(self.running)
        self.actions.append("sockets:scan")
        if self.socket_error:
            raise self.socket_error
        self.clock += self.socket_scan_seconds
        output = self.socket_outputs.pop(0) if self.socket_outputs else self.socket_output
        if not output:
            self.actions.append("sockets:empty")
        return subprocess.CompletedProcess(argv, self.socket_returncode, output)

    def sleep(self, seconds):
        self.assertGreater(seconds, 0)
        self.assertLessEqual(seconds, 0.050)
        self.clock += seconds

    def control(self, action="status"):
        self.actions.append("front:" + action)
        if action == "pause":
            self.paused = True
            if self.race:
                self.active = 1
            if self.pause_timeout:
                raise TimeoutError("pause response timed out after applying")
        if action == "resume":
            self.paused = False
        return self.status()

    def unit(self, name):
        if name == driver.FRONT:
            return {"MainPID": self.front_pid, "ActiveState": "active"}
        return {
            "MainPID": "backend-1" if self.running else "0",
            "ActiveState": "active" if self.running else "inactive",
            "Environment": "TOKENPROXY_NO_UPDATE=1",
        }

    def service(self, action):
        if action == "stop":
            self.assertIn("sockets:empty", self.actions)
        self.actions.append("backend:" + action)
        if action == "stop" and self.stop_failure:
            return
        if action == "start" and self.start_failure:
            self.start_failure = False
            raise driver.GuardError("synthetic startup failure")
        self.running = action == "start"

    def verify(self, port, sha, _headers, *, features):
        self.actions.append(f"verify:{port}:{sha[0]}")
        self.clock += self.verify_seconds
        if port == 20128 and self.front_failure:
            raise driver.GuardError("synthetic front failure after admission resumed")
        self.assertTrue(self.running)
        self.assertEqual(driver.package_sha(self.live), sha)
        return {"buildSha": sha[:12]}

    def invoke(self):
        return driver.cutover_transaction(self.candidate, self.old, NEW_SHA, OLD_SHA, {}, "front-1")

    def test_active_generation_refuses_before_pause_or_stop(self):
        self.active = 1
        with self.assertRaises(driver.GuardError):
            self.invoke()
        self.assertEqual(self.actions, ["front:status"])
        self.assertEqual(driver.package_sha(self.live), OLD_SHA)

    def test_busy_preparation_refuses_before_reading_manifest_or_copying(self):
        self.active = 1
        with self.assertRaisesRegex(driver.GuardError, "not quiescent"):
            driver.cutover(
                "nonexistent-manifest",
                OLD_SHA,
                "nonexistent-auth",
                direct_backend_traffic_accounted=True,
            )
        self.assertEqual(self.actions, ["front:status"])

    def test_direct_backend_traffic_requires_operator_attestation(self):
        with self.assertRaisesRegex(driver.GuardError, "port 20127"):
            driver.cutover("nonexistent-manifest", OLD_SHA, "nonexistent-auth")
        self.assertEqual(self.actions, [])

    def test_waiting_for_upstream_headers_also_refuses(self):
        self.dispatching = 1
        with self.assertRaises(driver.GuardError):
            self.invoke()
        self.assertNotIn("front:pause", self.actions)

    def test_existing_pause_is_not_owned_or_resumed(self):
        self.paused = True
        with self.assertRaises(driver.GuardError):
            self.invoke()
        self.assertTrue(self.paused)
        self.assertEqual(self.actions, ["front:status"])

    def test_generation_racing_pause_resumes_without_stopping(self):
        self.race = True
        with self.assertRaisesRegex(driver.GuardError, "raced"):
            self.invoke()
        self.assertFalse(self.paused)
        self.assertNotIn("backend:stop", self.actions)
        self.assertEqual(driver.package_sha(self.live), OLD_SHA)

    def test_timed_out_pause_is_explicitly_resumed(self):
        self.pause_timeout = True
        with self.assertRaises(TimeoutError):
            self.invoke()
        self.assertFalse(self.paused)
        self.assertNotIn("backend:stop", self.actions)

    def test_success_retains_old_directory_and_validates_before_resume(self):
        result = self.invoke()
        self.assertTrue(result["deployed"])
        self.assertEqual(
            result["pausedBackendSocketGate"],
            {"port": 20127, "establishedSockets": 0, "frontPID": "front-1"},
        )
        self.assertLess(self.actions.index("sockets:empty"), self.actions.index("backend:stop"))
        self.assertEqual(self.socket_timeouts, [0.750])
        self.assertEqual(self.clock, 0)
        self.assertEqual(result["pauseToResumeSeconds"], 0)
        self.assertLess(result["pauseToResumeSeconds"], driver.PAUSE_BUDGET_SECONDS)
        self.assertEqual(driver.package_sha(self.live), NEW_SHA)
        self.assertEqual(driver.package_sha(self.old), OLD_SHA)
        self.assertLess(self.actions.index("verify:20127:b"), self.actions.index("front:resume"))
        self.assertFalse(self.paused)

    def assert_socket_refusal_preserved_backend(self):
        self.assertIn("sockets:scan", self.actions)
        self.assertEqual(self.actions[-1], "front:resume")
        self.assertNotIn("backend:stop", self.actions)
        self.assertNotIn("backend:start", self.actions)
        self.assertFalse(self.paused)
        self.assertTrue(self.running)
        self.assertEqual(driver.package_sha(self.live), OLD_SHA)
        self.assertEqual(driver.package_sha(self.candidate), NEW_SHA)
        self.assertFalse(self.old.exists())

    def test_established_backend_socket_refuses_and_resumes(self):
        self.socket_output = "0 0 127.0.0.1:20127 127.0.0.1:45000\n"
        with self.assertRaisesRegex(driver.GuardError, "Established backend sockets"):
            self.invoke()
        self.assert_socket_refusal_preserved_backend()
        self.assertAlmostEqual(self.clock, 0.750)
        self.assertGreater(len(self.socket_timeouts), 1)
        self.assertNotIn("sockets:empty", self.actions)

    def test_transient_socket_must_clear_before_backend_stop(self):
        self.socket_outputs = ["0 0 127.0.0.1:20127 127.0.0.1:45000\n", ""]
        result = self.invoke()
        self.assertTrue(result["deployed"])
        self.assertEqual(len(self.socket_timeouts), 2)
        self.assertAlmostEqual(self.socket_timeouts[1], 0.700)
        self.assertAlmostEqual(self.clock, 0.050)
        self.assertLess(self.actions.index("sockets:empty"), self.actions.index("backend:stop"))

    def test_socket_timeout_tracks_remaining_deadline_after_scan_and_sleep(self):
        self.socket_outputs = ["established socket", ""]
        self.socket_scan_seconds = 0.010
        self.invoke()
        self.assertEqual(len(self.socket_timeouts), 2)
        self.assertAlmostEqual(self.socket_timeouts[0], 0.750)
        self.assertAlmostEqual(self.socket_timeouts[1], 0.690)
        self.assertAlmostEqual(self.clock, 0.070)

    def test_socket_sleep_does_not_extend_deadline(self):
        self.socket_output = "established socket"
        self.socket_scan_seconds = 0.720
        with self.assertRaisesRegex(driver.GuardError, "deadline"):
            self.invoke()
        self.assert_socket_refusal_preserved_backend()
        self.assertEqual(len(self.socket_timeouts), 1)
        self.assertAlmostEqual(self.clock, 0.750)

    def test_empty_socket_result_after_deadline_refuses_and_resumes(self):
        self.socket_scan_seconds = 0.751
        with self.assertRaisesRegex(driver.GuardError, "deadline"):
            self.invoke()
        self.assert_socket_refusal_preserved_backend()

    def test_socket_command_nonzero_refuses_and_resumes(self):
        self.socket_returncode = 1
        with self.assertRaisesRegex(driver.GuardError, "Command failed"):
            self.invoke()
        self.assert_socket_refusal_preserved_backend()

    def test_socket_command_timeout_refuses_and_resumes(self):
        self.socket_error = subprocess.TimeoutExpired("ss", 3)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.invoke()
        self.assert_socket_refusal_preserved_backend()

    def test_socket_command_unavailable_refuses_and_resumes(self):
        self.socket_error = FileNotFoundError("ss")
        with self.assertRaises(FileNotFoundError):
            self.invoke()
        self.assert_socket_refusal_preserved_backend()

    def test_failed_new_start_restores_old_package_before_resuming(self):
        self.start_failure = True
        with self.assertRaisesRegex(driver.GuardError, "startup"):
            self.invoke()
        self.assertEqual(driver.package_sha(self.live), OLD_SHA)
        self.assertEqual(driver.package_sha(self.candidate), NEW_SHA)
        self.assertTrue(self.running)
        self.assertFalse(self.paused)
        self.assertLess(self.actions.index("verify:20127:a"), self.actions.index("front:resume"))

    def test_failed_second_rename_restores_the_first(self):
        original = Path.rename

        def rename(path, target):
            if path == self.candidate:
                raise OSError("synthetic second rename failure")
            return original(path, target)

        with patch.object(Path, "rename", rename), self.assertRaises(OSError):
            self.invoke()
        self.assertEqual(driver.package_sha(self.live), OLD_SHA)
        self.assertFalse(self.paused)
        self.assertTrue(self.running)

    def test_interruption_after_first_rename_restores_from_filesystem_state(self):
        original = Path.rename

        def rename(path, target):
            result = original(path, target)
            if path == self.live:
                raise InterruptedError("synthetic interruption after first rename")
            return result

        with patch.object(Path, "rename", rename), self.assertRaises(InterruptedError):
            self.invoke()
        self.assertEqual(driver.package_sha(self.live), OLD_SHA)
        self.assertEqual(driver.package_sha(self.candidate), NEW_SHA)
        self.assertFalse(self.paused)

    def test_interruption_after_second_rename_restores_from_filesystem_state(self):
        original = Path.rename

        def rename(path, target):
            result = original(path, target)
            if path == self.candidate:
                raise InterruptedError("synthetic interruption after second rename")
            return result

        with patch.object(Path, "rename", rename), self.assertRaises(InterruptedError):
            self.invoke()
        self.assertEqual(driver.package_sha(self.live), OLD_SHA)
        self.assertEqual(driver.package_sha(self.candidate), NEW_SHA)
        self.assertFalse(self.paused)

    def test_incomplete_stop_never_changes_package(self):
        self.stop_failure = True
        with self.assertRaisesRegex(driver.GuardError, "did not stop"):
            self.invoke()
        self.assertEqual(driver.package_sha(self.live), OLD_SHA)
        self.assertFalse(self.old.exists())
        self.assertFalse(self.paused)

    def test_failure_after_resume_does_not_stop_new_generations(self):
        self.front_failure = True
        with self.assertRaisesRegex(driver.GuardError, "after resume"):
            self.invoke()
        self.assertEqual(driver.package_sha(self.live), NEW_SHA)
        self.assertEqual(self.actions.count("backend:stop"), 1)
        self.assertTrue(self.running)
        self.assertFalse(self.paused)

    def test_pause_budget_expiry_restores_old_release_before_resuming(self):
        self.verify_seconds = 4.001
        with self.assertRaisesRegex(driver.GuardError, "pause budget"):
            self.invoke()
        self.assertEqual(driver.package_sha(self.live), OLD_SHA)
        self.assertTrue(self.running)
        self.assertFalse(self.paused)

    def test_changed_front_pid_refuses_without_backend_stop(self):
        self.front_pid = "different-front"
        with self.assertRaisesRegex(driver.GuardError, "Front process changed"):
            self.invoke()
        self.assertNotIn("backend:stop", self.actions)
        self.assertFalse(self.paused)

    def test_package_integrity_rejects_external_symlinks(self):
        outside = self.root / "outside"
        outside.write_text("external dependency")
        (self.candidate / "escape").symlink_to(outside)
        with self.assertRaisesRegex(driver.GuardError, "External package symlink"):
            driver.tree_sha(self.candidate)

    def test_package_digest_detects_content_change(self):
        before = driver.tree_sha(self.candidate)
        (self.candidate / "BUILD_SHA").write_text("c" * 40)
        self.assertNotEqual(before, driver.tree_sha(self.candidate))


class FrontProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.front = self.root / "front"
        self.front.mkdir()
        self.unit = self.root / "tokenproxy-front.service"
        (self.front / "front-proxy.mjs").write_text("front-v1")
        self.unit.write_text("unit-v1")
        self.front_patch = patch.object(driver, "FRONT_PACKAGE", self.front)
        self.unit_patch = patch.object(driver, "FRONT_UNIT", self.unit)
        self.front_patch.start()
        self.unit_patch.start()
        self.addCleanup(self.front_patch.stop)
        self.addCleanup(self.unit_patch.stop)

    def manifest(self):
        return {
            "schema": 1,
            "sourceSha": OLD_SHA,
            "files": {
                "front-proxy.mjs": driver.file_sha(self.front / "front-proxy.mjs"),
                "tokenproxy-front.service": driver.file_sha(self.unit),
            },
        }

    def test_installed_front_must_match_the_staged_source_manifest(self):
        manifest = self.manifest()
        driver.verify_front_provenance(manifest)
        (self.front / "front-proxy.mjs").write_text("changed")
        with self.assertRaisesRegex(driver.GuardError, "front-proxy.mjs"):
            driver.verify_front_provenance(manifest)

    def test_front_manifest_rejects_a_path_escape_before_reading_it(self):
        manifest = self.manifest()
        manifest["files"]["../outside"] = "0" * 64
        with self.assertRaisesRegex(driver.GuardError, "invalid closure"):
            driver.verify_front_provenance(manifest)


class PauseBudgetTests(unittest.TestCase):
    def test_wall_timer_interrupts_a_blocking_cutover_operation(self):
        with self.assertRaisesRegex(driver.GuardError, "pause budget"), driver.pause_budget(0.02):
            driver.signal.pause()


class LegacyReadinessTests(unittest.TestCase):
    def test_manifest_pinned_legacy_health_requires_disabled_updates_and_exact_build(self):
        replies = {
            "/api/ready": (404, b'{"error":"not found"}'),
            "/api/health": (200, b'{"ok":true}'),
            "/api/version": (200, json.dumps({"buildSha": OLD_SHA[:12]}).encode()),
        }
        with patch.object(driver, "request_http", side_effect=lambda _port, path, _headers=None: replies[path]):
            result = driver.verify_existing_backend(
                20127,
                OLD_SHA,
                {},
                {"Environment": "NODE_ENV=production TOKENPROXY_NO_UPDATE=1"},
            )
        self.assertEqual(result["buildSha"], OLD_SHA[:12])

    def test_legacy_health_refuses_without_disabled_updates(self):
        with (
            patch.object(
                driver,
                "request_http",
                return_value=(404, b'{"error":"not found"}'),
            ),
            self.assertRaisesRegex(driver.GuardError, "TOKENPROXY_NO_UPDATE"),
        ):
            driver.verify_existing_backend(20127, OLD_SHA, {}, {"Environment": ""})

    def test_versioned_readiness_never_uses_legacy_health(self):
        replies = {
            "/api/ready": (200, b'{"ready":true}'),
            "/api/version": (200, json.dumps({"buildSha": OLD_SHA[:12]}).encode()),
        }
        paths = []

        def request(_port, path, _headers=None):
            paths.append(path)
            return replies[path]

        with patch.object(driver, "request_http", side_effect=request):
            driver.verify_existing_backend(20127, OLD_SHA, {}, {"Environment": ""})
        self.assertEqual(paths, ["/api/ready", "/api/version"])


class DeploymentManifestTests(unittest.TestCase):
    def test_manifest_path_must_be_inside_the_owned_preparation_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkout = root / "checkout"
            (checkout / ".deploy-prep").mkdir(parents=True)
            manifest = root / "outside.json"
            manifest.write_text("{}")
            with (
                patch.object(driver, "CHECKOUT", checkout),
                self.assertRaisesRegex(driver.GuardError, "outside the owned"),
            ):
                driver.validate_manifest(manifest, OLD_SHA)

    def test_manifest_binds_the_previous_release_before_package_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary) / "checkout"
            preparation = checkout / ".deploy-prep" / "candidate"
            preparation.mkdir(parents=True)
            manifest = preparation / "manifest.json"
            manifest.write_text(json.dumps({"sha": NEW_SHA, "expectedOldSha": NEW_SHA}))
            with (
                patch.object(driver, "CHECKOUT", checkout),
                self.assertRaisesRegex(driver.GuardError, "previous release"),
            ):
                driver.validate_manifest(manifest, OLD_SHA)


class DeploymentEntrypointTests(unittest.TestCase):
    def test_stage_receives_the_manifest_pinned_previous_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            python = root / "python"
            invoked = root / "python-invoked"
            python.write_text(f"#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >{invoked!s}\nexit 99\n")
            python.chmod(0o755)
            auth = root / "auth.json"
            auth.write_text('{"Cookie":"fixture"}')
            result = subprocess.run(  # noqa: S603 - isolated fixed fixture
                [
                    "/usr/bin/bash",
                    str(Path(__file__).parents[2] / "scripts/deploy/deploy-main.sh"),
                    "--sha",
                    NEW_SHA,
                    "--expected-old-sha",
                    OLD_SHA,
                    "--operator-auth-file",
                    str(auth),
                    "--direct-backend-traffic-accounted",
                ],
                env={
                    **os.environ,
                    "PATH": f"{fake_bin}:{os.environ['PATH']}",
                    "TOKENPROXY_DEPLOY_PYTHON": str(python),
                },
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 99)
            self.assertEqual(
                invoked.read_text().strip(),
                f"{Path(__file__).parents[2] / 'scripts/deploy/deploy_driver.py'} "
                f"stage --sha {NEW_SHA} --expected-old-sha {OLD_SHA}",
            )


if __name__ == "__main__":
    unittest.main()
