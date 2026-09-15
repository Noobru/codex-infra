---
name: prepare-audit-vm
description: Prepare, inspect, validate, resume, and close an owned audit VM cloned from an explicitly named prepared VirtualBox base. Use for an authorized local audit-VM lifecycle; not for adopting existing VMs or contacting dedicated hosts.
---

# Prepare audit VM

Use the CodexInfra VM-access tools backed by `VmAccessService`; do not recreate VirtualBox commands in the skill.

Collect an explicit resource/owner ID, powered-off base VM, distinct clone name, storage root, and local tool paths. Select the `offline` profile; do not provide host SSH settings because this profile has no NIC. The base must have no shared folders or forwarding rules. Do not put private-key contents, passwords, tokens, or raw credentials in input or evidence.

Run `preview` first. Resolve name/ownership/config/UUID conflicts rather than adopting or replacing a VM. Then run `prepare`, inspect the observed VM, start it, and run `validate`. Offline validation proves from VirtualBox that NICs 1-8 and host integrations are disabled; it reports guest readiness as unknown and performs no guest probe. Clone or start success is not readiness.

Repeat the same request to resume owned failed preparation only when the persisted clone UUID still matches. A clone that appeared after interruption but has no persisted UUID is not adopted. Do not change immutable configuration under the same resource ID. When the authorized work ends, call `close`; offline close uses VirtualBox ACPI and requires observed poweroff. Preserve the clone unless deletion is separately and explicitly authorized.

This ordinary capability does not require or activate the formal audit bootstrap. Never infer authorization for a remote target from creation of the local VM.

API and state details: `docs/VM-ACCESS.md`.
