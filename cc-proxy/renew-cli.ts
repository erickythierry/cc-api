import { renewToken } from "./renew.ts";

const headless = !process.argv.includes("--no-headless") && !process.argv.includes("--visible");
console.log(`[renew-cli] Starting token renewal (headless: ${headless})...`);

try {
  const result = await renewToken({ headless });
  console.log("[renew-cli] Token renewed successfully!");
  console.log(`User: ${result.userName} (${result.userId})`);
  console.log(`API Key: ${result.apiKey.slice(0, 20)}...`);
  console.log(`Key Name: ${result.keyName}`);
  console.log(`Authenticated At: ${result.authenticatedAt}`);
  process.exit(0);
} catch (err) {
  console.error("[renew-cli] Error:", err instanceof Error ? err.message : err);
  process.exit(1);
}
