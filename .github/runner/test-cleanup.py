import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HOOK = Path(__file__).with_name("cleanup.sh")


def run_hook(root, workspace, free_gib=100):
    # The fixture can live on a small tmpfs, independently of the runner SSD.
    # Inject only disk availability in the child; execute the real hook as-is.
    with tempfile.TemporaryDirectory() as fixture:
        Path(fixture, "sitecustomize.py").write_text(
            "import shutil\nfrom collections import namedtuple\n"
            "usage = namedtuple('usage', 'total used free')\n"
            f"shutil.disk_usage = lambda _: usage(200 << 30, 0, {free_gib} << 30)\n"
        )
        env = {**os.environ, "PYTHONPATH": fixture, "TERMLOOP_RUNNER_WORK_ROOT": str(root), "GITHUB_WORKSPACE": str(workspace)}
        return subprocess.run(["bash", str(HOOK.resolve())], cwd=workspace, env=env, capture_output=True, text=True)


class RunnerCleanupTest(unittest.TestCase):
    def test_cleans_job_files_and_preserves_toolchains_and_server_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / "actions-runner" / "_work"
            workspace = root / "termloop" / "termloop"
            workspace.mkdir(parents=True)
            (root.parent / ".runner").write_text("{}")
            (workspace / "build-output").write_text("disposable")
            cache = base / "job-cache"
            cache.mkdir()
            (cache / "download").write_text("disposable")
            pnpm = base / "setup-pnpm" / "node_modules" / ".bin" / "store"
            pnpm.mkdir(parents=True)
            (pnpm / "package").write_text("disposable")
            server = base / "server-state"
            server.mkdir()
            (server / "database").write_text("keep")
            (workspace / "linked-state").symlink_to(server, target_is_directory=True)
            toolchain = root / "_tool"
            toolchain.mkdir()
            result = run_hook(root, workspace)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(workspace.is_dir())
            self.assertEqual(list(workspace.iterdir()), [])
            followup = subprocess.run(["pwd"], cwd=workspace, capture_output=True, text=True)
            self.assertEqual(followup.returncode, 0, followup.stderr)
            self.assertFalse(cache.exists())
            self.assertFalse((base / "setup-pnpm").exists())
            self.assertEqual((server / "database").read_text(), "keep")
            self.assertTrue(toolchain.exists())

    def test_rejects_workspace_outside_registered_runner(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / "actions-runner" / "_work"
            root.mkdir(parents=True)
            (root.parent / ".runner").write_text("{}")
            outside = base / "server-state"
            outside.mkdir()
            result = run_hook(root, outside)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(outside.exists())

    def test_refuses_build_work_when_cleanup_leaves_too_little_space(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            root = base / "actions-runner" / "_work"
            workspace = root / "termloop" / "termloop"
            workspace.mkdir(parents=True)
            (root.parent / ".runner").write_text("{}")
            (workspace / "build-output").write_text("disposable")
            result = run_hook(root, workspace, free_gib=1)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("at least 20 GiB", result.stderr)
            self.assertTrue(workspace.is_dir())
            self.assertEqual(list(workspace.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
