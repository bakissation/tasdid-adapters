# Security Policy

## Supported versions

This project follows semantic versioning. Security fixes are applied to the **latest released minor version** only. Please upgrade before reporting.

## Reporting a vulnerability

**Do not open a public issue or pull request for security vulnerabilities.**

Report privately via GitHub's **Private Vulnerability Reporting**:

1. Go to the [Security tab](https://github.com/bakissation/tasdid-adapters/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, affected version, and reproduction steps.

You'll get an acknowledgement and can track the fix in the private advisory.

## Why this matters here

`@bakissation/tasdid-adapters` mounts the [tasdid](https://github.com/bakissation/tasdid) payment lifecycle as HTTP routes — it moves real money. It's thin glue (validate → call tasdid → map errors → respond), so the security-relevant surface is the route boundary:

- **`refund` and `reconcile` must be guarded.** They're gated by your `authorize` hook; a missing/weak guard would expose refunds or the sweep. In scope: any way to bypass `authorize`.
- **No card data.** The redirect model (SAQ-A) means the adapter never receives a PAN; only the masked `pan` from tasdid's status. In scope: any path that would surface card data or leak gateway internals/credentials in a response or log.
- **Return-URL trust.** `handleReturn` advances state only from tasdid's gateway reconfirmation, never from redirect params. In scope: a way to force a paid state from a crafted return URL.

If you find an input that bypasses a guard, leaks sensitive data, or advances payment state without gateway confirmation, that's in scope.

## Out of scope

- Issues requiring an already-compromised machine.
- Advisories in **dev-only** dependencies (build/test/release toolchain) not reachable at runtime.
- Misconfiguration in the consumer's app (e.g. not setting `authorize`) — documented, not a library bug.
