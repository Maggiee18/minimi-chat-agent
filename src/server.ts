import { createApp } from "./app.js";
import { assertKeys, config } from "./config.js";
import { realDeps, root } from "./wiring.js";

assertKeys();

createApp({ ...realDeps(), root }).listen(config.port, () => {
  console.log(`\n  Chat agent running → http://localhost:${config.port}\n  provider: ${config.provider} · model: ${config.answerModel} · notes: ${config.noteModel} · db: ${config.dbPath}\n`);
});
