import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helperPath = fileURLToPath(new URL("./deploy-smoke.sh", import.meta.url));
const harness = [
  "set -u",
  "deploy_url='https://example.invalid'",
  "smoke_dir='/tmp'",
  'source "$1"',
  "rg_call_count=0",
  'curl() { return "${CURL_STATUS}"; }',
  "rg() {",
  "  rg_call_count=$((rg_call_count + 1))",
  '  if [[ "${rg_call_count}" -eq 1 ]]; then',
  '    return "${COOP_STATUS}"',
  "  fi",
  '  return "${COEP_STATUS}"',
  "}",
  "check_route '' home",
].join("\n");

function runSmokeCheck({ curlStatus = 0, coopStatus = 0, coepStatus = 0 }) {
  return spawnSync("bash", ["-c", harness, "deploy-smoke-test", helperPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      COEP_STATUS: String(coepStatus),
      COOP_STATUS: String(coopStatus),
      CURL_STATUS: String(curlStatus),
    },
  });
}

test("route smoke check propagates fetch and both isolation-header failures", () => {
  assert.equal(runSmokeCheck({}).status, 0);
  assert.equal(runSmokeCheck({ curlStatus: 1 }).status, 1);
  assert.equal(runSmokeCheck({ coopStatus: 1 }).status, 1);
  assert.equal(runSmokeCheck({ coepStatus: 1 }).status, 1);
});
