# VM access lifecycle

`VmAccessService` is the shared implementation for an owned VirtualBox clone and, when requested, an SSH bridge to one explicit dedicated-host target. CLI and MCP commands should remain thin adapters over the exported schemas and lifecycle methods in `src/vm-access.ts`.

This capability does not activate or require a formal audit bootstrap for ordinary authorized work. It also does not grant authority to contact a remote host, change an existing VM, merge, deploy, or operate a product.

## Safety model

- The caller names the preserved base VM, clone, storage root, resource ID and owner ID. The service never adopts an existing VM without its own state.
- `prepare` rejects bases with shared folders or forwarding rules, performs a full machine clone, persists its UUID before configuration, disables host integrations and NICs 2-8, and then applies the selected NIC 1 profile.
- `offline` sets NIC 1 to `none`; it has no host SSH configuration and no guest probe. `bridge` uses NAT plus one loopback-only host SSH forward and admits one literal target through the prepared guest's existing `/usr/local/sbin/secmaint-target` contract.
- Host-to-guest and guest-to-target SSH require exactly one known-hosts record matching the explicit endpoint and compare that record's key fingerprint. Both layers use `-F none`, `GlobalKnownHostsFile=none`, strict host checking, explicit identities, and no agent forwarding. Dedicated key material remains inside the guest and is never copied to state or receipts.
- `close` targets only the UUID bound to owned state. Offline close sends a VirtualBox ACPI power-button event; bridge close requests guest shutdown over strict SSH. Both poll for observed poweroff, preserve the clone, and never delete or unregister it.

The bridge clone inherits the prepared secmaint base's guest contents. The base therefore needs the existing hardened `secmaint-self-test` and `secmaint-target` commands and clone-safe host identity handling. A caller must provision and verify each clone's host key out of band before validation; clone/start success is not guest readiness. Offline validation deliberately reports `guestReady: null` because a NIC-less guest is not probed.

## API

```ts
const service = new VmAccessService(infraRoot);

await service.preview({config});
await service.prepare({config});
await service.inspect({resourceId, ownerId});
await service.start({resourceId, ownerId});
await service.validate({resourceId, ownerId});
const session = await service.sessionCommand({resourceId, ownerId}); // bridge only, after current validation
await service.close({resourceId, ownerId});
await service.reconcileCleanup({resourceId, ownerId, evidence}); // only after actual process/host inspection
```

Exported input and result schemas are named `VmAccess*Schema`. `VmAccessHostAdapter` allows fixture or provider-specific implementations without duplicating lifecycle, ownership, state, receipt, or recovery rules. The production adapter is `VirtualBoxVmAccessHost` and executes commands with `ProcessRunner` without a shell.

Minimal offline config:

```json
{
  "resourceId": "audit-slice-001",
  "ownerId": "authorized-task-001",
  "baseVmName": "prepared-audit-base",
  "vmName": "audit-slice-001",
  "profile": "offline",
  "storageRoot": "<absolute-storage-root>",
  "tools": {
    "vboxManagePath": "<absolute-VBoxManage-executable>",
    "sshPath": "<absolute-ssh-executable>",
    "sshKeygenPath": "<absolute-ssh-keygen-executable>"
  }
}
```

For `profile: "bridge"`, add both host-to-guest SSH and target settings:

```json
{
  "hostSsh": {
    "host": "127.0.0.1",
    "port": 22222,
    "user": "secmaint",
    "identityFile": "<absolute-guest-identity-file>",
    "knownHostsFile": "<absolute-guest-known-hosts-file>",
    "expectedHostKeyFingerprint": "SHA256:replace-with-verified-fingerprint"
  },
  "bridge": {
    "targetHost": "192.0.2.10",
    "targetPort": 22,
    "targetUser": "operator",
    "guestIdentityFile": "/var/lib/secmaint/.ssh/dedicated_ed25519",
    "guestKnownHostsFile": "/var/lib/secmaint/.ssh/dedicated_known_hosts",
    "expectedHostKeyFingerprint": "SHA256:replace-with-out-of-band-fingerprint"
  }
}
```

