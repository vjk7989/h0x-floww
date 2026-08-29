import { describe, expect, it } from "vitest";
import { assertEngineCollection } from "../src/engine-collections.js";
import { engineOverAdapter } from "../src/engine-over-adapter.js";
import { VendoError } from "../src/errors.js";
import type {
  AtomicRecordStore,
  BlobStore,
  RecordInput,
  RecordQuery,
  RecordStore,
  StoreAdapter,
  StoreOps,
  VendoRecord,
} from "../src/store.js";

/** Both on the engine allowlist (engine-collections.ts), so the gate lets them
 *  through and the tests below are about the door, not the allowlist. */
const AUDIT = "vendo_audit";
const EFFECTS = "vendo_effects";

/** `claim` and `atomic` are OPTIONAL on RecordStore (02-store §4). Which of them
 *  a BYO adapter actually implements is the whole subject of this file, so the
 *  fake takes them as capabilities rather than always offering both. */
type Caps = { claim: boolean; atomic: boolean };

type Fake = {
  store: StoreAdapter;
  /** How many times `records()` has been asked for a handle. */
  doorCount: () => number;
};

function fakeAdapter(caps: Caps): Fake {
  const tables = new Map<string, Map<string, VendoRecord>>();
  let doors = 0;
  let seq = 0;

  const tableFor = (collection: string): Map<string, VendoRecord> => {
    const found = tables.get(collection);
    if (found !== undefined) return found;
    const fresh = new Map<string, VendoRecord>();
    tables.set(collection, fresh);
    return fresh;
  };

  /** A revision is handed out only when this door claims `atomic`, mirroring
   *  VendoRecord.revision's contract ("present when the store exposes atomic"). */
  const write = (rows: Map<string, VendoRecord>, input: RecordInput): VendoRecord => {
    const now = "2026-08-10T00:00:00.000Z";
    const previous = rows.get(input.id);
    seq += 1;
    const record: VendoRecord = {
      id: input.id,
      data: input.data,
      ...(input.refs === undefined ? {} : { refs: input.refs }),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(caps.atomic ? { revision: `r${seq}` } : {}),
    };
    rows.set(input.id, record);
    return record;
  };

  const records = (collection: string): RecordStore => {
    doors += 1;
    const rows = tableFor(collection);
    const door: RecordStore = {
      get: async (id) => rows.get(id) ?? null,
      put: async (input) => write(rows, input),
      delete: async (id) => {
        rows.delete(id);
      },
      list: async (query?: RecordQuery) => ({
        records: [...rows.values()].filter(
          (row) => query?.ids === undefined || query.ids.includes(row.id),
        ),
      }),
    };
    if (caps.claim) {
      door.claim = async (expected) => rows.has(expected.id);
    }
    if (caps.atomic) {
      door.atomic = {
        insertIfAbsent: async (input) => (rows.has(input.id) ? null : write(rows, input)),
        compareAndSwap: async (input, expectedRevision) =>
          rows.get(input.id)?.revision === expectedRevision ? write(rows, input) : null,
      };
    }
    return door;
  };

  return {
    store: {
      records,
      blobs: (): BlobStore => {
        throw new Error("the engine family never reaches for blobs");
      },
      ensureSchema: async () => undefined,
    },
    doorCount: () => doors,
  };
}

const caught = async (run: Promise<unknown>): Promise<VendoError> =>
  await run.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as VendoError,
  );

