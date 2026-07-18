import { spawnSync } from "node:child_process";

export function runPnpmJson(arguments_) {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) {
    throw new Error("Run this command through pnpm so the packageManager-pinned pnpm is used.");
  }

  const result = spawnSync(process.execPath, [pnpmCli, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error !== undefined) {
    throw new Error(`Unable to run pnpm ${arguments_.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (typeof result.stderr === "string" && result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`pnpm ${arguments_.join(" ")} failed with status ${result.status ?? 2}.`);
  }

  if (typeof result.stdout !== "string") {
    throw new Error(`pnpm ${arguments_.join(" ")} returned invalid JSON.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`pnpm ${arguments_.join(" ")} returned invalid JSON.`);
  }
}
