import { createApp } from "./app.js";
import { assertKeys, config } from "./config.js";
import { realDeps, root } from "./wiring.js";

assertKeys();

const deps = realDeps();
createApp({ ...deps, root }).listen(config.port, () => {
  console.log(`\n  Chat agent running → http://localhost:${config.port}`);
  console.log(`  models, in fallback order: ${deps.backendNames.join(" → ")}`);
  console.log(`  db: ${config.dbPath}\n`);
});
