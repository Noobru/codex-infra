import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { EvidenceSanitizer } from './evidence.js';

const NonEmpty = z.string().trim().min(1).max(500);
export const SecurityIsoDateSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), 'invalid ISO date');
export const SecurityShaSchema = z.string().regex(/^[0-9a-f]{40}$/i);
export const SecurityStageSchema = z.enum(['report', 'ci', 'deploy-production']);

export const SecurityGateInputSchema = z.object({
  reportPath: NonEmpty,
  format: z.enum(['trivy-json', 'cyclonedx-json']),
  subject: z.object({
    asset: NonEmpty,
    environment: NonEmpty,
    sha: SecurityShaSchema,
    stage: SecurityStageSchema,
  }),
  source: z.object({
    name: NonEmpty,
    version: NonEmpty,
    fetchedAt: SecurityIsoDateSchema,
    expiresAt: SecurityIsoDateSchema,
  }),
  assertions: z.array(z.object({
    findingId: NonEmpty,
    kind: z.enum(['applicability', 'reachability', 'exposure']),
    value: z.boolean(),
    source: z.enum(['inventory', 'scanner', 'runtime', 'approved-review', 'model']),
    evidence: NonEmpty,
  })).default([]),
  enrichments: z.array(z.object({
    findingId: NonEmpty,
    knownExploited: z.boolean(),
    source: NonEmpty,
    evidence: NonEmpty,
    expiresAt: SecurityIsoDateSchema,
  })).default([]),
  exceptions: z.array(z.object({
    findingId: NonEmpty,
    asset: NonEmpty,
    environment: NonEmpty,
    sha: SecurityShaSchema,
    authorizedBy: NonEmpty,
    reason: NonEmpty,
    compensatingControl: NonEmpty,
    expiresAt: SecurityIsoDateSchema,
  })).default([]),
  evaluatedAt: SecurityIsoDateSchema.optional(),
});

export type SecurityGateInput = z.input<typeof SecurityGateInputSchema>;
export type SecurityGateDecision = 'PASS'|'WARN'|'BLOCK'|'UNKNOWN'|'EXCEPTION_REQUIRED';
export const NormalizedSecurityFindingSchema = z.object({
  id: z.string(),
  packageName: z.string(),
  installedVersion: z.string(),
  fixedVersion: z.string().nullable(),
  severity: z.enum(['UNKNOWN','LOW','MEDIUM','HIGH','CRITICAL']),
  target: z.string(),
  evidence: z.string(),
});
export type NormalizedSecurityFinding = z.output<typeof NormalizedSecurityFindingSchema>;

export const SecurityGateReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal('security-policy-v1'),
  decision: z.enum(['PASS','WARN','BLOCK','UNKNOWN','EXCEPTION_REQUIRED']),
  blocking: z.boolean(),
  subject: SecurityGateInputSchema.shape.subject,
  source: SecurityGateInputSchema.shape.source,
  reportHash: z.string().regex(/^[0-9a-f]{64}$/),
  findings: z.array(NormalizedSecurityFindingSchema),
  reasons: z.array(z.string()),
  unknowns: z.array(z.string()),
  exceptionsApplied: z.array(z.string()),
  evaluatedAt: SecurityIsoDateSchema,
});
export type SecurityGateReceipt = z.output<typeof SecurityGateReceiptSchema>;

type Assertion = z.output<typeof SecurityGateInputSchema>['assertions'][number];

/** Read-only adapter and deterministic policy for existing vulnerability evidence. */
export class SecurityPolicyGate {
  static readonly maxReportBytes = 16 * 1024 * 1024;

