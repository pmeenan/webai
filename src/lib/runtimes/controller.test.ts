import { describe, expect, test, vi } from "vitest";
import type { InstalledModelRecord } from "../models/types";
import { RuntimeController } from "./controller";
import type { GenerationEvent, WllamaRuntimeSession } from "./types";

const model: InstalledModelRecord = {
  schemaVersion: 1,
  id: "model-1",
  displayName: "Test model",
  createdAt: "2026-07-19T00:00:00.000Z",
  totalSize: 0,
  state: "installed",
  source: { kind: "local-import", filenames: [], lastModified: [], sha256: [] },
  files: [],
};

const session: WllamaRuntimeSession = {
  runtimeId: "wllama",
  modelTarget: { kind: "artifact-set", model },
  backend: {
    threads: 2,
    gpuLayers: 0,
    contextSize: 2_048,
    build: "compat",
    webgpuRequested: false,
    webgpuAvailable: false,
  },
  loadTimeMs: 1,
};

async function controllerWithSession(): Promise<{
  readonly controller: RuntimeController;
  readonly handle: Awaited<ReturnType<RuntimeController["createWllamaSession"]>>["handle"];
}> {
  const controller = new RuntimeController();
  vi.spyOn(controller.wllama, "dispose").mockResolvedValue();
  vi.spyOn(controller.wllama, "createSession").mockResolvedValue(session);
  const created = await controller.createWllamaSession(model, session.backend);
  return { controller, handle: created.handle };
}

describe("RuntimeController", () => {
  test("sequences events, emits completion last, and suppresses late adapter callbacks", async () => {
    const { controller, handle } = await controllerWithSession();
    let adapterEmit: ((event: GenerationEvent) => void) | undefined;
    vi.spyOn(controller.wllama, "generate").mockImplementation(
      async (_messages, _options, _signal, onEvent) => {
        adapterEmit = onEvent;
        onEvent({ type: "text", text: "hello" });
      },
    );
    const events: Array<{ readonly sequence: number; readonly type: string }> = [];
    const generation = controller.generate(handle, [{ role: "user", content: "hi" }], {}, (event) =>
      events.push({ sequence: event.sequence, type: event.event.type }),
    );
    await generation.completion;
    adapterEmit?.({ type: "text", text: "late" });
    expect(events).toEqual([
      { sequence: 0, type: "text" },
      { sequence: 1, type: "complete" },
    ]);
  });

  test("translates abort failures and ignores an unrelated request id", async () => {
    const { controller, handle } = await controllerWithSession();
    vi.spyOn(controller.wllama, "generate").mockImplementation(
      async (_messages, _options, signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("native stopped")), {
            once: true,
          });
        }),
    );
    const generation = controller.generate(
      handle,
      [{ role: "user", content: "hi" }],
      {},
      () => undefined,
    );
    controller.abort(handle, "not-the-active-request");
    expect(generation.completion).not.toBe(undefined);
    controller.abort(handle, generation.requestId);
    await expect(generation.completion).rejects.toMatchObject({ name: "AbortError" });
  });

  test("rejects an aborted request even when the adapter resolves cooperatively", async () => {
    const { controller, handle } = await controllerWithSession();
    vi.spyOn(controller.wllama, "generate").mockImplementation(
      async (_messages, _options, signal) =>
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const generation = controller.generate(
      handle,
      [{ role: "user", content: "hi" }],
      {},
      () => undefined,
    );
    controller.abort(handle, generation.requestId);
    await expect(generation.completion).rejects.toMatchObject({ name: "AbortError" });
  });

  test("invalidates the previous handle when replacing a runtime session", async () => {
    const { controller, handle } = await controllerWithSession();
    vi.mocked(controller.wllama.createSession).mockResolvedValue(session);
    await controller.createWllamaSession(model, session.backend);
    const stale = controller.generate(
      handle,
      [{ role: "user", content: "hi" }],
      {},
      () => undefined,
    );
    await expect(stale.completion).rejects.toThrow("no longer valid");
  });
});
