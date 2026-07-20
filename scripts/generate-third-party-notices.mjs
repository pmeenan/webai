import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runPnpmJson } from "./pnpm-json.mjs";

const noticePath = path.resolve("public/licenses/THIRD-PARTY-NOTICES.txt");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

// Every direct dependency is covered by default. Build-only and separately licensed
// asset roots are the only exclusions; adding a new browser dependency therefore
// automatically adds its complete runtime closure to the generated notice file.
const buildOnlyRoots = new Set(["@tailwindcss/vite"]);
const separatelyLicensedAssetRoots = new Set([
  "@fontsource-variable/inter",
  "@fontsource-variable/jetbrains-mono",
]);
const nonTraversedShippedRoots = new Set(["@astrojs/react", "astro", "tailwindcss"]);

// Build inputs or generators whose attributed data/code is reflected in output.
const attributedBuildPackages = ["caniuse-lite", "lightningcss", "rolldown", "vite"];

// These packages declare the listed permissive license but omit its text from their npm tarball.
// Each fallback is the upstream repository's license, checked 2026-07-18.
const fallbackLicenses = new Map([
  [
    "@sqlite.org/sqlite-wasm",
    path.join(scriptDirectory, "license-fallbacks/sqlite-wasm-Apache-2.0.txt"),
  ],
  ["@wllama/wllama", path.join(scriptDirectory, "license-fallbacks/wllama-MIT.txt")],
  ["@wllama/wllama-compat", path.join(scriptDirectory, "license-fallbacks/wllama-MIT.txt")],
  [
    "react-remove-scroll-bar",
    path.join(scriptDirectory, "license-fallbacks/react-remove-scroll-bar-MIT.txt"),
  ],
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeLicenseText(text) {
  return `${text.trim()}\n`;
}

const packagedLicenseName = /^(?:licen[cs]e|copying|notice)$/i;
const packagedLicenseDocument = /^(?:licen[cs]e|copying|notice)\.(?:md|markdown|rst|text|txt)$/i;
const packagedLicenseVariant =
  /^(?:licen[cs]e|copying|notice)[._-](?:0bsd|apache(?:[._-]?2(?:\.0)?)?|bsd(?:[._-]?[23](?:[._-]?clause)?)?|cc[._-]by(?:[._-][0-9.]+)?|isc|mit|mpl(?:[._-]?2(?:\.0)?)?|ofl(?:[._-]?1(?:\.1)?)?|python(?:[._-]?2(?:\.0)?)?|unlicense)(?:\.(?:md|markdown|rst|text|txt))?$/i;

export function isPackagedLicenseFileName(fileName) {
  return (
    packagedLicenseName.test(fileName) ||
    packagedLicenseDocument.test(fileName) ||
    packagedLicenseVariant.test(fileName)
  );
}

export function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findPackagedLicense(packagePath) {
  const candidates = fs
    .readdirSync(packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isPackagedLicenseFileName(entry.name))
    .map((entry) => entry.name)
    .sort(compareCodeUnits);

  if (candidates.length === 0) {
    return undefined;
  }

  return candidates
    .map((candidate) =>
      normalizeLicenseText(fs.readFileSync(path.join(packagePath, candidate), "utf8")),
    )
    .join("\n");
}

function packageHomepage(packagePath) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packagePath, "package.json"), "utf8"));
  if (typeof packageJson.homepage === "string") {
    return packageJson.homepage;
  }
  if (typeof packageJson.repository === "string") {
    return packageJson.repository;
  }
  if (isObject(packageJson.repository) && typeof packageJson.repository.url === "string") {
    return packageJson.repository.url.replace(/^git\+/, "");
  }
  return undefined;
}

function validateLicenseReport(report) {
  if (!isObject(report)) {
    throw new Error("pnpm returned an unexpected production license report shape.");
  }

  const byPath = new Map();
  const byName = new Map();
  for (const [expression, packages] of Object.entries(report)) {
    if (!Array.isArray(packages)) {
      throw new Error(`pnpm returned non-array packages for ${expression}.`);
    }
    for (const dependency of packages) {
      if (
        !isObject(dependency) ||
        typeof dependency.name !== "string" ||
        !Array.isArray(dependency.versions) ||
        !dependency.versions.every((version) => typeof version === "string") ||
        !Array.isArray(dependency.paths) ||
        !dependency.paths.every((packagePath) => typeof packagePath === "string") ||
        dependency.versions.length !== dependency.paths.length
      ) {
        throw new Error(`pnpm returned malformed license metadata for ${expression}.`);
      }

      for (let index = 0; index < dependency.paths.length; index += 1) {
        const record = {
          expression,
          name: dependency.name,
          path: dependency.paths[index],
          version: dependency.versions[index],
        };
        byPath.set(record.path, record);
        const namedRecords = byName.get(record.name) ?? [];
        namedRecords.push(record);
        byName.set(record.name, namedRecords);
      }
    }
  }
  return { byName, byPath };
}

function collectDependency(node, includeDependencies, selected) {
  if (!isObject(node) || typeof node.from !== "string" || typeof node.path !== "string") {
    throw new Error("pnpm returned malformed production dependency-tree data.");
  }
  if (!node.from.startsWith("@types/")) {
    selected.set(node.path, node);
  }
  if (!includeDependencies || !isObject(node.dependencies)) {
    return;
  }
  for (const dependency of Object.values(node.dependencies)) {
    collectDependency(dependency, true, selected);
  }
}