  async evaluateReport(rawInput: SecurityGateInput): Promise<SecurityGateReceipt> {
    const input = SecurityGateInputSchema.parse(rawInput);
    const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
    const now = Date.parse(evaluatedAt);
    const {report, reportHash} = await this.readBoundedReport(input.reportPath);
    const parsed = input.format === 'trivy-json' ? this.parseTrivy(report) : this.parseCycloneDx(report);
    const findings = parsed.findings;
    const reasons: string[] = [];
    const unknowns: string[] = [];
    const exceptionsApplied: string[] = [];
    let knownRisk = false;
    let materialRiskWithoutException = false;
    let unresolvedRisk = false;
    let invalidException = false;

    if (Date.parse(input.source.fetchedAt) > now || Date.parse(input.source.expiresAt) <= now) {
      unknowns.push('source_freshness_unproven');
      unresolvedRisk = true;
    }
    if (input.format === 'cyclonedx-json' && findings.length === 0) {
      unknowns.push('sbom_without_vulnerability_assessment');
      unresolvedRisk = true;
    }
    if (input.format === 'trivy-json' && !parsed.assessmentPresent) {
      unknowns.push('trivy_results_missing_or_empty');
      unresolvedRisk = true;
    }

    for (const finding of findings) {
      const applicability = this.trustedAssertion(input.assertions, finding.id, 'applicability');
      if (applicability === false) {
        reasons.push(`${finding.id}:not_applicable`);
        continue;
      }
      const enrichment = input.enrichments.find(item => item.findingId === finding.id);
      const kev = enrichment?.knownExploited === true && Date.parse(enrichment.expiresAt) > now;
      const enrichmentStale = enrichment?.knownExploited === true && !kev;
      const exposure = this.trustedAssertion(input.assertions, finding.id, 'exposure');
      const reachability = this.trustedAssertion(input.assertions, finding.id, 'reachability');
      const material = kev || finding.severity === 'CRITICAL'
        || (finding.severity === 'HIGH' && exposure === true && reachability === true);
      const needsContext = enrichmentStale || ((enrichment?.knownExploited === true || finding.severity === 'CRITICAL' || finding.severity === 'HIGH')
        && (applicability === undefined || (finding.severity === 'HIGH' && (exposure === undefined || reachability === undefined))));

      if (needsContext) {
        unknowns.push(`${finding.id}:insufficient_trusted_context`);
        unresolvedRisk = true;
        continue;
      }
      if (!material || applicability !== true) continue;
      knownRisk = true;
      const activeException = input.exceptions.find(item => item.findingId === finding.id
        && item.asset === input.subject.asset && item.environment === input.subject.environment
        && item.sha.toLowerCase() === input.subject.sha.toLowerCase() && Date.parse(item.expiresAt) > now);
      if (activeException) {
        exceptionsApplied.push(finding.id);
        reasons.push(`${finding.id}:authorized_exception`);
      } else {
        materialRiskWithoutException = true;
        reasons.push(`${finding.id}:${kev ? 'known_exploited' : finding.severity.toLowerCase()}`);
        invalidException ||= input.exceptions.some(item => item.findingId === finding.id);
      }
    }

    const production = input.subject.stage === 'deploy-production';
    let decision: SecurityGateDecision;
    if (production && materialRiskWithoutException) decision = invalidException ? 'EXCEPTION_REQUIRED' : 'BLOCK';
    else if (production && unresolvedRisk) decision = 'UNKNOWN';
    else if (knownRisk || exceptionsApplied.length > 0) decision = 'WARN';
    else if (unresolvedRisk) decision = 'UNKNOWN';
    else decision = 'PASS';

    return SecurityGateReceiptSchema.parse({
      schemaVersion: 1,
      policyVersion: 'security-policy-v1',
      decision,
      blocking: production && ['BLOCK', 'UNKNOWN', 'EXCEPTION_REQUIRED'].includes(decision),
      subject: input.subject,
      source: input.source,
      reportHash,
      findings,
      reasons: [...new Set(reasons)],
      unknowns: [...new Set(unknowns)],
      exceptionsApplied: [...new Set(exceptionsApplied)],
      evaluatedAt,
    });
  }

