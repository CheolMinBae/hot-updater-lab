#!/usr/bin/env python3
"""Install a release APK and exercise the real Hot Updater SDK via Android UI.

No Metro, server mutation, bundle injection, or app-data manipulation is used to
apply the update. Reuse an APK built before the OTA when passing an expected label.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


PACKAGE = "net.prostacks.otademo"
ARTIFACTS = Path(__file__).resolve().parent / "artifacts"
SERIAL = os.environ.get("ANDROID_SERIAL") or f"emulator-{os.environ.get('EMULATOR_PORT', '5554')}"


def adb(*args, timeout=40, binary=False):
    result = subprocess.run(
        ["adb", "-s", SERIAL, *args], check=True, capture_output=True, timeout=timeout
    )
    return result.stdout if binary else result.stdout.decode("utf-8", errors="replace")


def hierarchy():
    adb("shell", "uiautomator", "dump", "/sdcard/ota-demo-e2e.xml", timeout=20)
    data = adb("exec-out", "cat", "/sdcard/ota-demo-e2e.xml")
    data = data[data.index("<hierarchy"):]
    (ARTIFACTS / "latest-ui.xml").write_text(data)
    return ET.fromstring(data)


def matching_nodes(root, test_id, fallback_text):
    identified = []
    for node in root.iter("node"):
        resource = node.get("resource-id", "")
        if resource == test_id or resource.endswith(f":id/{test_id}"):
            identified.append(node)
    if identified:
        yield from identified
        return
    if fallback_text is None:
        return
    for node in root.iter("node"):
        if node.get("text") == fallback_text or node.get("content-desc") == fallback_text:
            yield node


def has_text(root, test_id, expected):
    return any(
        expected in (child.get("text"), child.get("content-desc"))
        for node in matching_nodes(root, test_id, expected)
        for child in node.iter()
    )


def release_label(root):
    return next(
        (value.strip()
         for node in matching_nodes(root, "release-label", None)
         for child in node.iter()
         for value in (child.get("text", ""), child.get("content-desc", ""))
         if value.strip()),
        None,
    )


def assert_no_anr(root):
    for node in root.iter("node"):
        text = node.get("text", "")
        if "isn't responding" in text or "isn’t responding" in text or "is not responding" in text:
            raise AssertionError(f"Android ANR dialog blocks the test: {text}")


def scroll(direction):
    size = re.findall(r"(\d+)x(\d+)", adb("shell", "wm", "size"))[-1]
    width, height = map(int, size)
    start, end = (0.8, 0.3) if direction == "down" else (0.3, 0.8)
    adb("shell", "input", "swipe", str(width // 2), str(int(height * start)),
        str(width // 2), str(int(height * end)), "250")


def wait_for(description, predicate, timeout=90):
    deadline = time.monotonic() + timeout
    attempts = 0
    last_problem = "No UI hierarchy received"
    while time.monotonic() < deadline:
        try:
            root = hierarchy()
            assert_no_anr(root)
            value = predicate(root)
            if value:
                return value
            texts = [node.get("text", "") for node in root.iter("node") if node.get("text")]
            last_problem = " | ".join(texts)
            if any(text.startswith("Error:") for text in texts):
                raise AssertionError(f"App reported an error: {last_problem}")
        except (subprocess.SubprocessError, ET.ParseError, ValueError) as error:
            last_problem = str(error)
        attempts += 1
        if attempts % 3 == 0:
            # Test controls can extend below the fold on smaller Android screens.
            scroll("down" if attempts % 12 < 6 else "up")
        time.sleep(1)
    raise AssertionError(f"Timed out waiting for {description}: {last_problem}")


def tap(test_id, text):
    def enabled_button(root):
        for node in matching_nodes(root, test_id, text):
            if node.get("enabled") != "true":
                continue
            bounds = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
            if bounds:
                left, top, right, bottom = map(int, bounds.groups())
                if right > left and bottom > top:
                    return ((left + right) // 2, (top + bottom) // 2)
        return None

    x, y = wait_for(f"enabled {text} button", enabled_button)
    adb("shell", "input", "tap", str(x), str(y))


def capture(name):
    (ARTIFACTS / f"{name}.png").write_bytes(adb("exec-out", "screencap", "-p", binary=True))
    try:
        root = hierarchy()
        ET.ElementTree(root).write(ARTIFACTS / f"{name}.xml", encoding="utf-8", xml_declaration=True)
    except (subprocess.SubprocessError, ET.ParseError, ValueError):
        pass


def launch():
    adb("shell", "am", "start", "-W", "-n", f"{PACKAGE}/.MainActivity")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apk", required=True, type=Path)
    parser.add_argument("--baseline-label", default="", help="Assert this initial label; omitted detects the APK's label")
    parser.add_argument("--expected-ota-label", default="")
    parser.add_argument("--boot-settle-seconds", type=int, default=0, help="Wait for fresh-emulator provisioning before installing the app")
    args = parser.parse_args()
    if not 0 <= args.boot_settle_seconds <= 120:
        parser.error("--boot-settle-seconds must be between 0 and 120")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    result = {
        "package": PACKAGE,
        "serial": SERIAL,
        "apk_sha256": hashlib.sha256(args.apk.read_bytes()).hexdigest(),
        "baseline_label": None,
        "expected_baseline_label": args.baseline_label or None,
        "expected_ota_label": args.expected_ota_label or None,
        "passed": False,
        "phase": "emulator-ready",
    }
    try:
        adb("wait-for-device", timeout=120)
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "wm", "dismiss-keyguard")
        time.sleep(args.boot_settle_seconds)
        capture("00-emulator-ready")
        assert_no_anr(hierarchy())
        result["phase"] = "install"
        adb("install", "-r", str(args.apk.resolve()), timeout=120)
        adb("shell", "pm", "clear", PACKAGE)
        adb("logcat", "-c")
        launch()
        result["phase"] = "baseline"
        initial_label = wait_for("nonempty embedded release label", release_label)
        result["baseline_label"] = initial_label
        if args.baseline_label and initial_label != args.baseline_label:
            raise AssertionError(f"Expected baseline {args.baseline_label!r}, observed {initial_label!r}")
        if args.expected_ota_label and args.expected_ota_label == initial_label:
            raise AssertionError("Expected OTA label is already present in the embedded APK")
        capture("01-baseline")

        result["phase"] = "check"
        tap("check-update", "Check for update")
        status = wait_for(
            "SDK update-check result",
            lambda root: next((status for status in ("Update available", "No update available")
                               if has_text(root, "status-message", status)), None),
        )
        result["check_status"] = status
        capture("02-checked")

        if args.expected_ota_label:
            if status != "Update available":
                raise AssertionError("Expected an OTA, but the SDK reported no eligible update")
            result["phase"] = "download"
            tap("download-update", "Download update")
            wait_for("SDK download completion", lambda root: has_text(root, "status-message", "Update downloaded"), timeout=180)
            capture("03-downloaded")
            result["phase"] = "apply"
            tap("apply-update", "Apply and restart")
            wait_for("OTA label after SDK reload", lambda root: has_text(root, "release-label", args.expected_ota_label), timeout=120)
            capture("04-applied")
            # HotUpdater.init acknowledges a successful native frame asynchronously.
            time.sleep(3)
            result["phase"] = "persistence"
            # This restart only tests persistence after SDK-driven application succeeds.
            adb("shell", "am", "force-stop", PACKAGE)
            launch()
            wait_for("OTA label after a second launch", lambda root: has_text(root, "release-label", args.expected_ota_label))
            capture("05-relaunched")

        result["phase"] = "complete"
        result["passed"] = True
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        for name, collect in (
            ("final screenshot", lambda: capture("99-final")),
            ("logcat", lambda: (ARTIFACTS / "logcat.txt").write_text(adb("logcat", "-d", "-v", "threadtime"))),
        ):
            try:
                collect()
            except Exception as error:
                print(f"Could not capture {name}: {error}", file=sys.stderr)
        (ARTIFACTS / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
