import subprocess
import sys
from pathlib import Path


def main() -> int:
    test_files = sorted(Path(__file__).resolve().parent.glob("test_*.py"))
    passed = 0
    failed = 0
    for test_file in test_files:
        result = subprocess.run(
            [sys.executable, str(test_file)],
            cwd=str(test_file.parent),
            text=True,
            capture_output=True,
        )
        if result.stdout:
            print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
        if result.stderr:
            print(result.stderr, end="" if result.stderr.endswith("\n") else "\n")
        if result.returncode == 0:
            passed += 1
            print(f"PASS {test_file.name}")
        else:
            failed += 1
            print(f"FAIL {test_file.name} (exit {result.returncode})")
    print(f"TOTAL: {passed} passed, {failed} failed, {len(test_files)} files")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
