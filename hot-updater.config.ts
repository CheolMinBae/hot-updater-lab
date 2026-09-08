import { s3Database, s3Storage } from "@hot-updater/aws";
import { defineConfig } from "hot-updater";
import { fixtureBuild } from "./scripts/fixture-build.js";
import { databaseConfig, storageConfig } from "./src/config.js";

const consolePort = Number(process.env.NITRO_PORT ?? 1422);
if (!Number.isInteger(consolePort) || consolePort < 1 || consolePort > 65535) {
  throw new Error("NITRO_PORT must be an integer between 1 and 65535");
}

export default defineConfig({
  // This fixture validates delivery only; replace it with an RN build plugin
  // when a React Native application is connected to this lab.
  build: fixtureBuild,
  storage: s3Storage(storageConfig),
  database: s3Database(databaseConfig),
  updateStrategy: "appVersion",
  console: {
    port: consolePort,
    gitUrl: "https://github.com/CheolMinBae/hot-updater-lab",
  },
});
