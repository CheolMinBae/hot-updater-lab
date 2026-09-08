import { s3Database, s3Storage } from "@hot-updater/aws";
import { createHotUpdater } from "@hot-updater/server";
import { Hono } from "hono";
import {
  BASE_PATH,
  databaseConfig,
  HOT_UPDATER_VERSION,
  storageConfig,
} from "./config.js";

const hotUpdater = createHotUpdater({
  database: s3Database(databaseConfig),
  storages: [s3Storage(storageConfig)],
  basePath: BASE_PATH,
  // CI writes to S3 directly. The public runtime only serves update checks.
  routes: { updateCheck: true, bundles: false },
});

export const app = new Hono();

app.use("*", async (context, next) => {
  await next();
  context.header("Cache-Control", "no-store");
});

app.onError((_error, context) => {
  console.error("OTA request failed");
  return context.json({ error: "Internal server error" }, 500);
});

app.get("/health", (context) =>
  context.json({
    status: "ok",
    service: "hot-updater",
    version: HOT_UPDATER_VERSION,
  }),
);

const handleUpdateRequest = async (request: Request): Promise<Response> => {
  // Preserve the complete path; Hot Updater removes its own basePath.
  const response = await hotUpdater.handler(request);
  if (response.status >= 500) {
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
  return response;
};

app.all(BASE_PATH, (context) => handleUpdateRequest(context.req.raw));
app.all(`${BASE_PATH}/*`, (context) => handleUpdateRequest(context.req.raw));
app.notFound((context) => context.json({ error: "Not found" }, 404));

export default app;
