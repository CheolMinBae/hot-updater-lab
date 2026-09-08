import "dotenv/config";
import { s3Database } from "@hot-updater/aws";
import type { AppUpdateInfo } from "@hot-updater/core";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { BASE_PATH, databaseConfig, HOT_UPDATER_VERSION } from "../src/config.js";

const baseUrl = new URL(process.env.OTA_BASE_URL || "https://ota.prostacks.net");
assert.equal(baseUrl.protocol, "https:", "OTA_BASE_URL must use HTTPS");
const platform = "android";
const channel = "lab";
const appVersion = "1.0.0";
// A valid UUIDv7 before all fixtures, modelling the original native app bundle.
const initialBundleId = "00000000-0000-7000-8000-000000000000";
const database = s3Database(databaseConfig)();

async function request(pathname: string) {
  return fetch(new URL(pathname, baseUrl), {
    headers: { "Hot-Updater-SDK-Version": HOT_UPDATER_VERSION },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
}

async function updateCheck({
  version = appVersion,
  updateChannel = channel,
  currentBundleId = initialBundleId,
}: { version?: string; updateChannel?: string; currentBundleId?: string } = {}) {
  const segments = [platform, version, updateChannel, initialBundleId, currentBundleId];
  const response = await request(`${BASE_PATH}/app-version/${segments.map(encodeURIComponent).join("/")}`);
  assert.equal(response.status, 200, "OTA update check must succeed");
  return await response.json() as AppUpdateInfo;
}

async function localFixtureId() {
  try {
    const fixture = JSON.parse(await readFile("work/latest-fixture.json", "utf8"));
    assert.equal(fixture.kind, "hot-updater-transport-fixture");
    assert.equal(fixture.platform, platform);
    assert.equal(typeof fixture.bundleId, "string");
    return fixture.bundleId as string;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

try {
  const ownFixtureId = await localFixtureId();
  const latest = (await database.getBundles({
    where: { platform, channel, enabled: true, targetAppVersion: appVersion },
    orderBy: { field: "id", direction: "desc" },
    limit: 100,
  })).data[0];
  assert(latest, "No enabled Android/lab/1.0.0 bundle exists; deploy the fixture first");
  assert.match(latest.message || "", /transport fixture/i, "Refusing to test an unrelated deployment");
  const expectedId = process.env.OTA_EXPECTED_BUNDLE_ID || ownFixtureId || latest.id;
  assert.equal(latest.id, expectedId, "Expected fixture must be the newest enabled matching bundle");

  const update = await updateCheck();
  assert.equal(update.status, "UPDATE");
  assert.equal(update.id, expectedId);
  assert.equal(update.fileHash, latest.fileHash, "API hash must match deployment metadata");
  assert.match(latest.fileHash, /^[0-9a-f]{64}$/i, "This unsigned fixture uses a SHA-256 hex hash");
  assert(update.fileUrl, "API must return a bundle download URL");
  assert.equal(new URL(update.fileUrl).protocol, "https:");
  const download = await fetch(update.fileUrl, { signal: AbortSignal.timeout(30_000) });
  assert.equal(download.status, 200, "Actual archive download must succeed");
  const archive = Buffer.from(await download.arrayBuffer());
  assert(archive.length > 0, "Downloaded bundle must not be empty");
  const downloadedHash = createHash("sha256").update(archive).digest("hex");
  assert.equal(downloadedHash, latest.fileHash, "Downloaded archive SHA-256 must match metadata");

  assert.equal((await updateCheck({ currentBundleId: expectedId })).status, "UP_TO_DATE");
  assert.equal((await updateCheck({ updateChannel: `absent-${expectedId}` })).status, "UP_TO_DATE");
  assert.equal((await updateCheck({ version: "9999.0.0" })).status, "UP_TO_DATE");
  const anonymousConsole = await request("/");
  assert.equal(anonymousConsole.status, 401, "Console must require authentication");
  assert.equal((await request(`${BASE_PATH}/api/bundles`)).status, 404, "Public OTA API must not expose bundle management");

  let rollbackVerified = false;
  if (process.argv.includes("--rollback")) {
    // Never disable an inferred or unrelated bundle. Only the exact fixture
    // just built in this checkout is eligible, and always restore its flag.
    assert.equal(expectedId, ownFixtureId, "Rollback requires this checkout's latest-fixture.json");
    try {
      await database.updateBundle(expectedId, { enabled: false });
      await database.commitBundle();
      const rollback = await updateCheck({ currentBundleId: expectedId });
      assert.equal(rollback.status, "ROLLBACK");
      assert.notEqual(rollback.id, expectedId);
      rollbackVerified = true;
    } finally {
      await database.updateBundle(expectedId, { enabled: latest.enabled });
      await database.commitBundle();
    }
    const restored = await updateCheck();
    assert(restored.status !== "UP_TO_DATE");
    assert.equal(restored.id, expectedId, "Fixture must be available again after rollback verification");
  }

  const result = {
    ok: true,
    kind: "transport-fixture-only",
    bundleId: expectedId,
    bytes: archive.length,
    sha256: downloadedHash,
    verified: ["update selection", "HTTPS archive download", "SHA-256 integrity", "same bundle no-update", "channel/version isolation", "console authentication", "management API not public"],
    rollbackVerified,
    limitation: "No real React Native app or on-device SDK update was tested.",
  };
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### OTA transport fixture passed\n\nBundle: \`${expectedId}\`\n\nDownloaded ${archive.length} bytes and verified SHA-256. Update selection, version/channel isolation, and console access protection passed.\n\nThis is a diagnostic transport fixture, not an on-device React Native test.\n`);
  }
} finally {
  await database.onUnmount?.();
}
