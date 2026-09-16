"""T06: one removal attempt in a disposable worktree with an owned open handle.

This deliberately destructive fixture measures OS behaviour, not permission to
remove an in-use user object. No user directory, task or process is accessed.
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def held_file(path: Path):
    if os.name != "nt":
        with path.open("rb") as stream:
            yield stream
        return
    from ctypes import wintypes
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                               ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    api.CreateFileW.restype = wintypes.HANDLE
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    # Read/write sharing is permitted; FILE_SHARE_DELETE is intentionally absent.
    handle = api.CreateFileW(str(path), 0x80000000, 3, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise OSError(ctypes.get_last_error(), "cannot create owned test handle")
    try:
        yield handle
    finally:
        if not api.CloseHandle(handle):
            raise OSError(ctypes.get_last_error(), "cannot close owned test handle")


def run_probe() -> dict:
    with tempfile.TemporaryDirectory(prefix="dsh-t06-") as directory:
        root = Path(directory).resolve()
        repo, worktree = root / "repo", root / "worktree"
        repo.mkdir()
        def git(*args: str, checked: bool = True):
            result = subprocess.run(["git", "-c", "user.name=T06", "-c", "user.email=t06@example.invalid", *args],
                                    cwd=repo, capture_output=True, text=True, check=False)
            if checked and result.returncode:
                raise RuntimeError("isolated Git fixture command failed")
            return result
        git("init", "--quiet")
        (repo / "held.txt").write_text("owned fixture\n")
        (repo / "removed.txt").write_text("owned fixture\n")
        git("add", ".")
        git("commit", "--quiet", "-m", "synthetic fixture")
        git("worktree", "add", "--quiet", "--detach", str(worktree))
        unknown = root / "unknown-candidate"
        unknown.mkdir()
        (unknown / "preserved.txt").write_text("unknown dependency: retain\n")
        with held_file(worktree / "held.txt"):
            # Controlled partial content removal precedes the one directory
            # removal attempt. This is an OS fixture, never a guarded workflow.
            (worktree / "removed.txt").unlink()
            attempt = git("worktree", "remove", "--force", str(worktree), checked=False)
            listed = git("worktree", "list", "--porcelain").stdout
            held_exists = (worktree / "held.txt").exists()
            result = {
                "removalAttempts": 1,
                "dependencyStatus": "in_use",
                "unknownCandidateRetained": (unknown / "preserved.txt").read_text() == "unknown dependency: retain\n",
                "metadataRemoved": "no" if str(worktree) in listed else "yes",
                "contentRemoved": "partial" if held_exists else "yes",
                "directoryRemoved": "no" if worktree.exists() else "yes",
                "commandSucceeded": attempt.returncode == 0,
                "certificate": None,
                "scope": "owned disposable OS fixture; not an automatic removal policy",
            }
            if not result["unknownCandidateRetained"]:
                raise RuntimeError("unknown-dependency fixture was changed")
            if os.name == "nt" and (attempt.returncode == 0 or not held_exists or not worktree.exists()):
                raise RuntimeError("Windows fixture did not demonstrate a held-handle partial removal")
            if os.name != "nt" and (attempt.returncode != 0 or worktree.exists()):
                raise RuntimeError("POSIX fixture did not demonstrate unlink of an open file")
        # The owned handle closes normally before temporary fixture cleanup.
    result["cleanup"] = "passed"
    return result
