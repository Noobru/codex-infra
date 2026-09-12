import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvidenceSanitizer } from './evidence.js';
import { atomicWriteJson, resolveRealSubPath } from './legacy/command-os-utils.js';
import {
  SecurityGateReceiptSchema, SecurityIsoDateSchema, SecurityShaSchema, SecurityStageSchema,
  type SecurityGateReceipt,
} from './security-gate.js';
import type { Profile } from './registry.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/);
const safeText = z.string().trim().min(1).max(2000)
  .transform(value => EvidenceSanitizer.text(value, 2000));
const relativeArtifact = z.string().regex(/^artifacts\//);

export const SecurityPublicationAuthorizationSchema = z.object({
  granted: z.literal(true),
  action: z.literal('publish-security-status'),
  projectId: identifier,
  publisherId: identifier,
  target: safeText,
  sha: SecurityShaSchema,
  stage: SecurityStageSchema,
  authorizedBy: safeText,
  evidence: safeText,
  authorizedAt: SecurityIsoDateSchema,
  expiresAt: SecurityIsoDateSchema,
});
export type SecurityPublicationAuthorization = z.output<typeof SecurityPublicationAuthorizationSchema>;

export const SecurityPublicationRequestSchema = z.object({
  mode: z.enum(['dry-run','publish']).default('dry-run'),
  publisherId: identifier.optional(),
  authorization: SecurityPublicationAuthorizationSchema.optional(),
}).default({ mode: 'dry-run' });
export type SecurityPublicationRequest = z.output<typeof SecurityPublicationRequestSchema>;

export const SecurityStatusProposalSchema = z.object({
  version: z.literal(1),
  publisherId: identifier,
  kind: z.literal('github-check'),
  target: safeText,
  projectId: identifier,
  sha: SecurityShaSchema,
  stage: SecurityStageSchema,
  decision: SecurityGateReceiptSchema.shape.decision,
  blocking: z.boolean(),
  reportHash: SecurityGateReceiptSchema.shape.reportHash,
  summary: safeText,
});
export type SecurityStatusProposal = z.output<typeof SecurityStatusProposalSchema>;

export const SecurityExternalPublicationReceiptSchema = z.object({
  externalId: safeText,
  publishedAt: SecurityIsoDateSchema,
  url: z.string().url().max(2048).optional(),
});
export type SecurityExternalPublicationReceipt = z.output<typeof SecurityExternalPublicationReceiptSchema>;

export const LocalSecurityGateReceiptSchema = z.object({
  policyVersion: z.literal('security-local-exit-v1'),
  stage: SecurityStageSchema,
  decision: SecurityGateReceiptSchema.shape.decision,
  blocking: z.boolean(),
  exitCode: z.union([z.literal(0), z.literal(2)]),
});
export type LocalSecurityGateReceipt = z.output<typeof LocalSecurityGateReceiptSchema>;

export const SecurityGateStoredReceiptSchema = SecurityGateReceiptSchema.extend({
  receiptId: z.uuid(),
  projectId: identifier,
  recordedAt: SecurityIsoDateSchema,
  artifactPath: relativeArtifact,
  localGate: LocalSecurityGateReceiptSchema,
  integrationRequired: z.boolean().default(false),
});
export type SecurityGateStoredReceipt = z.output<typeof SecurityGateStoredReceiptSchema>;

export const SecurityPublicationIntentReceiptSchema = z.object({
  version: z.literal(1),
  gateReceiptId: z.uuid(),
  projectId: identifier,
  publisherId: identifier,
  createdAt: SecurityIsoDateSchema,
  idempotencyKey: safeText,
  artifactPath: relativeArtifact,
  proposal: SecurityStatusProposalSchema,
  authorization: SecurityPublicationAuthorizationSchema,
});
export type SecurityPublicationIntentReceipt = z.output<typeof SecurityPublicationIntentReceiptSchema>;

export const SecurityPublicationResultReceiptSchema = z.object({
  version: z.literal(1),
  gateReceiptId: z.uuid(),
  mode: z.enum(['dry-run','publish']),
  status: z.enum(['not-configured','dry-run','authorization-required','published','failed']),
  completedAt: SecurityIsoDateSchema,
  artifactPath: relativeArtifact,
  publisherId: identifier.nullable(),
  proposal: SecurityStatusProposalSchema.nullable(),
  intentArtifactPath: relativeArtifact.nullable(),
  externalReceipt: SecurityExternalPublicationReceiptSchema.nullable(),
  error: z.string().max(2000).nullable(),
});
export type SecurityPublicationResultReceipt = z.output<typeof SecurityPublicationResultReceiptSchema>;

export type SecurityPublisherConfig = NonNullable<Profile['securityPublisher']>;
export interface SecurityStatusPublisher {
  readonly id: string;
  readonly kind: SecurityPublisherConfig['kind'];
  propose(input: {
    projectId: string;
    config: SecurityPublisherConfig;
    gate: SecurityGateStoredReceipt;
  }): SecurityStatusProposal;
  publish(
    proposal: SecurityStatusProposal,
    options: { idempotencyKey: string; intentArtifactPath: string },
  ): Promise<SecurityExternalPublicationReceipt>;
}

export class LocalSecurityGateAdapter {
  map(gate: SecurityGateReceipt): LocalSecurityGateReceipt {
    return LocalSecurityGateReceiptSchema.parse({
      policyVersion: 'security-local-exit-v1',
      stage: gate.subject.stage,
      decision: gate.decision,
      blocking: gate.blocking,
      exitCode: gate.blocking ? 2 : 0,
    });
  }
}

export class SecurityReceiptStore {
  constructor(private readonly root: string) {}

  async recordGate(projectId: string, gate: SecurityGateReceipt, localGate: LocalSecurityGateReceipt, integrationRequired = false): Promise<SecurityGateStoredReceipt> {
    const receiptId = randomUUID();
    const directory = await this.ownedDirectory('artifacts/security-gates');
    const file = path.join(directory, receiptId + '.json');
    const artifactPath = this.relative(file);
    const receipt = SecurityGateStoredReceiptSchema.parse({
      ...gate, receiptId, projectId, recordedAt: new Date().toISOString(), artifactPath, localGate, integrationRequired,
    });
    await atomicWriteJson(file, receipt);
    return receipt;
  }

  async recordIntent(input: Omit<SecurityPublicationIntentReceipt, 'createdAt'|'artifactPath'>): Promise<SecurityPublicationIntentReceipt> {
    const directory = await this.ownedDirectory('artifacts/security-publications');
    const file = path.join(directory, input.gateReceiptId + '.intent.json');
    const receipt = SecurityPublicationIntentReceiptSchema.parse({
      ...input, createdAt: new Date().toISOString(), artifactPath: this.relative(file),
    });
    await atomicWriteJson(file, receipt);
    return receipt;
  }

  async recordPublicationResult(input: Omit<SecurityPublicationResultReceipt, 'completedAt'|'artifactPath'>): Promise<SecurityPublicationResultReceipt> {
    const directory = await this.ownedDirectory('artifacts/security-publications');
    const file = path.join(directory, input.gateReceiptId + '.result.json');
    const receipt = SecurityPublicationResultReceiptSchema.parse({
      ...input, completedAt: new Date().toISOString(), artifactPath: this.relative(file),
    });
    await atomicWriteJson(file, receipt);
    return receipt;
  }

  private async ownedDirectory(relative: string): Promise<string> {
    const directory = path.join(this.root, relative);
    await fs.mkdir(directory, { recursive: true });
    const owned = await resolveRealSubPath(directory, this.root);
    if (!owned) throw new Error('Security receipt directory must remain inside the infrastructure root');
    return owned;
  }

  private relative(file: string): string {
    return path.relative(this.root, file).split(path.sep).join('/');
  }
}

export function hasExactPublicationAuthority(
  authorization: SecurityPublicationAuthorization | undefined,
  gate: SecurityGateStoredReceipt,
  proposal: SecurityStatusProposal,
  now = Date.now(),
): boolean {
  if (!authorization) return false;
  return authorization.action === 'publish-security-status'
    && authorization.projectId === gate.projectId
    && authorization.publisherId === proposal.publisherId
    && authorization.target === proposal.target
    && authorization.sha.toLowerCase() === gate.subject.sha.toLowerCase()
    && authorization.stage === gate.subject.stage
    && Date.parse(authorization.authorizedAt) <= now
    && Date.parse(authorization.expiresAt) > now;
}
