import crypto from "node:crypto";
import { spawn } from "node:child_process";

const secret = "test-secret-value-12345";
const child = spawn("node", ["src/index.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"],
});

let ready = false;
child.stdout.on("data", (d) => {
  process.stdout.write(d);
  if (String(d).includes("Listening")) ready = true;
});
child.stderr.on("data", (d) => process.stderr.write(d));

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

try {
  for (let i = 0; i < 20 && !ready; i++) {
    await wait(100);
  }
  if (!ready) {
    throw new Error("Server did not start");
  }

  const health = await fetch("http://127.0.0.1:3456/health");
  console.log("health", health.status, await health.json());

  const body = Buffer.from(
    JSON.stringify({
      zen: "test",
      repository: { full_name: "test-owner/test-repo" },
    }),
  );
  const sig =
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

  const bad = await fetch("http://127.0.0.1:3456/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": "sha256=deadbeef",
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": "d1",
    },
    body,
  });
  console.log("bad sig", bad.status, await bad.text());

  const ok = await fetch("http://127.0.0.1:3456/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": sig,
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": "d2",
    },
    body,
  });
  console.log("good ping", ok.status, await ok.text());

  const dup = await fetch("http://127.0.0.1:3456/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": sig,
      "X-GitHub-Event": "ping",
      "X-GitHub-Delivery": "d2",
    },
    body,
  });
  console.log("dup", dup.status, await dup.text());

  await wait(300);
} finally {
  child.kill("SIGTERM");
}