export function generateThirdPartyNotices() {
  const licenseIndex = validateLicenseReport(runPnpmJson(["licenses", "list", "--prod", "--json"]));
  const dependencyTrees = runPnpmJson(["list", "--prod", "--json", "--depth", "Infinity"]);
  const project = Array.isArray(dependencyTrees) ? dependencyTrees[0] : undefined;
  if (!isObject(project) || !isObject(project.dependencies)) {
    throw new Error("pnpm returned an unexpected production dependency tree.");
  }
  const rootPackageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  if (!isObject(rootPackageJson.dependencies)) {
    throw new Error("package.json has no production dependency map.");
  }

  const selected = new Map();
  for (const name of Object.keys(rootPackageJson.dependencies)) {
    if (buildOnlyRoots.has(name) || separatelyLicensedAssetRoots.has(name)) {
      continue;
    }
    const dependency = project.dependencies[name];
    if (dependency === undefined) {
      throw new Error(`Required shipped dependency ${name} is missing.`);
    }
    collectDependency(dependency, !nonTraversedShippedRoots.has(name), selected);
  }
  for (const name of attributedBuildPackages) {
    const records = licenseIndex.byName.get(name);
    if (records === undefined || records.length === 0) {
      throw new Error(`Required attributed build package ${name} is missing.`);
    }
    for (const record of records) {
      selected.set(record.path, record);
    }
  }

  const notices = [];
  for (const [packagePath, selectedDependency] of selected) {
    const licenseRecord = licenseIndex.byPath.get(packagePath);
    if (licenseRecord === undefined) {
      throw new Error(`No license record found for shipped dependency at ${packagePath}.`);
    }
    let licenseText = findPackagedLicense(packagePath);
    if (licenseText === undefined) {
      const fallback = fallbackLicenses.get(licenseRecord.name);
      if (fallback === undefined) {
        throw new Error(
          `${licenseRecord.name}@${licenseRecord.version} ships without a license file; add an evidenced fallback.`,
        );
      }
      licenseText = normalizeLicenseText(fs.readFileSync(fallback, "utf8"));
    }
    notices.push({
      expression: licenseRecord.expression,
      homepage: packageHomepage(packagePath),
      licenseText,
      name: licenseRecord.name,
      version:
        typeof selectedDependency.version === "string"
          ? selectedDependency.version
          : licenseRecord.version,
    });
  }

  notices.push({
    expression: "MIT",
    homepage: "https://ui.shadcn.com/",
    licenseText: normalizeLicenseText(
      fs.readFileSync(path.join(scriptDirectory, "license-fallbacks/shadcn-ui-MIT.txt"), "utf8"),
    ),
    name: "shadcn/ui Button (adapted vendored source)",
    version: "2026-07-18 snapshot",
  });

  notices.push({
    expression: "MIT",
    homepage: "https://github.com/ggml-org/llama.cpp",
    licenseText: normalizeLicenseText(
      fs.readFileSync(path.join(scriptDirectory, "license-fallbacks/llama.cpp-MIT.txt"), "utf8"),
    ),
    name: "llama.cpp GGUF split planner (modified WebAssembly build)",
    version: "dd4623a7 / webai-2",
  });

  notices.push({
    expression: "MIT",
    homepage: "https://github.com/ngxson/wllama/tree/3.5.1",
    licenseText: normalizeLicenseText(
      fs.readFileSync(path.join(scriptDirectory, "license-fallbacks/wllama-MIT.txt"), "utf8"),
    ),
    name: "wllama browser response and lifecycle patches (modified ESM bundle)",
    version: "3.5.1 / webai-1",
  });

  notices.sort((left, right) =>
    compareCodeUnits(`${left.name}@${left.version}`, `${right.name}@${right.version}`),
  );

  const sections = notices.map((notice) => {
    const homepage = notice.homepage === undefined ? "" : `\nSource: ${notice.homepage}`;
    return [
      "===============================================================================",
      `${notice.name}@${notice.version}`,
      `SPDX license expression: ${notice.expression}${homepage}`,
      "-------------------------------------------------------------------------------",
      notice.licenseText.trimEnd(),
    ].join("\n");
  });

  const header = [
    "WebAI third-party software notices",
    "",
    "This generated file contains the license notices for dependencies whose code,",
    "generated output, or attributed data is distributed by the WebAI static site.",
    "It is generated from the packageManager-pinned pnpm production tree; edit the",
    "generator or dependencies, then run `pnpm license:notices` to update it.",
  ].join("\n");
  return `${header}\n\n${sections.join("\n\n")}\n`;
}

export function checkThirdPartyNotices() {
  const expected = generateThirdPartyNotices();
  let actual;
  try {
    actual = fs.readFileSync(noticePath, "utf8");
  } catch {
    throw new Error("The deployable third-party notice file is missing; run pnpm license:notices.");
  }
  if (actual !== expected) {
    throw new Error("The deployable third-party notice file is stale; run pnpm license:notices.");
  }
}

function writeThirdPartyNotices() {
  fs.writeFileSync(noticePath, generateThirdPartyNotices());
  console.log(`Wrote ${path.relative(process.cwd(), noticePath)}.`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    writeThirdPartyNotices();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Third-party notice generation failed.");
    process.exit(2);
  }
}
