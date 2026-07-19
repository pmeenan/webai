import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { patchWllamaIndex } from "./patch-wllama-index.mjs";

test("patches the pinned wllama response loop to drain queued terminal results", () => {
  const source = fs.readFileSync(path.resolve("node_modules/@wllama/wllama/esm/index.js"), "utf8");
  const patched = patchWllamaIndex(source);
  assert.match(patched, /WebAI patch: the native glue can report no active task/u);
  assert.equal(
    patched.includes(
      "if (!result_chunk.has_more) {\n          break;\n        }\n      }\n      return finalResult;",
    ),
    false,
  );
});

test("fails closed when the pinned source shape changes", () => {
  assert.throws(() => patchWllamaIndex("export {};"), /no longer has one exact target/u);
});
