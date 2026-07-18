import {
  indeterminateOutcome,
  valueOutcome,
  type ProbeOutcome,
  type WebNnSnapshot,
} from "./evidence";
import { protocolFailure } from "./sanitize";

export function normalizeWorkerIsolation(value: unknown): ProbeOutcome<boolean> {
  return valueOutcome(value === true);
}

export function normalizeWebNnContext(
  requested: WebNnSnapshot["requested"],
  accelerated: unknown,
): ProbeOutcome<WebNnSnapshot> {
  return typeof accelerated === "boolean"
    ? valueOutcome({ requested, accelerated })
    : indeterminateOutcome("protocol-error", protocolFailure());
}
