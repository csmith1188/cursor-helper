import { config } from "./config.js";

function format(level, message) {
  const prefix = `[${config.logPrefix}]`;
  if (level === "warn") {
    return `${prefix} WARNING: ${message}`;
  }
  return `${prefix} ${message}`;
}

export const log = {
  info(message) {
    console.log(format("info", message));
  },
  warn(message) {
    console.warn(format("warn", message));
  },
  error(message) {
    console.error(format("error", message));
  },
};
