// @ts-expect-error Node globals must not leak into the production browser program.
export type NodeProcessMustRemainUnavailable = typeof process;

// @ts-expect-error Node globals must not leak into the production browser program.
export type NodeBufferMustRemainUnavailable = typeof Buffer;
