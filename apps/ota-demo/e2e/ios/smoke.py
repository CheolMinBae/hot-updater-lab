#!/usr/bin/env python3
"""Exercise the real Hot Updater SDK in an installed Release simulator app.

A dedicated simulator starts with clean app data. The app's controls perform
update selection, downloading and application; this runner never injects a
bundle or modifies Hot Updater's on-device state.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import subprocess
import time


APP_ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = APP_ROOT / "e2e" / "artifacts" / "ios"
BUNDLE_ID = "net.prostacks.otademo"


def run(*args, timeout=120, check=True, env=None):
    try:
        completed = subprocess.run(args, cwd=APP_ROOT, check=check, timeout=timeout,
                                   capture_output=True, text=True, env=env)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print_command_failure(args, error.stdout, error.stderr)
        raise
    if completed.returncode:
        print_command_failure(args, completed.stdout, completed.stderr)
    return completed


def print_command_failure(args, stdout, stderr):
    print(f"[ios-smoke] Failed command: {shlex.join(args)}", flush=True)
    for name, output in (("stdout", stdout), ("stderr", stderr)):
        if output:
            if isinstance(output, bytes):
                output = output.decode("utf-8", errors="replace")
            print(f"[ios-smoke] {name}:\n{output[-8000:]}", flush=True)


def phase(result, name):
    result["phase"] = name
    print(f"[ios-smoke] {name}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--baseline-label", default="")
    parser.add_argument("--expected-ota-label", default="")
    args = parser.parse_args()
    app_path = args.app.resolve()
    with (app_path / "Info.plist").open("rb") as source:
        info = plistlib.load(source)
    if info.get("CFBundleIdentifier") != BUNDLE_ID:
        parser.error(f"Expected {BUNDLE_ID}; received {info.get('CFBundleIdentifier')}")
    if "iPhoneSimulator" not in info.get("CFBundleSupportedPlatforms", []):
        parser.error("Provide an iOS simulator .app, not an iPhone device build")

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    build_path = APP_ROOT / "build" / "ios-e2e"
    result_path = ARTIFACTS / f"SDKSmoke-{int(time.time())}.xcresult"
    environment = os.environ.copy()
    environment.update(EXPECTED_BASELINE_LABEL=args.baseline_label,
                       EXPECTED_OTA_LABEL=args.expected_ota_label)
    runtimes = json.loads(run("xcrun", "simctl", "list", "runtimes", "--json").stdout)["runtimes"]
    available = [runtime for runtime in runtimes
                 if runtime.get("isAvailable") and ".iOS-" in runtime["identifier"]]
    requested = os.environ.get("IOS_SIMULATOR_RUNTIME")
    if requested:
        runtime = next((item for item in available if item["identifier"] == requested), None)
        if runtime is None:
            raise SystemExit(f"Requested simulator runtime is unavailable: {requested}")
    else:
        sdk_version = tuple(map(int, run("xcrun", "--sdk", "iphonesimulator", "--show-sdk-version").stdout.strip().split(".")))
        compatible = [item for item in available
                      if tuple(map(int, item["version"].split("."))) <= sdk_version]
        if not compatible:
            raise SystemExit("Install an iOS simulator runtime supported by the selected Xcode")
        runtime = max(compatible, key=lambda item: tuple(map(int, item["version"].split("."))))

    device = run("xcrun", "simctl", "create", "OTA Demo SDK smoke",
                 "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro-Max",
                 runtime["identifier"]).stdout.strip()
    result = {
        "bundle_id": BUNDLE_ID,
        "simulator_udid": device,
        "runtime": runtime["identifier"],
        "app_executable_sha256": hashlib.sha256((app_path / info["CFBundleExecutable"]).read_bytes()).hexdigest(),
        "expected_baseline_label": args.baseline_label or None,
        "expected_ota_label": args.expected_ota_label or None,
        "xcresult": result_path.name,
        "passed": False,
        "phase": "boot",
    }
    try:
        phase(result, "boot")
        run("xcrun", "simctl", "boot", device)
        run("xcrun", "simctl", "bootstatus", device, "-b", timeout=240)
        run("xcrun", "simctl", "status_bar", device, "override", "--time", "9:41",
            "--batteryState", "charged", "--batteryLevel", "100", check=False)
        phase(result, "install")
        run("xcrun", "simctl", "install", device, str(app_path))
        phase(result, "generate-xctest")
        run("bundle", "exec", "ruby", "e2e/ios/generate_project.rb", str(build_path), env=environment)
        phase(result, "sdk-ui-test")
        command = [
            "xcodebuild", "test", "-project", str(build_path / "SDKSmoke.xcodeproj"),
            "-scheme", "SDKSmoke", "-configuration", "Release",
            "-destination", f"platform=iOS Simulator,id={device}",
            "-derivedDataPath", str(build_path / "DerivedData"),
            "-resultBundlePath", str(result_path),
            "-parallel-testing-enabled", "NO", "-maximum-concurrent-test-simulator-destinations", "1",
            "CODE_SIGNING_ALLOWED=NO",
        ]
        # Keep verbose Xcode output in the evidence artifact, not in the Actions log.
        try:
            with (ARTIFACTS / "xcodebuild-test.log").open("w") as log:
                completed = subprocess.run(command, cwd=APP_ROOT, env=environment,
                                           stdout=log, stderr=subprocess.STDOUT, timeout=1200)
        except subprocess.TimeoutExpired:
            print((ARTIFACTS / "xcodebuild-test.log").read_text()[-18000:], flush=True)
            raise
        if completed.returncode:
            print((ARTIFACTS / "xcodebuild-test.log").read_text()[-18000:], flush=True)
            raise RuntimeError(f"SDK XCTest failed with exit code {completed.returncode}")
        result["phase"] = "complete"
        result["passed"] = True
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        print("[ios-smoke] collect-evidence", flush=True)
        for command in (
            ["xcrun", "simctl", "io", device, "screenshot", str(ARTIFACTS / "final.png")],
            ["xcrun", "xcresulttool", "export", "attachments", "--path", str(result_path),
             "--output-path", str(ARTIFACTS / "attachments")],
        ):
            try:
                collected = run(*command, check=False)
                if collected.returncode:
                    print(f"Evidence export: {collected.stderr.strip()}", flush=True)
            except subprocess.SubprocessError as error:
                print(f"Evidence export failed: {error}", flush=True)
        try:
            logs = run("xcrun", "simctl", "spawn", device, "log", "show", "--style", "compact",
                       "--last", "20m", "--predicate", 'process == "OtaDemo"', check=False)
            (ARTIFACTS / "simulator.log").write_text(logs.stdout + logs.stderr)
        except subprocess.SubprocessError as error:
            print(f"Simulator log export failed: {error}", flush=True)
        (ARTIFACTS / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2), flush=True)
        run("xcrun", "simctl", "shutdown", device, check=False)
        run("xcrun", "simctl", "delete", device, check=False)
        if result["passed"]:
            print("[ios-smoke] complete", flush=True)


if __name__ == "__main__":
    main()
