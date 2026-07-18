import assert from "node:assert/strict";
import test from "node:test";

import { compareCodeUnits, isPackagedLicenseFileName } from "./generate-third-party-notices.mjs";

test("accepts packaged license documents without accepting source files", () => {
  for (const fileName of [
    "LICENSE",
    "LICENCE",
    "NOTICE",
    "LICENSE.md",
    "License.txt",
    "LICENSE-MIT",
    "LICENSE-MIT.txt",
    "LICENSE-APACHE",
    "LICENSE.BSD",
  ]) {
    assert.equal(isPackagedLicenseFileName(fileName), true, fileName);
  }
  for (const fileName of ["license.js", "notice.ts", "license-loader.mjs", "LICENSE.json"]) {
    assert.equal(isPackagedLicenseFileName(fileName), false, fileName);
  }
});

test("sorts notice keys by locale-independent code units", () => {
  assert.deepEqual(["z", "A", "a", "Z"].sort(compareCodeUnits), ["A", "Z", "a", "z"]);
});
