import fs from "node:fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import { withLock } from "./mutex.js";
import { routeEvent } from "./events.js";

function usage() {
  return [
    "Usage (GitHub Actions): node src/cli.js",
    "  Reads GITHUB_EVENT_NAME and GITHUB_EVENT_PATH from the environment.",
    "",
    "Usage (manual): node src/cli.js --event <name> --payload <file.json>",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { event: null, payloadPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--event") {
      out.event = argv[++i];
    } else if (arg === "--payload") {
      out.payloadPath = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

async function main() {
  if (!config.runnerEnabled) {
    throw new Error(
      `SYNC_MODE=${config.syncMode} does not enable the runner CLI (use runner or both)`,
    );
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const event = args.event || process.env.GITHUB_EVENT_NAME;
  const payloadPath = args.payloadPath || process.env.GITHUB_EVENT_PATH;

  if (!event || !payloadPath) {
    throw new Error(
      `Missing event inputs.\n${usage()}`,
    );
  }

  if (!fs.existsSync(payloadPath)) {
    throw new Error(`Event payload file not found: ${payloadPath}`);
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid event JSON in ${payloadPath}: ${error.message}`);
  }

  log.info(
    `Runner event=${event} repo=${config.fullName} path=${config.repoPath}`,
  );

  await withLock(async () => {
    await routeEvent(event, payload);
  });

  log.info("Runner event handled");
}

main().catch((error) => {
  log.error(error.message);
  process.exitCode = 1;
});
