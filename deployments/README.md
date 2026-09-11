# Deployment instances

One JSON file per **live protocol instance**, named by instance under its network.
Written by the preview deploy harness; read by anything that needs to talk to a
deployed protocol.

```
deployments/preview/alpha2.json    CIP-113 0.5.0-alpha.2   ← the platform points here today
deployments/preview/alpha3.json    CIP-113 0.5.0-alpha.3   ← retained live instance; its 0.8.x source line must be built from git
# No alpha.4 instance record exists in deployments/preview/.
```

## ⛔ These files cannot be regenerated

A deployment record is not a build artifact. Its bootstrap seed UTxOs are
**one-shot and already spent**, so nothing can re-derive one by re-running a
script. A record can be *partially* reconstructed from chain — that was done once,
on 2026-08-31, and it cost a session.

Hence two refusals in `test/harness/instances.mjs`, both deliberate:

- **There is no default instance.** A default is what made "which instance?" an
  invisible question with a silent answer, back when this was a single
  `deployment-preview.json` that both deploy scripts wrote unconditionally.
- **`saveInstance` refuses to overwrite.** Creating an instance and replacing one
  are different intentions and only one of them can destroy a live record.

⚠ That second refusal has a cost worth knowing about: it also blocks *completing*
a half-finished deployment. When the alpha.3 stand-up failed at its third step,
`deploy-preview-all.ts` could not simply be re-run — step one had spent its
one-shot seeds, and the overwrite guard would have refused the record anyway.
The completion path is a separate script (`register-dummy-preview.ts`).
**Every step after the first irreversible one needs to be separately runnable.**

## The instances are not interchangeable

They are different protocols, not versions of one. alpha.3 merged
`registry_mint`+`registry_spend` and the protocol-params pair, reduced the params
datum from seven fields to four, reintroduced the `programmable_logic_global`
dispatcher, and changed three delegate arities.

⇒ **A 0.9.0 SDK targeting alpha.4 cannot build transactions against either live
instance**, and it refuses rather than trying: alpha.2 has a 7-field params datum,
alpha.3 has a 4-field datum, and alpha.4 has six fields with `issuance_logic_cred`
at index 1. Indices 1, 2 and 3 all hold a `Credential`, so an alpha.3 positional
reader returns well-formed values with the wrong meanings after every one of those
slots shifts.

To operate the alpha.2 instance, use a published SDK release from the `0.7.x` line.
No published release operates alpha.3; its `0.8.x` source line must be built from git.

## Usage

```bash
npx tsx test/harness/deploy-preview-all.ts   --instance <name>   # core + FES + dummy
npx tsx test/harness/register-dummy-preview.ts --instance <name> # complete a partial deploy
```

The instance name is resolved **before any chain work**, so a typo fails in a
millisecond rather than after a bootstrap has spent its seeds.

## Not shipped

`files` in `package.json` is an allowlist of `dist` and `blueprints`, so nothing
here reaches the published tarball. These records describe *this project's* test
deployments; a consumer's own `DeploymentParams` is an input they supply.
