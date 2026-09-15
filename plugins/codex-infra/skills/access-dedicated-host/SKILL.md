---
name: access-dedicated-host
description: Prepare, validate, resume, and close an owned hardened VM bridge to one explicitly authorized dedicated-host SSH endpoint. Use only when the target, identity, fingerprint, and remote action authority are already explicit.
---

# Access dedicated host through an owned bridge

Use the CodexInfra VM-access tools backed by `VmAccessService`; do not bypass the shared lifecycle with ad hoc VirtualBox or SSH commands.

Confirm the authorized literal target IP, TCP port, SSH user, expected host-key fingerprint, and the guest-only identity and known-hosts paths. Credential material stays inside the guest and outside receipts, vaults, and ordinary evidence. Also collect the owned resource/owner IDs, powered-off secmaint-prepared base, distinct clone name, storage root, tool paths, loopback host SSH endpoint, and verified guest fingerprint. The base must have no shared folders or forwarding rules; do not substitute an unverified generic image or invent guest helpers.

Use `profile: bridge`. Run `preview`, then `prepare`, `inspect`, `start`, and `validate`. Validation must first prove the guest baseline, then require exactly one known-hosts record for each explicit endpoint and match that record's key fingerprint, replace the guest egress allowlist with the one literal endpoint through the existing `sudo -n /usr/local/sbin/secmaint-target replace` contract, and perform the exact SSH probe. Both SSH layers use `-F none`, `GlobalKnownHostsFile=none`, strict host checking, no agent forwarding, and the explicit identities. Do not treat port reachability, clone, or VM start as authenticated target access.

After successful current validation and only for the already authorized interactive maintenance session, call MCP `vm_access_session_command` with `input: {resourceId, ownerId}` or CLI `node dist/src/cli.js vm-access session-command --file SELECTOR.json`. Both call `VmAccessService.sessionCommand`. Execute exactly its returned SSH executable and argument array interactively, preserving argument boundaries and without logging the command. This opens the guest and then the exact dedicated endpoint with the same controls and guest-only credential. It does not authorize a different endpoint or remote action. Run validation immediately before requesting the session command, including after any start/restart.

An identical retry resumes the owned resource. Ownership or immutable-config conflicts fail closed. A new endpoint, identity, authority, or materially different remote action requires the corresponding explicit authorization; this skill does not reapprove or expand an authorization that already exists.

Call `close` after the authorized session and require observed poweroff. The service preserves the clone and never unregisters, deletes, or mutates an unrelated VM. Formal bootstrap remains optional unless separately selected for that case.

API and state details: `docs/VM-ACCESS.md`.
