"""Real filesystem links for native-harness unit fixtures; never change OS policy."""
import errno
import os
import stat
import subprocess
from pathlib import Path


def directory_link(target: Path, link: Path) -> None:
    target = target.resolve(strict=True)
    if os.name == "nt":
        subprocess.run(["node", "-e", "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')",
                        str(target), str(link)], check=True, capture_output=True, timeout=10)
        info = link.lstat()
        if not (info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT) or info.st_reparse_tag != stat.IO_REPARSE_TAG_MOUNT_POINT:
            raise AssertionError("fixture did not create a Windows junction")
    else:
        link.symlink_to(target, target_is_directory=True)
    if link.resolve(strict=True) != target:
        raise AssertionError("fixture directory link reaches the wrong physical target")


def file_symlink_or_skip(test, target: Path, link: Path) -> None:
    try:
        link.symlink_to(target)
    except OSError as error:
        if os.name == "nt" and (getattr(error, "winerror", None) == 1314 or error.errno in (errno.EPERM, errno.EACCES)):
            test.skipTest("Windows file-symlink privilege unavailable; only this file-link case is skipped; privileged Windows CI executes it")
        raise
    if not link.is_symlink() or link.resolve(strict=True) != target.resolve(strict=True):
        raise AssertionError("fixture file symlink reaches the wrong physical target")
