"""Offline frozen-lock frontend rebuild and shipped-runtime parity contracts."""

from __future__ import annotations

import base64
import hashlib
import importlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def _mask_packaged_font_payloads(bundle: bytes) -> bytes:
    manifest = json.loads((ROOT / "comfyui_h3_context/fonts/font_manifest_v1.json").read_bytes())
    latin = next(
        row for row in manifest["font_assets"] if row["font_asset_id"] == "h3.font.noto_sans.v1"
    )
    matches = list(re.finditer(rb"data:font/(?:ttf|sfnt);base64,([A-Za-z0-9+/=]+)", bundle))
    spans: list[tuple[int, int]] = []
    for weight, name in ((400, "Regular"), (700, "Bold")):
        faces = [
            face
            for face in latin["faces"]
            if face["weight"] == weight and face["style"] == "normal"
        ]
        assert len(faces) == 1, "expected one manifest-pinned normal font face"
        face = faces[0]
        assert face["package_path"] == f"fonts/NotoSans-{name}.ttf"
        body = (ROOT / "comfyui_h3_context" / face["package_path"]).read_bytes()
        assert len(body) == face["size_bytes"]
        assert "sha256:" + hashlib.sha256(body).hexdigest() == face["file_sha256"]
        payload = base64.b64encode(body)
        exact = [match.span(1) for match in matches if match.group(1) == payload]
        assert len(exact) == 1, "expected font payload exactly once"
        spans.extend(exact)
    assert len(set(spans)) == 2
    # CRITICAL: exempt only complete, byte-identical manifest-pinned font payloads;
    # masking arbitrary base64 would hide secrets in other bundle bytes.
    for start, end in sorted(spans, reverse=True):
        bundle = bundle[:start] + b"<packaged-font-payload>" + bundle[end:]
    return bundle


def _scanner_canary() -> bytes:
    return b"pass" + b"word" + b' = "' + b"r7mV2q9" + b'X8pL6wZ4";\n'


