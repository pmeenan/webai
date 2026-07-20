import { describe, expect, it, vi } from "vitest";
import { ModelWorkerClient } from "./worker-client";

class FakeWorker extends EventTarget {
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
}

describe("model worker client lifecycle", () => {
  it("terminates the worker and ignores later messages after a terminal protocol failure", async () => {
    const worker = new FakeWorker();
    const client = new ModelWorkerClient(worker as unknown as Worker);
    const listener = vi.fn();
    client.subscribe(listener);
    const pending = client.inventory();

    worker.dispatchEvent(new MessageEvent("message", { data: { invalid: true } }));

    await expect(pending).rejects.toMatchObject({ code: "protocol" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { protocolVersion: 5, type: "model/complete", requestId: "late" },
      }),
    );
    expect(listener).not.toHaveBeenCalled();
  });
});
