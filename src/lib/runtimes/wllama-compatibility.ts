import { ggufSplitThresholdBytes, ggufSplitToolVersion } from "../models/gguf-split-profile";
import {
  maximumDeclaredContextTokens,
  type InstalledModelRecord,
  type ModelFileRecord,
} from "../models/types";

export const maximumWllamaFileBytes = ggufSplitThresholdBytes;

export function isWllamaMtpCompanion(file: ModelFileRecord): boolean {
  return (
    file.displayName.toLowerCase().includes("mtp-") ||
    file.inspection?.architecture === "gemma4-assistant"
  );
}

export function isWllamaMmproj(file: ModelFileRecord): boolean {
  return (
    file.displayName.toLowerCase().includes("mmproj") || file.inspection?.architecture === "clip"
  );
}

export function wllamaPrimaryFiles(model: InstalledModelRecord): readonly ModelFileRecord[] {
  return model.files.filter((file) => !isWllamaMtpCompanion(file) && !isWllamaMmproj(file));
}

export function wllamaModelContextLength(model: InstalledModelRecord): number | undefined {
  const declared = wllamaPrimaryFiles(model)
    .map((file) => {
      const inspection = file.inspection;
      if (inspection?.contextLength !== undefined) return inspection.contextLength;
      const storedEntry = inspection?.entries.find((entry) =>
        entry.key.endsWith(".context_length"),
      );
      const parsed = Number(storedEntry?.value);
      return Number.isSafeInteger(parsed) && parsed >= 256 && parsed <= maximumDeclaredContextTokens
        ? parsed
        : undefined;
    })
    .filter((value): value is number => value !== undefined);
  return declared.length === 0 ? undefined : Math.min(...declared);
}

export type WllamaModelCompatibility =
  | { readonly status: "ready" }
  | { readonly status: "needs-split"; readonly explanation: string }
  | {
      readonly status: "incompatible";
      readonly reasonCode: "minimum-shard-size" | "file-layout";
      readonly explanation: string;
    };

export function wllamaModelCompatibility(model: InstalledModelRecord): WllamaModelCompatibility {
  const measuredIssue = model.runtimeIssues?.find(
    (issue) =>
      issue.runtimeId === "wllama" &&
      issue.limitBytes === maximumWllamaFileBytes &&
      issue.splitterVersion === ggufSplitToolVersion,
  );
  if (measuredIssue !== undefined) {
    return {
      status: "incompatible",
      reasonCode: measuredIssue.reasonCode,
      explanation: measuredIssue.message,
    };
  }
  const primary = wllamaPrimaryFiles(model);
  if (primary.length === 0) {
    return {
      status: "incompatible",
      reasonCode: "file-layout",
      explanation: "No primary GGUF weights were identified for wllama.",
    };
  }
  if (primary.some((file) => file.size >= maximumWllamaFileBytes)) {
    if (
      primary.length === 1 &&
      model.derivation === undefined &&
      !/-\d{5}-of-\d{5}\.gguf$/iu.test(primary[0]?.displayName ?? "")
    ) {
      return {
        status: "needs-split",
        explanation:
          "wllama cannot load an individual GGUF file of 2 GB or more. Chat will prepare compatible shards before loading, or you can prepare them here; the original remains until replacement succeeds.",
      };
    }
    return {
      status: "incompatible",
      reasonCode: "file-layout",
      explanation:
        "At least one GGUF shard is 2 GB or larger, and this installed file layout cannot be split further by WebAI.",
    };
  }
  return { status: "ready" };
}
