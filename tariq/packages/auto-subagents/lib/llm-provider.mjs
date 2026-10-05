/** LLM service provider with one-shot Auto preparation recovery over the upstream adapter API. */
import { runtimeModuleUrl } from './dsh-paths.mjs';
const { LlmRuntime } = await import(runtimeModuleUrl('@deepseek-ai/dsh-llm'));

function terminalPreparation(error) {
  if ((error?.failure?.code ?? error?.code) !== 'NO_ADAPTER') return error;
  // Upstream admits unregistered middleware routes only for native LlmError NO_ADAPTER.
  // An owned terminal error keeps the provider facts without entering that compatibility path.
  return Object.assign(new Error(error.message, { cause: error }), { name: 'AutoPreparationError', code: error.code, failure: error.failure });
}

/**
 * Install in place of the base LLM provider before adapters mount. Native registry,
 * prepared-call freezing, retry metadata and dispatch remain owned by LlmRuntime.
 */
export class AutoLlmRuntime extends LlmRuntime {
  constructor(ctx) { super(ctx); this.autoPreparations = new WeakMap(); }
  /** Bind recovery to the exact final Auto request object, consumed by its next preparation. */
  bindAutoPreparation(config, recover) {
    if (this.autoPreparations.has(config)) throw new Error('Auto preparation is already bound to this request');
    this.autoPreparations.set(config, recover);
  }
  /** Prepare the native call, changing only an explicitly bound request after its owned recovery. */
  async prepareCall(config, signal) {
    const recover = this.autoPreparations.get(config);
    this.autoPreparations.delete(config);
    if (recover === undefined) return super.prepareCall(config, signal);
    let proposed = config;
    while (true) {
      signal?.throwIfAborted();
      try {
        const prepared = await super.prepareCall(proposed, signal);
        signal?.throwIfAborted();
        return prepared;
      } catch (error) {
        signal?.throwIfAborted();
        const next = await recover(error, proposed);
        signal?.throwIfAborted();
        if (next === undefined) throw terminalPreparation(error);
        proposed = next;
      }
    }
  }
}
export default AutoLlmRuntime;