`targetHost` must be a literal address. DNS names are rejected so the guest egress rule and SSH destination describe the same endpoint.

## Lifecycle and recovery

1. `preview` is read-only. It checks schema, desired hash, ownership, and name collisions.
2. `prepare` writes owned state before cloning and persists the observed clone UUID before any later mutation. A failed prepare resumes only when that UUID matches; an interrupted clone with no persisted UUID fails closed rather than adopting the same-name VM. A changed config is a conflict.
3. `start` verifies UUID, NICs, forwards and disabled integrations before starting. It rejects `failed` state; invoking it on an already running VM downgrades stale `validated` state to `running`.
4. `validate` always checks exact VirtualBox configuration. Offline returns readiness unknown without SSH. Bridge additionally proves the guest baseline, exact endpoint-bound fingerprints, one endpoint allowlist and `ssh ... true` to the target.
5. `sessionCommand` is bridge-only and returns a fixed interactive two-hop SSH command only while the owned UUID is running and currently `validated`; it does not execute arbitrary remote commands.
6. `close` confirms poweroff after ACPI (offline) or guest shutdown (bridge). Repeating a completed close is a no-op.

Failures update `artifacts/vm-access/resources/<resourceId>/state.json` and create an immutable sanitized receipt under `artifacts/integration/vm-access/<resourceId>/`. Receipts contain hashes, observations, probe outcomes and credential-material absence; they omit identity and known-hosts paths. If a spawned VirtualBox or SSH command reports `cleanupFailed`, `prepare`, `start`, `validate`, or `close` returns a structured failed result with `cleanupFailed: true` and `lockRetained: true`; both fields are persisted in state and receipt. If state/receipt persistence itself fails, the retained lock receives a bounded `.cleanup-pending.json` owner marker and remains fail-closed. The lock has its own exact owner record and blocks every later lifecycle mutation. Only `reconcileCleanup`/`reconcile_vm_access_cleanup`, using the same `{resourceId, ownerId}` and bounded evidence from an actual process inspection or confirmed host restart, releases it. Reconciliation writes its receipt and state before removing the lock; when no state survived, it does not inspect or invent a VM/configuration and returns `state: null`, `desiredHash: null`, and `observationUnavailable: true`. Reconciliation never infers cleanup from a missing PID or changes VM state.

## Validation boundary

The module's focal tests use a disposable root and fake adapters. Integration on 2026-09-15 additionally exercised real VirtualBox preparation/reuse/offline configuration/close of an empty powered-off fixture, preserving the base and cleaning both test machines. No guest OS was booted by that integration. A real Windows OpenSSH client authenticated to a loopback synthetic guest through the shared adapter and rejected a changed host key and mismatched fingerprint; the dedicated-target response was simulated, with no traffic to that target. Integration receipts remain in the originating local installation and are not distributed. Boot, guest ACPI shutdown, firewall implementation and a real dedicated session remain environment-specific checks when the skill is used.

CLI: `node dist/src/cli.js vm-access preview|prepare|inspect|start|validate|close|reconcile-cleanup|session-command --file INPUT.json`. Preview/prepare inputs wrap `{config}`; lifecycle selectors are `{resourceId,ownerId}`; reconciliation adds bounded `evidence`. MCP exposes the lifecycle tools, `reconcile_vm_access_cleanup`, and read-only `vm_access_session_command`; each accepts the same object inside `input`. The session command returns executable/args and opens nothing itself. Validate immediately before using it.

VirtualBox machine-readable fields are checked using the observed `ehci`, `xhci`, `recording_enabled` names (legacy aliases also supported), CRLF and explicit disabled clipboard file transfer/audio. A shared configuration guard serves preparation, validation and session creation.

## Guest prerequisites

The bridge requires an explicitly prepared base providing `secmaint-self-test` and `secmaint-target`. These environment-specific guest provisioning helpers are not included in this distribution. Resolve all placeholder paths locally before preparing a VM.