describe("engineOverAdapter — the engine family over a bare StoreAdapter", () => {
  it("carries the seven verbs through to the adapter's own record door", async () => {
    const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: true }).store);

    const put = await engine.put(AUDIT, { id: "a1", data: { n: 1 }, refs: { app: "app_1" } });
    expect(put).toMatchObject({ id: "a1", data: { n: 1 }, refs: { app: "app_1" } });
    expect(await engine.get(AUDIT, "a1")).toMatchObject({ id: "a1", data: { n: 1 } });
    expect(await engine.get(AUDIT, "absent")).toBeNull();

    const listed = await engine.list(AUDIT);
    expect(listed.records.map((row) => row.id)).toEqual(["a1"]);
    expect((await engine.list(AUDIT, { ids: ["absent"] })).records).toEqual([]);

    expect(await engine.claim(AUDIT, { id: "a1", data: { n: 1 } })).toBe(true);

    await engine.delete(AUDIT, "a1");
    expect(await engine.get(AUDIT, "a1")).toBeNull();
  });

  it("gates the collection name on every verb, refusing with `blocked`", async () => {
    const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: true }).store);
    const refusal = await caught(engine.put("host_invoices", { id: "inv_1", data: {} }));
    expect(refusal.code).toBe("blocked");
    expect(refusal.message).toContain("host_invoices");
  });

  it("asks for a fresh handle per verb and never caches one", async () => {
    // Fixtures wrap `records()` to inject a failure on a chosen call, so a
    // cached handle would quietly make those fixtures unreachable.
    const fake = fakeAdapter({ claim: true, atomic: true });
    const engine = engineOverAdapter(fake.store);
    await engine.put(AUDIT, { id: "a1", data: {} });
    await engine.get(AUDIT, "a1");
    await engine.list(AUDIT);
    expect(fake.doorCount()).toBe(3);
  });

  it("refuses claim with `not-implemented` on a door that does not offer it", async () => {
    const engine = engineOverAdapter(fakeAdapter({ claim: false, atomic: true }).store);
    const refusal = await caught(engine.claim(AUDIT, { id: "a1", data: {} }));
    expect(refusal.code).toBe("not-implemented");
    expect(refusal.message).toContain(AUDIT);
  });

  describe("a door WITH the atomic capability gets the real thing", () => {
    it("insertIfAbsent lets the first writer win and answers null to the second", async () => {
      const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: true }).store);
      expect(await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 1 } }))
        .toMatchObject({ id: "e1", data: { v: 1 } });
      expect(await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 2 } })).toBeNull();
    });

    it("compareAndSwap honors the revision token and rejects a stale one", async () => {
      const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: true }).store);
      const created = await engine.put(EFFECTS, { id: "e1", data: { v: 1 } });
      expect(created.revision).toBeDefined();
      const revision = created.revision ?? "";

      expect(await engine.compareAndSwap(EFFECTS, { id: "e1", data: { v: 2 } }, revision))
        .toMatchObject({ data: { v: 2 } });
      // The token has moved on, so the same revision no longer matches.
      expect(await engine.compareAndSwap(EFFECTS, { id: "e1", data: { v: 3 } }, revision)).toBeNull();
    });
  });

  describe("a door WITHOUT it degrades instead of failing closed", () => {
    // The documented promise (engine-over-adapter.ts:36-56): moving a block onto
    // this family must not turn a working BYO adapter into a `not-implemented`.
    it("insertIfAbsent becomes check-then-put, keeping the first write", async () => {
      const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: false }).store);
      expect(await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 1 } }))
        .toMatchObject({ id: "e1", data: { v: 1 } });
      expect(await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 2 } })).toBeNull();
      expect(await engine.get(EFFECTS, "e1")).toMatchObject({ data: { v: 1 } });
    });

    it("compareAndSwap becomes last-write-wins, because the token means nothing", async () => {
      const engine = engineOverAdapter(fakeAdapter({ claim: true, atomic: false }).store);
      const created = await engine.put(EFFECTS, { id: "e1", data: { v: 1 } });
      // A door with no atomic hands out no revision, so no caller can hold one.
      expect(created.revision).toBeUndefined();
      expect(await engine.compareAndSwap(EFFECTS, { id: "e1", data: { v: 2 } }, "unenforceable"))
        .toMatchObject({ data: { v: 2 } });
      expect(await engine.get(EFFECTS, "e1")).toMatchObject({ data: { v: 2 } });
    });
  });
});

// ---------------------------------------------------------------------------
// The consolidation table
// ---------------------------------------------------------------------------

