import type { ResponseChannel } from "./types";

interface MutableResponseChannel {
  readonly id: string;
  name: string;
  content: string;
  complete: boolean;
  final: boolean;
  implicit: boolean;
}

const completeMarker =
  /(?:<\|channel\|?>([A-Za-z][A-Za-z0-9_-]*)(?:<\|message\|>|[ \t]*\r?\n)|(<channel\|>))/u;
const markerPrefixes = ["<|channel>", "<|channel|>", "<channel|>"] as const;
const maximumPendingMarkerBytes = 256;

function isFinalChannel(name: string): boolean {
  return name.toLowerCase() === "final";
}

function possibleMarkerStart(text: string): number {
  let index = Math.max(...markerPrefixes.map((prefix) => text.lastIndexOf(prefix)));
  const lastOpeningBracket = text.lastIndexOf("<");
  if (lastOpeningBracket > index) {
    const suffix = text.slice(lastOpeningBracket);
    if (markerPrefixes.some((prefix) => prefix.startsWith(suffix))) index = lastOpeningBracket;
  }
  return index >= 0 && text.length - index <= maximumPendingMarkerBytes ? index : -1;
}

export class ChannelStreamParser {
  readonly #channels: MutableResponseChannel[] = [];
  #buffer = "";
  #currentIndex: number | undefined;

  push(text: string): readonly ResponseChannel[] {
    this.#buffer += text;
    while (true) {
      const marker = completeMarker.exec(this.#buffer);
      if (marker === null) break;
      this.#append(this.#buffer.slice(0, marker.index));
      this.#classifyImplicit(marker[2] === undefined ? "preamble" : "thought");
      this.#completeCurrent();
      this.#start(marker[2] === undefined ? (marker[1] ?? "channel") : "final");
      this.#buffer = this.#buffer.slice(marker.index + marker[0].length);
    }

    const pendingMarker = possibleMarkerStart(this.#buffer);
    if (pendingMarker < 0) {
      this.#append(this.#buffer);
      this.#buffer = "";
    } else if (pendingMarker > 0) {
      this.#append(this.#buffer.slice(0, pendingMarker));
      this.#buffer = this.#buffer.slice(pendingMarker);
    }
    return this.snapshot();
  }

  finish(): readonly ResponseChannel[] {
    this.#append(this.#buffer);
    this.#buffer = "";
    this.#completeCurrent();
    return this.snapshot();
  }

  snapshot(): readonly ResponseChannel[] {
    return this.#channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      content: channel.content,
      complete: channel.complete,
      final: channel.final,
    }));
  }

  #append(text: string): void {
    if (text.length === 0) return;
    if (this.#currentIndex === undefined) this.#start("final", true);
    const currentIndex = this.#currentIndex;
    if (currentIndex === undefined) return;
    const current = this.#channels[currentIndex];
    if (current !== undefined) current.content += text;
  }

  #start(name: string, implicit = false): void {
    this.#currentIndex = this.#channels.length;
    this.#channels.push({
      id: `channel-${this.#channels.length}`,
      name,
      content: "",
      complete: false,
      final: isFinalChannel(name),
      implicit,
    });
  }

  #classifyImplicit(name: "preamble" | "thought"): void {
    if (this.#currentIndex === undefined) return;
    const current = this.#channels[this.#currentIndex];
    if (current === undefined || !current.implicit) return;
    current.name = name;
    current.final = false;
    current.implicit = false;
  }

  #completeCurrent(): void {
    if (this.#currentIndex === undefined) return;
    const current = this.#channels[this.#currentIndex];
    if (current !== undefined) current.complete = true;
  }
}

export function finalResponseText(channels: readonly ResponseChannel[]): string {
  return channels
    .filter((channel) => channel.final)
    .map((channel) => channel.content)
    .join("\n\n");
}
