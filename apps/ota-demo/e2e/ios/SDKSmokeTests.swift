import XCTest

final class SDKSmokeTests: XCTestCase {
  private let app = XCUIApplication(bundleIdentifier: "net.prostacks.otademo")
  private var result: [String: Any] = ["passed": false, "phase": "launch"]

  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  override func tearDownWithError() throws {
    capture("99-final")
    let json = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    let attachment = XCTAttachment(data: json, uniformTypeIdentifier: "public.json")
    attachment.name = "sdk-smoke-result.json"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func element(_ identifier: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  private func capture(_ name: String) {
    let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    screenshot.name = name
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let hierarchy = XCTAttachment(string: app.debugDescription)
    hierarchy.name = "\(name)-accessibility"
    hierarchy.lifetime = .keepAlways
    add(hierarchy)
  }

  @discardableResult
  private func waitForLabel(_ identifier: String, oneOf labels: [String] = [], timeout: TimeInterval = 90) -> String {
    let target = element(identifier)
    let predicate = NSPredicate { _, _ in
      guard target.exists else { return false }
      let value = target.label.trimmingCharacters(in: .whitespacesAndNewlines)
      return !value.isEmpty && (labels.isEmpty || labels.contains(value))
    }
    let expectation = XCTNSPredicateExpectation(predicate: predicate, object: nil)
    XCTAssertEqual(
      XCTWaiter.wait(for: [expectation], timeout: timeout), .completed,
      "Timed out waiting for \(identifier) \(labels). UI: \(app.debugDescription)"
    )
    return target.label
  }

  private func tap(_ identifier: String) {
    let target = element(identifier)
    XCTAssertTrue(target.waitForExistence(timeout: 30), "Missing \(identifier)")
    for _ in 0..<6 where !target.isHittable {
      app.swipeUp()
    }
    XCTAssertTrue(target.isHittable, "Control \(identifier) is not visible")
    XCTAssertTrue(target.isEnabled, "Control \(identifier) is disabled")
    target.tap()
  }

  func testSDKUpdateAndPersistence() throws {
    let expectedBaseline = ProcessInfo.processInfo.environment["EXPECTED_BASELINE_LABEL"] ?? ""
    let expectedOTA = ProcessInfo.processInfo.environment["EXPECTED_OTA_LABEL"] ?? ""
    result["expected_baseline_label"] = expectedBaseline
    result["expected_ota_label"] = expectedOTA
    app.launch()

    result["phase"] = "baseline"
    let initialLabel = waitForLabel("release-label")
    result["baseline_label"] = initialLabel
    if !expectedBaseline.isEmpty {
      XCTAssertEqual(initialLabel, expectedBaseline)
    }
    if !expectedOTA.isEmpty {
      XCTAssertNotEqual(initialLabel, expectedOTA, "Expected OTA is already embedded in this native app")
    }
    capture("01-baseline")

    result["phase"] = "check"
    tap("check-update")
    let status = waitForLabel("status-message", oneOf: ["Update available", "No update available"])
    result["check_status"] = status
    capture("02-checked")

    if !expectedOTA.isEmpty {
      XCTAssertEqual(status, "Update available", "The real SDK did not find an eligible OTA")
      result["phase"] = "download"
      tap("download-update")
      waitForLabel("status-message", oneOf: ["Update downloaded"], timeout: 180)
      capture("03-downloaded")

      result["phase"] = "apply"
      tap("apply-update")
      waitForLabel("release-label", oneOf: [expectedOTA], timeout: 120)
      capture("04-applied")

      // HotUpdater.init acknowledges the first successful native frame. This
      // second launch verifies persistence after the SDK has applied the OTA.
      Thread.sleep(forTimeInterval: 3)
      result["phase"] = "persistence"
      app.terminate()
      app.launch()
      waitForLabel("release-label", oneOf: [expectedOTA])
      capture("05-relaunched")
    }

    result["phase"] = "complete"
    result["passed"] = true
  }
}
