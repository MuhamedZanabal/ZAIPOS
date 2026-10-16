/** Typed access to a recorded mock argument (vi.fn() without a signature records `[]` tuples). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function callArg<T = any>(fn: { mock: { calls: readonly unknown[][] } }, call = 0, arg = 0): T {
  return fn.mock.calls[call]?.[arg] as T;
}
