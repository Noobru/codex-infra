import path from 'node:path';
import { z } from 'zod';
import { EvidenceSanitizer } from './evidence.js';
import { ProjectRegistry, type Profile } from './registry.js';
import { resolveRealSubPath } from './legacy/command-os-utils.js';
import { SecurityGateInputSchema, SecurityPolicyGate } from './security-gate.js';
import {
  LocalSecurityGateAdapter,
  SecurityExternalPublicationReceiptSchema,
  SecurityPublicationRequestSchema,
  SecurityReceiptStore,
  SecurityStatusProposalSchema,
  hasExactPublicationAuthority,
  type SecurityGateStoredReceipt,
  type SecurityPublicationRequest,
  type SecurityPublicationResultReceipt,
  type SecurityStatusProposal,
  type SecurityStatusPublisher,
} from './security-report-publisher.js';

export const SecurityReportRequestSchema = SecurityGateInputSchema.extend({
  publication: SecurityPublicationRequestSchema,
});
export type SecurityReportRequest = z.input<typeof SecurityReportRequestSchema>;
export type SecurityReportResult = SecurityGateStoredReceipt & {
  publication: SecurityPublicationResultReceipt;
  commandExitCode: 0|2|3;
};

export class SecurityReportService {
  private readonly gate: SecurityPolicyGate;
  private readonly localGate: LocalSecurityGateAdapter;
  private readonly store: SecurityReceiptStore;
  private readonly publishers: Map<string,SecurityStatusPublisher>;
  private readonly integrationRequired: boolean;

  constructor(
    private readonly root: string,
    private readonly registry: ProjectRegistry,
    options: {
      gate?: SecurityPolicyGate;
      localGate?: LocalSecurityGateAdapter;
      publishers?: readonly SecurityStatusPublisher[];
      integrationRequired?: boolean;
    } = {},
  ) {
    this.gate = options.gate ?? new SecurityPolicyGate();
    this.localGate = options.localGate ?? new LocalSecurityGateAdapter();
    this.store = new SecurityReceiptStore(root);
    this.integrationRequired = options.integrationRequired ?? false;
    this.publishers = new Map();
    for (const publisher of options.publishers ?? []) {
      if (this.publishers.has(publisher.id)) throw new Error('Duplicate security publisher: ' + publisher.id);
      this.publishers.set(publisher.id, publisher);
    }
  }

  async evaluate(project: string, rawInput: SecurityReportRequest): Promise<SecurityReportResult> {
    const request = SecurityReportRequestSchema.parse(rawInput);
    const { publication, ...rawGateInput } = request;
    const input = SecurityGateInputSchema.parse(rawGateInput);
    const profile = await this.registry.resolve(project);
    const reportPath = await resolveRealSubPath(path.resolve(profile.root, input.reportPath), profile.root);
    if (!reportPath) throw new Error('Security report is missing or outside the selected project root');

    const gate = await this.gate.evaluateReport({ ...input, reportPath });
    const localGate = this.localGate.map(gate);
    const stored = await this.store.recordGate(profile.id, gate, localGate, this.integrationRequired);
    const publicationReceipt = await this.handlePublication(profile, publication, stored);
    const publicationFailed = publication.mode === 'publish' && publicationReceipt.status !== 'published';
    return {
      ...stored,
      publication: publicationReceipt,
      commandExitCode: publicationFailed ? 3 : localGate.exitCode,
    };
  }

  private async handlePublication(
    profile: Profile,
    request: SecurityPublicationRequest,
    gate: SecurityGateStoredReceipt,
  ): Promise<SecurityPublicationResultReceipt> {
    const config = profile.securityPublisher;
    const selectedId = request.publisherId ?? config?.id;
    const publisher = config?.enabled && selectedId === config.id
      && config.stages.includes(gate.subject.stage) ? this.publishers.get(config.id) : undefined;

    if (!config || !publisher || publisher.id !== config.id || publisher.kind !== config.kind) {
      return this.store.recordPublicationResult({
        version: 1, gateReceiptId: gate.receiptId, mode: request.mode, status: 'not-configured',
        publisherId: null, proposal: null, intentArtifactPath: null, externalReceipt: null,
        error: 'No enabled publisher adapter is configured for this project and stage.',
      });
    }

    const proposal = SecurityStatusProposalSchema.parse(publisher.propose({
      projectId: profile.id, config, gate,
    }));
    this.assertProposalBinding(profile, config, gate, proposal);

    if (request.mode === 'dry-run') {
      return this.store.recordPublicationResult({
        version: 1, gateReceiptId: gate.receiptId, mode: request.mode, status: 'dry-run',
        publisherId: publisher.id, proposal, intentArtifactPath: null, externalReceipt: null, error: null,
      });
    }

    const authorization = request.authorization;
    if (!authorization || !hasExactPublicationAuthority(authorization, gate, proposal)) {
      return this.store.recordPublicationResult({
        version: 1, gateReceiptId: gate.receiptId, mode: request.mode, status: 'authorization-required',
        publisherId: publisher.id, proposal, intentArtifactPath: null, externalReceipt: null,
        error: 'External publication requires fresh explicit authority bound to publisher, target, project, SHA and stage.',
      });
    }

    const idempotencyKey = 'security-gate/' + gate.receiptId;
    const intent = await this.store.recordIntent({
      version: 1, gateReceiptId: gate.receiptId, projectId: profile.id,
      publisherId: publisher.id, idempotencyKey, proposal, authorization,
    });
    try {
      const externalReceipt = SecurityExternalPublicationReceiptSchema.parse(await publisher.publish(proposal, {
        idempotencyKey, intentArtifactPath: intent.artifactPath,
      }));
      return this.store.recordPublicationResult({
        version: 1, gateReceiptId: gate.receiptId, mode: request.mode, status: 'published',
        publisherId: publisher.id, proposal, intentArtifactPath: intent.artifactPath,
        externalReceipt, error: null,
      });
    } catch (error) {
      return this.store.recordPublicationResult({
        version: 1, gateReceiptId: gate.receiptId, mode: request.mode, status: 'failed',
        publisherId: publisher.id, proposal, intentArtifactPath: intent.artifactPath,
        externalReceipt: null,
        error: EvidenceSanitizer.text(error instanceof Error ? error.message : String(error), 2000),
      });
    }
  }

  private assertProposalBinding(
    profile: Profile,
    config: NonNullable<Profile['securityPublisher']>,
    gate: SecurityGateStoredReceipt,
    proposal: SecurityStatusProposal,
  ): void {
    if (proposal.publisherId !== config.id || proposal.kind !== config.kind
      || proposal.target !== config.target || proposal.projectId !== profile.id
      || proposal.sha.toLowerCase() !== gate.subject.sha.toLowerCase()
      || proposal.stage !== gate.subject.stage || proposal.decision !== gate.decision
      || proposal.blocking !== gate.blocking || proposal.reportHash !== gate.reportHash) {
      throw new Error('Security publisher proposal did not preserve the configured gate binding');
    }
  }
}
