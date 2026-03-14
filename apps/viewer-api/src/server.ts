import "dotenv/config";

import { buildApp } from "./app.js";
import { env } from "./lib/env.js";

const app = buildApp();

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .catch((error: unknown) => {
    app.log.error({ error }, "Failed to start server");
    process.exit(1);
  });
