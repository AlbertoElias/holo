import { startPolyhavenFixture } from "./polyhavenFixture.js";

// Runs the Poly Haven stand-in on a fixed port for the e2e pipeline, whose API
// is pointed at it with POLYHAVEN_API_ORIGIN (PRD-060).
const port = Number(process.env.E2E_POLYHAVEN_PORT ?? "3199");
const fixture = await startPolyhavenFixture([], { port });
console.log(`Poly Haven fixture on ${fixture.origin}`);
const stop = () => void fixture.close().finally(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
