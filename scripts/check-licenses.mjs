import { checkThirdPartyNotices } from "./generate-third-party-notices.mjs";
import { runPnpmJson } from "./pnpm-json.mjs";

const allowedExpressions = new Set([
  "(MIT AND CC-BY-3.0)",
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
]);

let licenses;
try {
  licenses = runPnpmJson(["licenses", "list", "--json"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : "pnpm license enumeration failed.");
  process.exit(2);
}

if (!licenses || typeof licenses !== "object" || Array.isArray(licenses)) {
  console.error("pnpm returned an unexpected license report shape.");
  process.exit(2);
}

const blocked = Object.entries(licenses).filter(
  ([expression]) => !allowedExpressions.has(expression),
);

let packageRecordCount = 0;
let packageInstallationCount = 0;
for (const [expression, packages] of Object.entries(licenses)) {
  if (!Array.isArray(packages)) {
    console.error(`pnpm returned non-array packages for ${expression}.`);
    process.exit(2);
  }
  for (const dependency of packages) {
    if (
      !dependency ||
      typeof dependency !== "object" ||
      !("name" in dependency) ||
      typeof dependency.name !== "string" ||
      !("versions" in dependency) ||
      !Array.isArray(dependency.versions) ||
      dependency.versions.length === 0 ||
      !dependency.versions.every((version) => typeof version === "string") ||
      !("paths" in dependency) ||
      !Array.isArray(dependency.paths) ||
      dependency.paths.length !== dependency.versions.length ||
      !dependency.paths.every((packagePath) => typeof packagePath === "string")
    ) {
      console.error(`pnpm returned malformed package metadata for ${expression}.`);
      process.exit(2);
    }
    packageRecordCount += 1;
    packageInstallationCount += dependency.versions.length;
  }
}

if (packageRecordCount === 0 || packageInstallationCount === 0) {
  console.error("pnpm returned an empty license report; refusing to pass the audit.");
  process.exit(2);
}

if (blocked.length > 0) {
  console.error("Dependency license audit failed. Additions require a decision-log entry:");
  for (const [expression, packages] of blocked) {
    console.error(`\n${expression}`);
    if (Array.isArray(packages)) {
      for (const dependency of packages) {
        if (dependency && typeof dependency === "object") {
          const name = "name" in dependency ? String(dependency.name) : "unknown package";
          const versions =
            "versions" in dependency && Array.isArray(dependency.versions)
              ? dependency.versions.join(", ")
              : "unknown version";
          console.error(`  - ${name}@${versions}`);
        }
      }
    }
  }
  process.exit(1);
}

try {
  checkThirdPartyNotices();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Third-party notice validation failed.");
  process.exit(1);
}

console.log(
  `License audit passed: ${packageInstallationCount} package-version installations in ${packageRecordCount} package records across ${Object.keys(licenses).length} allowed SPDX expressions; deployable notices are current.`,
);