/** `vendo_runs.started_at` is the only indexed field in the registry, so it is
 *  the only collection a watermark bound can legally name. */
const RUNS = "vendo_runs";

type Engine = StoreOps["engine"];

/** The two implementations this family replaced, frozen verbatim.
 *
 *  Core's was `engineOverAdapter` before the option; guard's was a private
 *  `adapterEngine` in guard.ts. They disagreed in OPPOSITE directions — guard
 *  refused the atomics core degraded, core refused the watermark guard silently
 *  dropped — so the single implementation is only safe if it is checked against
 *  BOTH, cell by cell. Edit a copy here only when the posture it pins is being
 *  deliberately changed, and say which caller's posture moved. */
function legacyCore(store: StoreAdapter): Engine {
  const door = (collection: string): RecordStore => {
    assertEngineCollection(collection);
    return store.records(collection);
  };
  return {
    get: async (collection, id) => await door(collection).get(id),
    put: async (collection, record) => await door(collection).put(record),
    delete: async (collection, id) => {
      await door(collection).delete(id);
    },
    list: async (collection, query) => {
      if (query?.watermark !== undefined) {
        throw new VendoError(
          "not-implemented",
          `${collection} is served by a bare StoreAdapter, which cannot honor an engine.list watermark`
          + " — use a store with its own engine (createStore, or a Store Wire mount).",
        );
      }
      return await door(collection).list(query);
    },
    claim: async (collection, expected, replacement) => {
      const records = door(collection);
      if (records.claim === undefined) {
        throw new VendoError("not-implemented", `${collection} does not support claim`);
      }
      return await records.claim(expected, replacement);
    },
    insertIfAbsent: async (collection, record) => {
      const records = door(collection);
      if (records.atomic !== undefined) return await records.atomic.insertIfAbsent(record);
      if (await records.get(record.id) !== null) return null;
      return await records.put(record);
    },
    compareAndSwap: async (collection, record, expectedRevision) => {
      const records = door(collection);
      if (records.atomic === undefined) return await records.put(record);
      return await records.atomic.compareAndSwap(record, expectedRevision);
    },
  };
}

function legacyGuard(store: StoreAdapter): Engine {
  const door = (collection: string): RecordStore => {
    assertEngineCollection(collection);
    return store.records(collection);
  };
  const atomic = (collection: string, verb: string): AtomicRecordStore => {
    const capability = door(collection).atomic;
    if (capability === undefined) {
      throw new VendoError(
        "not-implemented",
        `${collection} does not support ${verb}: this adapter omits the optional `
        + "atomic-revisions capability (RecordStore.atomic, 02-store §4)",
      );
    }
    return capability;
  };
  return {
    get: async (collection, id) => await door(collection).get(id),
    put: async (collection, record) => await door(collection).put(record),
    delete: async (collection, id) => {
      await door(collection).delete(id);
    },
    list: async (collection, query) => await door(collection).list(query),
    claim: async (collection, expected, replacement) => {
      const claim = door(collection).claim;
      if (claim === undefined) {
        throw new VendoError("not-implemented", `${collection} does not support claim`);
      }
      return await claim(expected, replacement);
    },
    insertIfAbsent: async (collection, record) =>
      await atomic(collection, "insertIfAbsent").insertIfAbsent(record),
    compareAndSwap: async (collection, record, expectedRevision) =>
      await atomic(collection, "compareAndSwap").compareAndSwap(record, expectedRevision),
  };
}

/** Who constructs this family, and how each one gets built now. `mcp`,
 *  `knowledge`, `apps`, `automations` and `store` all call it bare; guard is the
 *  one caller that passes an option. */
const CALLERS = [
  { name: "core callers (mcp, knowledge, apps, automations, store)", legacy: legacyCore,
    build: (store: StoreAdapter): Engine => engineOverAdapter(store) },
  { name: "guard", legacy: legacyGuard,
    build: (store: StoreAdapter): Engine => engineOverAdapter(store, { atomics: "require" }) },
] as const;

