import type { TaskQualification } from '../src/routing.js';

export const fixtureQualification: TaskQualification = {
  taskClass: 'retrieval', complexity: 'low', uncertainty: 'low', risk: 'low', bounded: true,
  independentlyVerifiable: true, contextCoupling: 'low', delegationBenefit: 'expected',
  rationale: 'Inspect a bounded synthetic fixture; independent acceptance is checked by the test harness.',
};
