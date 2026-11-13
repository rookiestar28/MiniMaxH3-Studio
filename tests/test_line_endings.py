"""Keep Git's text checkout policy independent of the contributor's platform."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Any exception must name the tracked path and explain its byte-level consumer.
INTENTIONAL_NON_LF: dict[str, str] = {}
INTENTIONAL_BOM: dict[str, str] = {}


def _entries(root: Path = ROOT) -> list[tuple[str, str]]:
    output = subprocess.check_output(["git", "ls-files", "--eol", "-z"], cwd=root)
    entries = []
    for record in output.split(b"\0"):
        if record:
            metadata, separator, path = record.partition(b"\t")
            if not separator:
                raise AssertionError("git ls-files --eol returned no path separator")
            entries.append((os.fsdecode(path), metadata.split()[0].decode("ascii")))
    return entries


def _bom_paths(root: Path, exceptions: dict[str, str]) -> list[str]:
    if not all(reason.strip() for reason in exceptions.values()):
        raise AssertionError("every BOM exception must explain its byte-level consumer")
    text_paths = {path for path, indexed in _entries(root) if indexed != "i/-text"}
    stages = subprocess.check_output(["git", "ls-files", "--stage", "-z"], cwd=root)
    offenders = []
    # CRITICAL: read stage-zero objects, never checkout bytes or HEAD; an unstaged BOM removal
    # must not hide a BOM that would be committed. Drain blobs in chunks to bound census memory.
    with subprocess.Popen(
        ["git", "cat-file", "--batch"], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE
    ) as batch:
        assert batch.stdin is not None and batch.stdout is not None
        try:
            for record in stages.split(b"\0"):
                if not record:
                    continue
                metadata, separator, raw_path = record.partition(b"\t")
                if not separator:
                    raise AssertionError("git ls-files --stage returned no path separator")
                mode, oid, stage = metadata.split()
                if stage != b"0":
                    raise AssertionError("BOM census requires an unmerged-free index")
                path = os.fsdecode(raw_path)
                if mode == b"160000" or path not in text_paths or path in exceptions:
                    continue
                batch.stdin.write(oid + b"\n")
                batch.stdin.flush()
                header = batch.stdout.readline().split()
                if len(header) != 3 or header[:2] != [oid, b"blob"]:
                    raise AssertionError("git cat-file returned an unexpected index object")
                size = int(header[2])
                prefix = batch.stdout.read(min(size, 3))
                remaining = size - len(prefix)
                while remaining:
                    chunk = batch.stdout.read(min(remaining, 128 * 1024))
                    if not chunk:
                        raise AssertionError("git cat-file truncated an index blob")
                    remaining -= len(chunk)
                if batch.stdout.read(1) != b"\n":
                    raise AssertionError("git cat-file returned no blob terminator")
                if prefix == b"\xef\xbb\xbf":
                    offenders.append(path)
        except BaseException:
            batch.kill()
            raise
        finally:
            batch.stdin.close()
        if batch.wait(timeout=30) != 0:
            raise AssertionError("git cat-file failed")
    return offenders


class LineEndingTests(unittest.TestCase):
    def test_index_has_no_unexplained_utf8_bom(self) -> None:
        self.assertEqual(_bom_paths(ROOT, INTENTIONAL_BOM), [], "tracked text must be BOM-free")

    def test_first_attribute_rule_sets_lf_for_all_text(self) -> None:
        rules = [
            line.strip()
            for line in (ROOT / ".gitattributes").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        self.assertTrue(rules, "a repository-wide checkout rule is required")
        self.assertEqual(rules[0].split(), ["*", "text=auto", "eol=lf"])

    def test_index_has_no_unexplained_crlf_or_mixed_text(self) -> None:
        self.assertTrue(all(reason.strip() for reason in INTENTIONAL_NON_LF.values()))
        offenders = [
            path
            for path, indexed in _entries()
            if indexed in {"i/crlf", "i/mixed"} and path not in INTENTIONAL_NON_LF
        ]
        self.assertEqual(offenders, [], "tracked text must be normalized in the index")

    def test_every_tracked_text_path_resolves_to_lf(self) -> None:
        entries = _entries()
        output = subprocess.check_output(
            ["git", "check-attr", "-z", "text", "eol", "--stdin"],
            cwd=ROOT,
            input=b"\0".join(os.fsencode(path) for path, _ in entries) + b"\0",
        )
        fields = output.split(b"\0")[:-1]
        self.assertEqual(len(fields), len(entries) * 6)
        attributes: dict[str, dict[str, str]] = {}
        for offset in range(0, len(fields), 3):
            path, attribute, value = fields[offset : offset + 3]
            attributes.setdefault(os.fsdecode(path), {})[attribute.decode("ascii")] = value.decode(
                "ascii"
            )
        offenders = [
            path
            for path, indexed in entries
            if indexed != "i/-text"
            and attributes[path]["text"] != "unset"
            and path not in INTENTIONAL_NON_LF
            and attributes[path]["eol"] != "lf"
        ]
        self.assertEqual(offenders, [], "effective Git attributes must enforce LF for text")


class BomCensusTests(unittest.TestCase):
    def test_index_truth_binary_and_untracked_boundaries(self) -> None:
        (ROOT / ".tmp").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".tmp", prefix="bom-census-") as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet", "--template="], cwd=root, check=True)
            (root / ".gitattributes").write_bytes(b"* text=auto eol=lf\n*.bin -text\n")
            name = "odd name caf\u00e9.txt" + ("\nmore" if os.name != "nt" else "")
            tracked = root / name
            tracked.write_bytes(b"\xef\xbb\xbfsynthetic\n")
            (root / "binary.bin").write_bytes(b"\xef\xbb\xbf\0binary")
            (root / "empty.txt").write_bytes(b"")
            (root / "short.txt").write_bytes(b"\xef\xbb")
            subprocess.run(["git", "add", "--", "."], cwd=root, check=True)
            tracked.write_bytes(b"clean checkout\n")
            (root / "untracked.txt").write_bytes(b"\xef\xbb\xbfuntracked\n")
            self.assertEqual(_bom_paths(root, {}), [name])
            self.assertEqual(_bom_paths(root, {name: "synthetic byte-level consumer"}), [])
            with self.assertRaisesRegex(AssertionError, "byte-level consumer"):
                _bom_paths(root, {name: "   "})
            subprocess.run(["git", "add", "--", name], cwd=root, check=True)
            tracked.write_bytes(b"\xef\xbb\xbfdirty checkout\n")
            self.assertEqual(_bom_paths(root, {}), [])


if __name__ == "__main__":
    unittest.main()
