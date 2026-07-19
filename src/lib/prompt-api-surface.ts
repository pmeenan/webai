export type PromptApiAvailability = "unavailable" | "downloadable" | "downloading" | "available";

export const promptApiTextOptions = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
} as const;

export const promptApiProbeTimeoutMs = 5_000;

export function isPromptApiAvailability(value: unknown): value is PromptApiAvailability {
  return (
    typeof value === "string" &&
    ["unavailable", "downloadable", "downloading", "available"].includes(value)
  );
}