/** One line of observable behaviour per verb, seeded through the family itself
 *  so the same script runs on every implementation. */
const CASES: { verb: string; run: (engine: Engine) => Promise<string> }[] = [
  {
    verb: "list without a watermark",
    run: async (engine) => {
      await engine.put(RUNS, { id: "r1", data: { started_at: "2026-01-01T00:00:00.000Z" } });
      const page = await engine.list(RUNS);
      return `records=${page.records.map((row) => row.id).join("|")} watermark=${page.watermark}`;
    },
  },
  {
    verb: "list with a watermark",
    run: async (engine) => {
      await engine.put(RUNS, { id: "r1", data: { started_at: "2026-01-01T00:00:00.000Z" } });
      const page = await engine.list(RUNS, {
        watermark: { field: "started_at", after: "2026-06-01T00:00:00.000Z" },
      });
      return `records=${page.records.map((row) => row.id).join("|")} watermark=${page.watermark}`;
    },
  },
  {
    verb: "claim",
    run: async (engine) => {
      await engine.put(AUDIT, { id: "a1", data: { n: 1 } });
      return `claimed=${await engine.claim(AUDIT, { id: "a1", data: { n: 1 } })}`;
    },
  },
  {
    verb: "insertIfAbsent, twice",
    run: async (engine) => {
      const first = await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 1 } });
      const second = await engine.insertIfAbsent(EFFECTS, { id: "e1", data: { v: 2 } });
      const stored = await engine.get(EFFECTS, "e1");
      return `first=${first?.id} second=${second?.id ?? null} stored=${JSON.stringify(stored?.data)}`;
    },
  },
  {
    verb: "compareAndSwap on a stale token",
    run: async (engine) => {
      await engine.put(EFFECTS, { id: "e1", data: { v: 1 } });
      const swapped = await engine.compareAndSwap(EFFECTS, { id: "e1", data: { v: 2 } }, "stale");
      const stored = await engine.get(EFFECTS, "e1");
      return `swapped=${swapped?.id ?? null} stored=${JSON.stringify(stored?.data)}`;
    },
  },
];

const observe = async (engine: Engine, run: (engine: Engine) => Promise<string>): Promise<string> => {
  try {
    return await run(engine);
  } catch (error) {
    return `threw ${(error as VendoError).code}`;
  }
};

describe("the consolidation table — every caller's posture, before and after", () => {
  /** The one cell where the single implementation deliberately DIFFERS from the
   *  copy it replaced: guard used to hand the watermark to a `RecordStore.list`
   *  that has no watermark in its query, getting an ordinary newest-first page
   *  and no echo back — a forward walk that re-reads the newest rows forever.
   *  Latent, not live (guard passes no watermark anywhere), and core's refusal
   *  is the fix. Every other cell must match. */
  const INTENDED_DRIFT = "guard × list with a watermark";

  for (const caller of CALLERS) {
    for (const caps of [
      { claim: true, atomic: true },
      { claim: true, atomic: false },
      { claim: false, atomic: true },
      { claim: false, atomic: false },
    ]) {
      const shape = `claim=${caps.claim} atomic=${caps.atomic}`;
      for (const { verb, run } of CASES) {
        const cell = `${caller.name} × ${verb}`;
        it(`${cell} — ${shape}`, async () => {
          const before = await observe(caller.legacy(fakeAdapter(caps).store), run);
          const after = await observe(caller.build(fakeAdapter(caps).store), run);
          if (cell === INTENDED_DRIFT) {
            // Spelled out rather than merely "differs": the old answer served
            // the bounded row it was asked to skip, with no echo to say the
            // bound was ignored.
            expect(before).toBe("records=r1 watermark=undefined");
            expect(after).toBe("threw not-implemented");
            return;
          }
          expect(`${cell} [${shape}] ${after}`).toBe(`${cell} [${shape}] ${before}`);
        });
      }
    }
  }
});
