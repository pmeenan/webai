import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helperPath = fileURLToPath(new URL("./deploy-target.sh", import.meta.url));

function runHelper(action, parent, env = {}) {
  return spawnSync("bash", [helperPath, action, parent, join(parent, "webai")], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("migrates the active release to a real live directory and removes legacy releases", () => {
  const parent = mkdtempSync(join(tmpdir(), "webai-deploy-target-"));
  try {
    const active = join(parent, ".webai-release-active1");
    const previous = join(parent, ".webai-release-old-1");
    const legacy = join(parent, ".webai-release-legacy-20260718-token");
    const live = join(parent, "webai");
    mkdirSync(active);
    mkdirSync(previous);
    mkdirSync(legacy);
    writeFileSync(join(active, "index.html"), "active");
    symlinkSync(active, live);
    symlinkSync(previous, join(parent, ".webai-previous"));
    writeFileSync(join(parent, ".webai-transaction"), "stale");
    writeFileSync(join(parent, ".webai-helper-token"), "stale");
    symlinkSync(previous, join(parent, ".webai-swap-token"));
    writeFileSync(join(parent, ".webai-deploy.lock"), "preserve");
    mkdirSync(join(parent, "unrelated"));
    writeFileSync(join(parent, ".webai-direct-migration.next"), "stale");

    const prepare = runHelper("prepare", parent);
    assert.equal(prepare.status, 0, prepare.stderr);
    assert.equal(lstatSync(live).isDirectory(), true);
    assert.equal(lstatSync(live).isSymbolicLink(), false);
    assert.equal(readFileSync(join(live, "index.html"), "utf8"), "active");
    assert.equal(existsSync(active), false);

    const cleanup = runHelper("cleanup", parent);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(existsSync(previous), false);
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(join(parent, ".webai-previous")), false);
    assert.equal(existsSync(join(parent, ".webai-transaction")), false);
    assert.equal(existsSync(join(parent, ".webai-helper-token")), false);
    assert.equal(existsSync(join(parent, ".webai-swap-token")), false);
    assert.equal(existsSync(join(parent, ".webai-deploy.lock")), true);
    assert.equal(existsSync(join(parent, "unrelated")), true);
    assert.equal(existsSync(join(parent, ".webai-direct-migration.next")), false);

    assert.equal(runHelper("prepare", parent).status, 0);
    assert.equal(runHelper("cleanup", parent).status, 0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("refuses to migrate a live symlink outside the release namespace", () => {
  const parent = mkdtempSync(join(tmpdir(), "webai-deploy-target-"));
  try {
    const outside = mkdtempSync(join(tmpdir(), "webai-deploy-outside-"));
    try {
      symlinkSync(outside, join(parent, "webai"));
      const result = runHelper("prepare", parent);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /symlink target was unexpected/);
      assert.equal(lstatSync(join(parent, "webai")).isSymbolicLink(), true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("refuses legacy cleanup until the direct live directory has an index", () => {
  const parent = mkdtempSync(join(tmpdir(), "webai-deploy-target-"));
  try {
    mkdirSync(join(parent, "webai"));
    mkdirSync(join(parent, ".webai-release-preserve"));
    const result = runHelper("cleanup", parent);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /verified live directory is unavailable/);
    assert.equal(existsSync(join(parent, ".webai-release-preserve")), true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("restores the live symlink after an interruptible migration failure", () => {
  const parent = mkdtempSync(join(tmpdir(), "webai-deploy-target-"));
  try {
    const active = join(parent, ".webai-release-active");
    const live = join(parent, "webai");
    mkdirSync(active);
    writeFileSync(join(active, "index.html"), "active");
    symlinkSync(active, live);

    const failed = runHelper("prepare", parent, {
      WEBAI_DIRECT_DEPLOY_FAULT: "after-unlink",
    });
    assert.notEqual(failed.status, 0);
    assert.equal(lstatSync(live).isSymbolicLink(), true);
    assert.equal(readFileSync(join(live, "index.html"), "utf8"), "active");
    assert.equal(existsSync(join(parent, ".webai-direct-migration")), true);

    const recovered = runHelper("prepare", parent);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(lstatSync(live).isDirectory(), true);
    assert.equal(lstatSync(live).isSymbolicLink(), false);
    assert.equal(existsSync(join(parent, ".webai-direct-migration")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("finishes a migration left without a live path by an abrupt interruption", () => {
  const parent = mkdtempSync(join(tmpdir(), "webai-deploy-target-"));
  try {
    const active = join(parent, ".webai-release-active");
    const live = join(parent, "webai");
    mkdirSync(active);
    writeFileSync(join(active, "index.html"), "active");
    writeFileSync(join(parent, ".webai-direct-migration"), `${active}\n`);

    const recovered = runHelper("prepare", parent);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(lstatSync(live).isDirectory(), true);
    assert.equal(readFileSync(join(live, "index.html"), "utf8"), "active");
    assert.equal(existsSync(active), false);
    assert.equal(existsSync(join(parent, ".webai-direct-migration")), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
