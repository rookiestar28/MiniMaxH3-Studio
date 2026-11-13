/**
 * A compiled prompt in the host's own key order.
 *
 * ComfyUI frontend 1.57.1 `graphToPrompt` returns `{ workflow, output }`, workflow first
 * (ComfyUI_frontend v1.57.1, src/utils/executionUtil.ts:206), and App Mode keeps that order.
 * The queue identity is order-sensitive JSON, so fixtures that reach the queue seam must not
 * build `{ output, workflow }`: that order hid a fallback that reordered the envelope.
 */
export function hostCompiledPrompt<TOutput, TWorkflow>(
  output: TOutput,
  workflow: TWorkflow,
): { workflow: TWorkflow; output: TOutput } {
  return { workflow, output };
}
