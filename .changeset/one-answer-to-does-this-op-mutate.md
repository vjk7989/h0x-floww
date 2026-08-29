---
"@vendoai/core": minor
"@vendoai/store": minor
---

**One answer to "does this store op mutate", and one to "which tables does
an erase sweep".**

Additive only — nothing exported changes shape or narrows.

`@vendoai/core` now exports `isStoreWireMutation` (and `StoreWireOp`, which
`@vendoai/store` was declaring for itself). Behind it is a map that is TOTAL
over `STORE_WIRE_PATHS`, so an op added to the manifest does not compile until
it is classified. A mount deciding for itself which ops mutate was deciding
which ops may present an `Idempotency-Key`; it did that from a hand-list, and a
hand-list that misses a new mutation makes a retried write apply twice.

`@vendoai/store` exports `ERASE_TABLES` — the value, not only the `EraseTable`
type. The erase report's keys are wire-visible and a table missing from them is
a caller unable to tell "held nothing" from "never swept", so the list has to be
importable by anything that reproduces the report rather than re-typed beside it.
