import { serve } from "@hono/node-server";
import app from "./app.js";

const port = Number(process.env.PORT ?? 3007);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.info(`Hot Updater listening on http://localhost:${info.port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
