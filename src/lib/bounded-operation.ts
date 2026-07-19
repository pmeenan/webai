export type BoundedOperationResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" };

export function runBoundedOperation<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<BoundedOperationResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BoundedOperationResult<T>) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      resolve(result);
    };
    const timeout = globalThis.setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    try {
      void operation().then(
        (value) => finish({ kind: "value", value }),
        (error: unknown) => finish({ kind: "error", error }),
      );
    } catch (error: unknown) {
      finish({ kind: "error", error });
    }
  });
}