class FrontendBuildReportTests(unittest.TestCase):
    @staticmethod
    def _make_directory_link(link: Path, target: Path) -> None:
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError:
            if os.name != "nt":
                raise
            result = subprocess.run(
                [os.environ["COMSPEC"], "/d", "/c", "mklink", "/J", str(link), str(target)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
                check=False,
                timeout=5,
            )
            if result.returncode != 0:
                raise OSError("could not create Windows junction fixture") from None

    @staticmethod
    def _remove_directory_link(link: Path) -> None:
        link.unlink() if link.is_symlink() else link.rmdir()

    @staticmethod
    def _write_minimal_frontend(root: Path) -> None:
        (root / "src").mkdir(parents=True)
        (root / "src" / "entry.ts").write_text("export {};\n", encoding="utf-8")
        (root / "package.json").write_text('{"packageManager":"pnpm@11.3.0"}\n', encoding="utf-8")
        for name in (
            "buildMetadata.ts",
            "buildProvenance.ts",
            "pnpm-lock.yaml",
            "tsconfig.json",
            "vite.config.ts",
        ):
            (root / name).write_text("# fixture\n", encoding="utf-8")

    def test_output_root_rejects_link_or_reparse_ancestor(self) -> None:
        module = importlib.import_module("scripts.frontend_build_report")
        (ROOT / ".tmp").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="h3-frontend-link-", dir=ROOT / ".tmp"
        ) as temporary:
            base = Path(temporary)
            target = base / "target"
            target.mkdir()
            link = base / "link"
            self._make_directory_link(link, target)
            try:
                with (
                    patch.object(module.shutil, "which", return_value=None),
                    self.assertRaisesRegex(module.FrontendBuildError, "link|reparse"),
                ):
                    module.run_frontend_build_report(link / "output")
            finally:
                self._remove_directory_link(link)

    def test_source_inventory_rejects_nested_link_or_reparse_directory(self) -> None:
        module = importlib.import_module("scripts.frontend_build_report")
        (ROOT / ".tmp").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="h3-frontend-source-link-", dir=ROOT / ".tmp"
        ) as temporary:
            base = Path(temporary)
            frontend = base / "frontend"
            self._write_minimal_frontend(frontend)
            target = base / "foreign-source"
            target.mkdir()
            (target / "foreign.ts").write_text("export {};\n", encoding="utf-8")
            link = frontend / "src" / "linked-input"
            self._make_directory_link(link, target)
            try:
                with (
                    patch.object(module, "FRONTEND_ROOT", frontend),
                    patch.object(module.shutil, "which", return_value=None),
                    self.assertRaisesRegex(module.FrontendBuildError, "link|reparse"),
                ):
                    module.run_frontend_build_report(base / "output")
            finally:
                self._remove_directory_link(link)

    def test_fixed_input_leaves_reject_link_or_reparse_entries(self) -> None:
        module = importlib.import_module("scripts.frontend_build_report")
        (ROOT / ".tmp").mkdir(exist_ok=True)
        names = (
            "buildMetadata.ts",
            "buildProvenance.ts",
            "package.json",
            "pnpm-lock.yaml",
            "tsconfig.json",
            "vite.config.ts",
        )
        for name in names:
            with (
                self.subTest(name=name),
                tempfile.TemporaryDirectory(
                    prefix="h3-frontend-leaf-link-", dir=ROOT / ".tmp"
                ) as temporary,
            ):
                base = Path(temporary)
                frontend = base / "frontend"
                self._write_minimal_frontend(frontend)
                leaf = frontend / name
                leaf.unlink()
                target = base / "foreign-leaf"
                target.mkdir()
                link = leaf
                self._make_directory_link(link, target)
                try:
                    with (
                        patch.object(module, "FRONTEND_ROOT", frontend),
                        patch.object(module.shutil, "which", return_value=None),
                        self.assertRaisesRegex(module.FrontendBuildError, "link|reparse"),
                    ):
                        module.run_frontend_build_report(base / "output")
                finally:
                    self._remove_directory_link(link)

    def test_source_inventory_enforces_entry_and_byte_bounds(self) -> None:
        module = importlib.import_module("scripts.frontend_build_report")
        (ROOT / ".tmp").mkdir(exist_ok=True)
        cases = (
            ("MAX_FRONTEND_INPUT_ENTRIES", 4, "entry bound"),
            ("MAX_FRONTEND_INPUT_FILE_BYTES", 8, "unsafe|bound"),
            ("MAX_FRONTEND_INPUT_TOTAL_BYTES", 8, "byte bound"),
        )
        for constant, value, message in cases:
            with (
                self.subTest(constant=constant),
                tempfile.TemporaryDirectory(
                    prefix="h3-frontend-input-bound-", dir=ROOT / ".tmp"
                ) as temporary,
            ):
                base = Path(temporary)
                frontend = base / "frontend"
                self._write_minimal_frontend(frontend)
                with (
                    patch.object(module, "FRONTEND_ROOT", frontend),
                    patch.object(module, constant, value),
                    patch.object(module.shutil, "which", return_value=None),
                    self.assertRaisesRegex(module.FrontendBuildError, message),
                ):
                    module.run_frontend_build_report(base / "output")

    def test_offline_frozen_rebuild_matches_the_only_runtime_entry(self) -> None:
        if shutil.which("pnpm") is None:
            self.skipTest("frontend frozen rebuild runs in the frontend toolchain lane")
        module = importlib.import_module("scripts.frontend_build_report")
        (ROOT / ".tmp").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="h3-frontend-build-", dir=ROOT / ".tmp"
        ) as temporary:
            report = module.run_frontend_build_report(Path(temporary))
        self.assertEqual(report["schema"], "h3-context-frontend-build/1")
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["package_manager"], "pnpm@11.3.0")
        self.assertEqual(
            report["lock_validation_flags"],
            ["--offline", "--frozen-lockfile", "--ignore-scripts", "--lockfile-only"],
        )
        self.assertEqual(report["dependency_source"], "existing_frozen_node_modules")
        self.assertEqual(report["lock_validation"], "offline_frozen_lockfile_only")
        self.assertTrue(report["lockfile_unchanged"])
        self.assertTrue(report["validation_copy_normalized"])
        self.assertTrue(report["bundle_parity"])
        self.assertGreater(report["bundle_bytes"], 0)
        self.assertNotIn("bundle_byte_budget", report)
        self.assertFalse(report["bare_module_specifiers"])
        self.assertFalse(report["build_path_markers"])
        self.assertFalse(report["cdn_dependencies"])
        self.assertEqual(report["lifecycle_registration_count"], 1)
        self.assertTrue(report["cleanup_verified"])
        self.assertEqual(report["runtime_entries"], ["h3-context-sidebar.js"])
        self.assertEqual(report["source_maps"], [])
        self.assertEqual(report["network"], "disabled")
        self.assertEqual(
            report["bundle_sha256"],
            hashlib.sha256(
                (ROOT / "comfyui_h3_context" / "web" / "h3-context-sidebar.js").read_bytes()
            ).hexdigest(),
        )

    def test_module_boundary_uses_syntax_not_property_or_literal_text(self) -> None:
        module = importlib.import_module("scripts.frontend_build_report")
        for source in (
            'const g={from:1}; const v={"from":g.from,"to":2};',
            "const text=\"import x from 'bare'\";",
            '// import x from "bare"\nconst x=1;',
            'const pattern=/import x from "bare"/;',
            'const text=`import x from "bare"`;',
            'const text="import(\\"bare\\")";',
            'import {x} from "./local.js";',
            'export {x} from "../local.js";',
        ):
            with self.subTest(source=source):
                self.assertFalse(module._module_dependency_boundary(source))

    def test_module_boundary_refuses_all_external_static_and_dynamic_requests(self) -> None:
        module = importlib.import_module("scripts.frontend_build_report")
        for source in (
            'import {x} from "bare";',
            'import "bare";',
            'export * from "bare";',
            'export {x} from "b\\u0061re";',
            'import "b\\u0061re";',
            'async function load(){return import ("./local.js");}',
            "function load(value){return import(value);}",
            'const text=`value ${import("bare")}`;',
        ):
            with self.subTest(source=source):
                self.assertTrue(module._module_dependency_boundary(source))

    def test_module_boundary_refuses_invalid_syntax_and_missing_toolchain(self) -> None:
        module = importlib.import_module("scripts.frontend_build_report")
        with self.assertRaises(module.FrontendBuildError):
            module._module_dependency_boundary("const x=;")
        with (
            patch.object(module.shutil, "which", return_value=None),
            self.assertRaises(module.FrontendBuildError),
        ):
            module._module_dependency_boundary("const x=1;")

    def test_module_boundary_refuses_parser_failure_and_invalid_response(self) -> None:
        module = importlib.import_module("scripts.frontend_build_report")
        responses = (
            subprocess.CompletedProcess(["node"], 2, "", "parser detail"),
            subprocess.CompletedProcess(["node"], 0, "{broken", ""),
            subprocess.CompletedProcess(["node"], 0, '{"bare":0,"dynamic":false}', ""),
            subprocess.CompletedProcess(["node"], 0, '{"bare":false}', ""),
            subprocess.CompletedProcess(["node"], 0, "[]", ""),
        )
        for response in responses:
            with (
                self.subTest(response=response.stdout),
                patch.object(module.subprocess, "run", return_value=response),
                self.assertRaises(module.FrontendBuildError),
            ):
                module._module_dependency_boundary("const x=1;")
        with (
            patch.object(
                module.subprocess, "run", side_effect=subprocess.TimeoutExpired("node", 30)
            ),
            self.assertRaises(module.FrontendBuildError),
        ):
            module._module_dependency_boundary("const x=1;")

    def test_scanner_mask_exempts_only_exact_manifest_pinned_font_payloads(self) -> None:
        bundle = (ROOT / "comfyui_h3_context/web/h3-context-sidebar.js").read_bytes()
        payloads = [
            base64.b64encode((ROOT / f"comfyui_h3_context/fonts/NotoSans-{face}.ttf").read_bytes())
            for face in ("Regular", "Bold")
        ]
        foreign = b'\n"data:font/ttf;base64,' + payloads[0] + b'AAAA";\n'
        expected = bundle
        for payload in payloads:
            self.assertEqual(bundle.count(payload), 1)
            expected = expected.replace(payload, b"<packaged-font-payload>")
        self.assertEqual(_mask_packaged_font_payloads(bundle + foreign), expected + foreign)
        changed = (b"A" if payloads[0][:1] != b"A" else b"B") + payloads[0][1:]
        for invalid in (
            bundle.replace(payloads[0], changed, 1),
            bundle + b'\n"data:font/ttf;base64,' + payloads[0] + b'";\n',
        ):
            with (
                self.subTest(invalid_bytes=len(invalid)),
                self.assertRaisesRegex(AssertionError, "expected font payload exactly once"),
            ):
                _mask_packaged_font_payloads(invalid)

    def test_shipped_runtime_passes_the_secret_scanner(self) -> None:
        bundle = ROOT / "comfyui_h3_context" / "web" / "h3-context-sidebar.js"
        masked = _mask_packaged_font_payloads(bundle.read_bytes())
        (ROOT / ".tmp").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="h3-scanner-", dir=ROOT / ".tmp") as temporary:
            directory = Path(temporary)
            (directory / "bundle.js").write_bytes(masked)
            (directory / "canary.js").write_bytes(_scanner_canary())
            # CRITICAL: copies are untracked; all-files plus the same-call canary
            # prevents an ignored empty scan from passing as a clean bundle.
            completed = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "detect_secrets",
                    "scan",
                    # No candidate goes to a verification service; the result is equal without it.
                    "--no-verify",
                    "--all-files",
                    "bundle.js",
                    "canary.js",
                ],
                cwd=directory,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="strict",
                shell=False,
                check=False,
                # IMPORTANT: a hang guard, not a speed budget. The scan of the masked shipped
                # bundle (3.9 MB, twice its 1.4.1 size) takes 13 s under WSL, 19-20 s on Windows
                # and more than 30 s on a Hosted runner, where 30 s killed a scan still running.
                timeout=180,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        scan = json.loads(completed.stdout)
        results = scan["results"]
        self.assertTrue(results.get("canary.js"), "scanner positive control missing")
        self.assertTrue(any(row["type"] == "Secret Keyword" for row in results["canary.js"]))
        self.assertEqual(
            results.get("bundle.js", []), [], "non-font bundle bytes contain a finding"
        )
        self.assertEqual(set(results), {"canary.js"})


if __name__ == "__main__":
    unittest.main()
