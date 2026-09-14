import { InteractionTokenDeltaSchema, type InteractionTelemetryReceipt as Turn } from './interaction-telemetry.js';

type Metric = keyof NonNullable<Turn['tokens']>;
/** One comparison contract for declared knowledge use and executed capabilities. */
export class TurnComparison {
  static readonly metrics = Object.keys(InteractionTokenDeltaSchema.shape) as Metric[];
  static id(turn: Pick<Turn, 'threadId' | 'turnId'>) { return `${turn.threadId}/${turn.turnId}`; }
  static cohort(turn: Turn) {
    return turn.projectId && turn.performanceScope && turn.assignment === 'interaction-revision'
      && turn.modelIdentity?.model && turn.modelIdentity.effort
      ? JSON.stringify([turn.projectId, turn.performanceScope.taskClass, turn.performanceScope.language ?? null,
        turn.performanceScope.problemCategory ?? null, turn.modelIdentity.model, turn.modelIdentity.effort]) : null;
  }
  static complete(turn: Turn) {
    return turn.status === 'complete' && turn.finishedAt !== null && turn.tokens !== null
      && this.metrics.some(metric => turn.tokens![metric] !== null) && turn.coverage.baselineObserved
      && turn.coverage.terminalObserved && !turn.coverage.limited && turn.coverage.counterResets === 0;
  }
  static unique(turns: Turn[]) { return [...new Map(turns.map(turn => [this.id(turn), turn])).values()]; }
  static compare(baseline: Turn[], treatment: Turn[]) {
    const before = this.unique(baseline), after = this.unique(treatment);
    const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value / values.length, 0) : null;
    return this.metrics.map(metric => {
      const b = before.flatMap(turn => turn.tokens?.[metric] == null ? [] : [turn.tokens[metric]!]);
      const a = after.flatMap(turn => turn.tokens?.[metric] == null ? [] : [turn.tokens[metric]!]);
      const baselineMean = mean(b), treatmentMean = mean(a);
      const delta = baselineMean !== null && treatmentMean !== null ? treatmentMean - baselineMean : null;
      return { metric, unit: 'tokens' as const, baselineN: b.length, treatmentN: a.length, baselineMean, treatmentMean,
        delta, deltaPercent: delta !== null && baselineMean !== null && baselineMean !== 0 ? delta / baselineMean * 100 : null };
    });
  }
}
