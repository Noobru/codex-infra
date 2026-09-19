/** A shared abort reason: elapsed execution budget is not an owner cancellation. */
export class ExecutionStop extends Error {
  constructor(readonly kind: 'deadline' | 'cancelled') {
    super(kind === 'deadline'
      ? 'Execution deadline exceeded; inspect attempt evidence before an explicit retry.'
      : 'Execution cancelled by its owner.');
    this.name = 'ExecutionStop';
  }

  static fromSignal(signal?: AbortSignal): ExecutionStop {
    return signal?.reason instanceof ExecutionStop ? signal.reason : new ExecutionStop('cancelled');
  }

  get status(): 'failed' | 'cancelled' { return this.kind === 'deadline' ? 'failed' : 'cancelled'; }
  get commandError(): 'timeout' | 'cancelled' { return this.kind === 'deadline' ? 'timeout' : 'cancelled'; }
}
