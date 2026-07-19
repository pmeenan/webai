import { describe, expect, it } from "vitest";
import { ChannelStreamParser, finalResponseText } from "./channel-parser";

describe("streamed response channel parser", () => {
  it("treats ordinary model output as final text", () => {
    const parser = new ChannelStreamParser();
    parser.push("Hello, ");
    const channels = parser.push("traveler.");
    expect(finalResponseText(channels)).toBe("Hello, traveler.");
    expect(parser.finish()).toEqual([
      {
        id: "channel-0",
        name: "final",
        content: "Hello, traveler.",
        complete: true,
        final: true,
      },
    ]);
  });

  it("parses fragmented Gemma channels and completes each transition", () => {
    const parser = new ChannelStreamParser();
    parser.push("<|chan");
    parser.push("nel>thought\r");
    parser.push("\nConsider the forge.");
    const channels = parser.push("<|channel>fi");
    expect(channels[0]).toMatchObject({ name: "thought", complete: false });
    const final = parser.push("nal\nGood morrow, traveler.");
    expect(final).toEqual([
      {
        id: "channel-0",
        name: "thought",
        content: "Consider the forge.",
        complete: true,
        final: false,
      },
      {
        id: "channel-1",
        name: "final",
        content: "Good morrow, traveler.",
        complete: false,
        final: true,
      },
    ]);
    expect(parser.finish()[1]).toMatchObject({ complete: true });
  });

  it("accepts channel/message markers and preserves multiple intermediate channels", () => {
    const parser = new ChannelStreamParser();
    const channels = parser.push(
      "<|channel|>analysis<|message|>Inspect steel.<|channel|>commentary<|message|>Heat it.<|channel|>final<|message|>Done.",
    );
    expect(channels.map(({ name, content, complete }) => ({ name, content, complete }))).toEqual([
      { name: "analysis", content: "Inspect steel.", complete: true },
      { name: "commentary", content: "Heat it.", complete: true },
      { name: "final", content: "Done.", complete: false },
    ]);
  });

  it("treats Gemma 4's fragmented closing channel token as the final-response boundary", () => {
    const parser = new ChannelStreamParser();
    parser.push("<|channel>thought\nPlan the answer.<chan");
    const channels = parser.push("nel|>Speak the answer.");
    expect(channels).toEqual([
      {
        id: "channel-0",
        name: "thought",
        content: "Plan the answer.",
        complete: true,
        final: false,
      },
      {
        id: "channel-1",
        name: "final",
        content: "Speak the answer.",
        complete: false,
        final: true,
      },
    ]);
    expect(finalResponseText(channels)).toBe("Speak the answer.");
  });

  it("reclassifies text before Gemma 4's bare boundary as thinking", () => {
    const parser = new ChannelStreamParser();
    parser.push("Plan the answer.");
    const channels = parser.push("<channel|>Speak the answer.");
    expect(channels).toEqual([
      {
        id: "channel-0",
        name: "thought",
        content: "Plan the answer.",
        complete: true,
        final: false,
      },
      {
        id: "channel-1",
        name: "final",
        content: "Speak the answer.",
        complete: false,
        final: true,
      },
    ]);
    expect(finalResponseText(channels)).toBe("Speak the answer.");
  });

  it("keeps a preamble before a named channel out of the final response", () => {
    const parser = new ChannelStreamParser();
    const channels = parser.push("note<|channel>final\nAnswer");
    expect(channels[0]).toMatchObject({ name: "preamble", final: false, content: "note" });
    expect(finalResponseText(channels)).toBe("Answer");
  });

  it("preserves an incomplete or invalid marker as literal output at stream end", () => {
    const parser = new ChannelStreamParser();
    parser.push("A literal <|channel>unfinished");
    expect(finalResponseText(parser.finish())).toBe("A literal <|channel>unfinished");
  });

  it("bounds malformed marker retention and ignores repeated non-marker brackets", () => {
    const parser = new ChannelStreamParser();
    const specialTokens = "<unused49>".repeat(10_000);
    expect(finalResponseText(parser.push(specialTokens))).toBe(specialTokens);

    const malformedMarker = `<|channel>${"a".repeat(300)}`;
    expect(finalResponseText(parser.push(malformedMarker))).toBe(specialTokens + malformedMarker);
  });
});
