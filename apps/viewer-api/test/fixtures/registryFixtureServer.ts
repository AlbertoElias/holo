import { startPolyhavenFixture } from "./polyhavenFixture.js";
import { startPolypizzaFixture } from "./polypizzaFixture.js";

// Runs the Poly Haven and Poly Pizza stand-ins on fixed ports for the e2e
// pipeline, whose API is pointed at them with POLYHAVEN_API_ORIGIN and
// POLYPIZZA_API_ORIGIN (PRD-060).
const polyhaven = await startPolyhavenFixture([], { port: Number(process.env.E2E_POLYHAVEN_PORT ?? "3199") });
const polypizza = await startPolypizzaFixture([], { port: Number(process.env.E2E_POLYPIZZA_PORT ?? "3198") });
console.log(`Poly Haven fixture on ${polyhaven.origin}, Poly Pizza fixture on ${polypizza.origin}`);
const stop = () => void Promise.all([polyhaven.close(), polypizza.close()]).finally(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
