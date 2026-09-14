# PostgreSQL CHECK Representation Proof

Restore evidence1.0.0 still requires exact schema token digests. Evidence2.0.0
adds `PG18_ORDERED_AND_V1` without replacing either raw digest. The validator
recomputes the proof from raw token streams, bounded CHECK trees, catalog
bindings and complete constraint manifests; diagnostic status is not input.

The initial vocabulary admits only ordered associative AND grouping over the
existing pure PG18 bool/int4/text comparison, concatenation and int4-to-text
I/O operations. No OR/NOT regrouping, operand sorting/deduplication, unknown
functions or generic SQL equivalence is accepted. Server patch versions must
match. Type/operator/function/attribute/collation bindings must match; locale
versions must be current. Candidate identity comes from its actual catalog
OID and qualified table/constraint identity, not an endpoint or name waiver.

The exact declaration must occur once in the dump. Only that CHECK expression
is replaced for residual comparison; all other executable tokens, including
constraint flags, remain exact. Complete constraint identity/metadata sets
must match except the bound candidate's expression/definition digests. Extra
indexes, defaults, triggers, policies or constraints still reject. Missing,
unsupported, over-budget or failed captures leave strict parity unchanged.

The excluded SQL is independently compared as ordered AND groups. Only
parentheses enclosing conjunction nodes may differ; leaf tokens, including
their parentheses, literals, operators and casts, remain exact. OR/NOT,
BETWEEN/CASE and AND nested inside non-conjunction expressions reject. The
definition must contain the exact captured expression. Thus stale tree
evidence cannot authorize a changed SQL bound or replacement CHECK(FALSE),
even with updated definition/expression and raw dump hashes.

Captures run in the source read-only snapshot (up to64 CHECKs,30-second start
budget,15-second statement cap) and target read-only verification transaction.
Evidence2.0.0 contains schema tokens and private catalog metadata: retain it
as protected migration evidence, never public logs. It proves representation
equivalence only; row/queue/migration/sequence and cleanup checks remain
independent mandatory gates. A local simulated firewall input is not Azure
firewall acceptance. No source repair or historical migration rewrite is used.
