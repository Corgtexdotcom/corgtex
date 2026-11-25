# Delivery validation

The delivery owner validates the integrated outcome before merging. A separate
review is optional when a concrete question warrants a second opinion.

1. Check the current diff and CI against the requested outcome.
2. Exercise changed behavior where existing tests do not cover it. Check usability
   for visible changes and auth, tenant, secrets, data, or recovery when affected.
3. Fix concrete blockers in the same PR. Recheck changed behavior after fixes and
   reuse existing evidence. Do not add tests or split work just to satisfy a form.
4. Merge the current head after required CI passes and conversations are resolved.
   Keep a short record of acceptance, validation, and material risks or rollback.

Use the Corgtex merge accounts listed in `AGENTS.md`. Review comments are welcome
but are not required. Production release authorization and verification are separate.
