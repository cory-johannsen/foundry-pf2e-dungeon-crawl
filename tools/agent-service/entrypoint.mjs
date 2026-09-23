#!/usr/bin/env node
import { createServer } from "./server.mjs";
import { readEnvOrDotenv } from "./env.mjs";

const PORT = Number(readEnvOrDotenv("PORT") ?? 8787);
const apiKey = readEnvOrDotenv("AGENT_SERVICE_API_KEY");
if (!apiKey) {
  console.error("agent-service: AGENT_SERVICE_API_KEY must be set — refusing to start unauthenticated.");
  process.exit(1);
}

const server = createServer({ apiKey });
server.listen(PORT, () => {
  console.log(`agent-service: listening on :${PORT}`);
});