  private async readBoundedReport(reportPath: string): Promise<{report: unknown; reportHash: string}> {
    const handle = await fs.open(reportPath, 'r');
    try {
      const size = (await handle.stat()).size;
      if (size > SecurityPolicyGate.maxReportBytes) throw new Error('security_report_too_large');
      const bytes = await handle.readFile();
      if (bytes.byteLength > SecurityPolicyGate.maxReportBytes) throw new Error('security_report_too_large');
      try {
        return {report: JSON.parse(bytes.toString('utf8')) as unknown,
          reportHash: crypto.createHash('sha256').update(bytes).digest('hex')};
      } catch { throw new Error('security_report_invalid_json'); }
    } finally { await handle.close(); }
  }

  private trustedAssertion(assertions: Assertion[], findingId: string, kind: Assertion['kind']): boolean | undefined {
    const values = assertions.filter(item => item.findingId === findingId && item.kind === kind && item.source !== 'model');
    if (values.length === 0) return undefined;
    const distinct = new Set(values.map(item => item.value));
    return distinct.size === 1 ? values[0]!.value : undefined;
  }

  private parseTrivy(raw: unknown): {findings: NormalizedSecurityFinding[]; assessmentPresent: boolean} {
    const schema = z.object({ Results: z.array(z.object({
      Target: NonEmpty,
      Vulnerabilities: z.array(z.object({
        VulnerabilityID: NonEmpty,
        PkgName: NonEmpty,
        InstalledVersion: NonEmpty,
        FixedVersion: z.string().optional(),
        Severity: z.string().optional(),
        Title: z.string().optional(),
      })).optional(),
    })).optional() });
    const report = schema.parse(raw);
    const results = report.Results ?? [];
    return {assessmentPresent: results.length > 0, findings: results.flatMap(result => (result.Vulnerabilities ?? []).map(item => ({
      id: item.VulnerabilityID,
      packageName: item.PkgName,
      installedVersion: item.InstalledVersion,
      fixedVersion: item.FixedVersion?.trim() || null,
      severity: this.severity(item.Severity),
      target: EvidenceSanitizer.text(result.Target, 500),
      evidence: EvidenceSanitizer.text(item.Title ?? `${item.PkgName}@${item.InstalledVersion}`, 1000),
    })))};
  }

  private parseCycloneDx(raw: unknown): {findings: NormalizedSecurityFinding[]; assessmentPresent: boolean} {
    const schema = z.object({
      bomFormat: z.literal('CycloneDX'),
      components: z.array(z.object({ 'bom-ref': z.string().optional(), name: NonEmpty, version: z.string().optional() })).default([]),
      vulnerabilities: z.array(z.object({
        id: NonEmpty,
        ratings: z.array(z.object({ severity: z.string().optional() })).optional(),
        affects: z.array(z.object({ ref: NonEmpty })).optional(),
        description: z.string().optional(),
      })).default([]),
    });
    const report = schema.parse(raw);
    const components = new Map(report.components.map(component => [component['bom-ref'] ?? component.name, component]));
    return {assessmentPresent: report.vulnerabilities.length > 0, findings: report.vulnerabilities.flatMap(vulnerability => (vulnerability.affects ?? [{ref:'unknown'}]).map(affected => {
      const component = components.get(affected.ref);
      return {
        id: vulnerability.id,
        packageName: component?.name ?? affected.ref,
        installedVersion: component?.version ?? 'unknown',
        fixedVersion: null,
        severity: this.severity(vulnerability.ratings?.[0]?.severity),
        target: affected.ref,
        evidence: EvidenceSanitizer.text(vulnerability.description ?? vulnerability.id, 1000),
      };
    }))};
  }

  private severity(value: string | undefined): NormalizedSecurityFinding['severity'] {
    const normalized = value?.toUpperCase();
    return normalized === 'LOW' || normalized === 'MEDIUM' || normalized === 'HIGH' || normalized === 'CRITICAL'
      ? normalized : 'UNKNOWN';
  }
}
