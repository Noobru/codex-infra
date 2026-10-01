# CodexInfra

A local work infrastructure for Codex: project context, persistent tasks, bounded execution, workflows, evidence, and executable learning monitored through a dashboard. Version 0.6.0 turns substantiated findings into reviewed, tested capabilities activated under the owner's permanent policy. Each version has a hash for use and deactivation.

The workflow starts with conversation and discovery. When engineering work is formalized or executed, the coordinator loads the coding vault and its contracts, applies G-IDEIA, maintains the PRD/PREVC and relevant technical references, chooses between direct execution, an isolated task, or a workflow, validates the result, and writes it back. The dashboard is the query layer for this process.

**This distribution assumes that an equivalent coding vault is already available**, containing curated practices and agent contracts. It is the basic source of truth for engineering and must be configured for each recipient. The existing G-IDEIA is preserved; when it is missing, the complementary bootstrap allows it to be adopted with its method and templates. The package does not include the author's personal vault or create an empty replacement for it. See [Context Contract](docs/CONTEXT-CONTRACT.md) before the first engineering task.

## What is included in this distribution

Version 0.8.0 adds the `prepare-audit-vm` and `access-dedicated-host` skills, with a shared lifecycle for VirtualBox clones and authorized SSH bridges. Approval receipts distinguish client-side refusals from refusals by the tool. See [VMs and Bridges](docs/VM-ACCESS.md) and [Approval Diagnostics](docs/APPROVAL-DIAGNOSTICS.md).

| Capability | Available behavior |
|---|---|
| Context | Explicit profiles, sources with provenance, task-based selection, and a local link graph. |
| Execution | SQLite state, named checks, attempts, cancellation, recovery, and isolated worktrees. |
| Coordination | Worker and model limits, dependency DAGs, evidence handoffs, and bounded replanning. |
| Learning | Findings and observed rework generate bundles with independent review, isolated tests, policy-based activation, and hash-based deactivation. Real invocations have receipts. |
| Evaluation | Completed checks generate compatible evaluations. Efficiency tracks problems, improvements, context inclusion, and subsequent results with evidence. |
| History | 7/14/30/90-day windows, separated sources, and tokens per complete turn with optional local telemetry. No transcripts are stored in receipts. |
| Security | Report reading, optional OSV/KEV enrichment, and GitHub publishing with authorization by destination/SHA. |
| Observation | Six screens over the actual state, with navigation to tasks/evidence and an alert when the loaded backend differs from the installed build. |
| Integration | CLI and MCP share the same core. Plugin and adoption instructions are included with the code. |

## Initial installation on Windows

Requires Windows 11, Node.js 22.16 or newer, npm, Git, and Codex Desktop with access to Codex, as well as the coding vault and compatible contracts described above. PowerShell 7 and Python 3 are required only for the personal plugin installer. Codex runs natively on Windows and does not require WSL. Generated capabilities run using an already-running Docker installation and pinned local Node/Python images. The rest of the infrastructure does not depend on this adapter or on an external database.

From the repository folder:

```powershell
npm ci
npm run build
npm --prefix ui ci
npm --prefix ui run build
node scripts/Configure-Local.mjs
node dist/src/cli.js doctor --project codex-infra
npm run verify
```

`Configure-Local` registers only this copy of the infrastructure, using paths discovered on the current computer. It preserves existing records, generates the local MCP configuration ignored by Git, and initially applies 2 workers, with up to 1 model running simultaneously. This bootstrap and `doctor` verify the installation; they do not attest that the vault or a project is ready for engineering. Each user configures their own sources and maintains their own state and authentication.

Prepare `bootstrap.local.json` with the existing vault and, optionally, project data as described in [Context Contract](docs/CONTEXT-CONTRACT.md). The G-IDEIA bootstrap supports preview and explicit application:

```powershell
node scripts/Bootstrap-GIdeia.mjs --input bootstrap.local.json
node scripts/Bootstrap-GIdeia.mjs --input bootstrap.local.json --apply
```

Preview mode does not write to disk or execute the project. Applying it preserves existing instructions, adopts the complementary contract when necessary, and can create the project's documentation structure and profile. Generated documents still require content and review. Their creation does not declare Planning, execution, or validation complete.

Install the personal plugin after configuration:

```powershell
pwsh -NoProfile -File scripts/Install-PersonalPlugin.ps1
```

The installer reuses the `plugin-creator` helpers provided by Codex. If they are not available, use the MCP configuration generated at `plugins/codex-infra/.mcp.json` in the client and follow [Installation and Operation](docs/USO.md). Open a new task in the client so it loads the updated plugin.

To make this path the default for your work, ask Codex to incorporate [the adoption instruction](docs/ADOPTION.md) into your existing global contract. The installer does not replace your instructions or automatically import your conversations. The bootstrap creates `docs/LOCAL-ADOPTION.md`, ignored by Git, containing the root of this installation for that adjustment.

## First use

Ask:

**“Load the contract from my coding vault, locate the canonical PRD/PREVC for this project, and register its sources and checks in the infrastructure.”**

Check the root, sources, permissions, and commands. Then use concrete objectives, for example:

**“In the example project, fix the input validation within the existing requirement and confirm it with the registered test.”**

For an existing project, reuse and update the canonical PRD/PREVC. A small bug does not require creating another PRD for every task. For a new idea, conversation and discovery come before the proportional formalization required by G-IDEIA. Recording the conversation does not replace this contract or authorize implementation.

Selecting a project without an objective only loads context. Direct execution remains available for simple work; persistence and workers are introduced when they help with execution, resumption, or isolation. Publishing, merging, and deployment retain their own authorization boundaries.

For automatic learning, the owner configures their permanent authorization once according to [Executable Learning](docs/AUTONOMOUS-LEARNING.md). Each improvement then goes through review and testing without requiring individual approval again.

To open the temporary dashboard:

```powershell
node dist/src/cli.js observe --port 4317 --timeout 7200000
```

Open the loopback address displayed in the terminal. The dashboard queries state; its cards do not start tasks.

After an update, Refresh does not replace the code loaded by the backend. If the dashboard indicates a version/fingerprint mismatch, restart only the `observe` process for that installation after local validation. [Installation and Operation](docs/USO.md) explains the restart procedure and distinguishes non-applicable fields from missing metrics.

The agent records material results and `findings` through the operational entry point. Under an enabled policy, findings and observed rework go through synthesis, independent review, isolated testing, and automatic activation. Efficiency displays the case, version, hash, real executions, and their results. To prevent future use, provide the agent with the hash to deactivate. Dashboard queries do not start these jobs; maintenance begins from authorized activity and uses the shared queue limits.

To track tokens over multiple weeks, declare `performanceScope` during the interaction and optionally enable local counter telemetry. History separates project/class/language, presents averages per complete turn or daily totals, and preserves missing fields. Explicit application of a release can be linked to a turn to compare before/after within a compatible scope. Receipts do not store transcripts or convert tokens into subscription quota. [Interactions and Continuity](docs/INTERACTIONS.md) explains the recording mechanism; [Installation and Operation](docs/USO.md) explains optional configuration and queries.

## Expected benefits and changes in workflow

The goal is to reduce context reconstruction, rework, and manual supervision, while making better use of the available quota. **These are still unverified benefit hypotheses**: there is no established percentage for savings, productivity gains, or quality improvements for this distribution.

The mechanism and the new workflow are detailed in [Proposal and Hypotheses](docs/PROPOSTA.md). Continued use will show whether these changes actually help with your work; the evidence records make it possible to compare experiences without turning estimates into measurements.

## Documentation

- [Installation, registration, commands, and recovery](docs/USO.md)
- [Executable learning, policy, and hash-based deactivation](docs/AUTONOMOUS-LEARNING.md)
- [Vault, G-IDEIA, and required sources](docs/CONTEXT-CONTRACT.md)
- [How the personal workflow changes](docs/PROPOSTA.md)
- [Adoption in the agent contract](docs/ADOPTION.md)
- [Interactions, findings, and continuity](docs/INTERACTIONS.md)
- [Privacy and distribution](docs/DISTRIBUICAO.md)
- [Architecture and code reference](docs/ARQUITETURA.md)
- [Provenance and dependencies](THIRD_PARTY_NOTICES.md)
- [Terms of use for original code](LICENSE)

This repository contains sanitized code and examples. Real profiles, conversations, credentials, vaults, histories, private reports, and recovery copies remain outside Git.
