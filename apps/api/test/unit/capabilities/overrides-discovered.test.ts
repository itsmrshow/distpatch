import { describe, expect, test } from "bun:test"
import {
  buildCapabilityCatalog,
  createCapabilityCatalogStore,
  type ShippedCatalogInput,
} from "../../../src/services/capabilities"

const bootstrap: ShippedCatalogInput = {
  schemaVersion: 1,
  revision: "2026-10-16.1",
  profiles: [{ id: "local/base" }],
}

const operatorOverrides = {
  schemaVersion: 1,
  overrides: [
    { id: "local/base", enabled: false },
    { id: "local/discovered", enabled: false },
  ],
} as const

const snapshot = (
  discoveredProfiles: readonly {
    id: string
    aliases?: readonly string[]
    hard?: { textOutput?: boolean | null; toolUse?: boolean | null }
  }[],
) => ({
  schemaVersion: 1,
  models: {},
  discoveredProfiles,
})

describe("operator overrides for discovered profiles", () => {
  test("applies while discovered, then becomes inert again when the route disappears", async () => {
    let published: { readonly revision: string; readonly payload: unknown } | undefined
    const adopted: { revision: string | null; unmatched: readonly string[] }[] = []
    const initial = buildCapabilityCatalog(bootstrap, operatorOverrides)
    const store = createCapabilityCatalogStore({
      bootstrap,
      initialCatalog: initial,
      overrides: operatorOverrides,
      loadPublishedSnapshot: async () => published,
      refreshIntervalMs: 60_000,
      jitter: () => 60_000,
      onAdopted: (revision, unmatchedOverrideIds) =>
        adopted.push({ revision, unmatched: [...unmatchedOverrideIds] }),
    })

    expect(store.unmatchedOverrideIds()).toEqual(["local/discovered"])
    await store.refresh()
    expect(store.unmatchedOverrideIds()).toEqual(["local/discovered"])
    expect(store.get("local/base")?.enabled).toBe(false)
    expect(store.get("local/discovered")).toBeNull()

    published = {
      revision: "snapshot-1",
      payload: snapshot([{ id: "local/discovered", aliases: ["discovered-route"] }]),
    }
    await store.refresh()
    expect(store.get("local/discovered")?.enabled).toBe(false)
    expect(store.get("local/discovered")?.origin).toBe("discovered")
    expect(store.resolve("discovered-route")?.enabled).toBe(false)
    expect(store.unmatchedOverrideIds()).toEqual([])

    published = { revision: "snapshot-2", payload: snapshot([]) }
    await store.refresh()
    expect(store.get("local/discovered")).toBeNull()
    expect(store.unmatchedOverrideIds()).toEqual(["local/discovered"])
    expect(adopted).toEqual([
      { revision: "snapshot-1", unmatched: [] },
      { revision: "snapshot-2", unmatched: ["local/discovered"] },
    ])
    store.stop()
  })
  test("rejects a contradictory discovered override atomically and reports it", async () => {
    const overrides = {
      schemaVersion: 1,
      overrides: [
        { id: "local/discovered", scores: { tool_use: 0.5 } },
        { id: "local/base", enabled: false },
      ],
    } as const
    let published: { readonly revision: string; readonly payload: unknown } = {
      revision: "snapshot-contradiction",
      payload: {
        ...snapshot([
          {
            id: "local/discovered",
            hard: { textOutput: false, toolUse: false },
          },
        ]),
      },
    }
    const adopted: {
      revision: string | null
      unmatched: readonly string[]
      rejected: readonly { id: string; reason: string }[]
    }[] = []
    const store = createCapabilityCatalogStore({
      bootstrap,
      initialCatalog: buildCapabilityCatalog(bootstrap, overrides),
      overrides,
      loadPublishedSnapshot: async () => published,
      refreshIntervalMs: 60_000,
      jitter: () => 60_000,
      onAdopted: (revision, unmatched, rejected) =>
        adopted.push({
          revision,
          unmatched: [...unmatched],
          rejected: [...rejected],
        }),
    })

    await store.refresh()

    expect(store.get("local/base")?.enabled).toBe(false)
    expect(store.get("local/discovered")).toMatchObject({
      origin: "discovered",
      hard: { textOutput: false, toolUse: false },
      scores: { tool_use: null },
      overridden: [],
    })
    expect(store.unmatchedOverrideIds()).toEqual([])
    expect(store.rejectedOverrides()).toEqual([
      {
        id: "local/discovered",
        reason: expect.stringContaining("scores.tool_use is set but hard.toolUse is false"),
      },
    ])

    published = {
      revision: "snapshot-no-discovered-profile",
      payload: snapshot([]),
    }
    await store.refresh()
    expect(store.rejectedOverrides()).toEqual([])
    expect(store.unmatchedOverrideIds()).toEqual(["local/discovered"])
    expect(adopted.map((entry) => entry.rejected.map(({ id }) => id))).toEqual([
      ["local/discovered"],
      [],
    ])
    store.stop()
  })

  test("rejects a discovered alias collision without trimming discovery", async () => {
    const overrides = {
      schemaVersion: 1,
      overrides: [{ id: "local/discovered", aliases: ["claimed"] }],
    } as const
    const published = {
      revision: "snapshot-alias-collision",
      payload: snapshot([
        { id: "local/discovered", aliases: ["original"] },
        { id: "local/other", aliases: ["claimed"] },
      ]),
    }
    const store = createCapabilityCatalogStore({
      bootstrap,
      initialCatalog: buildCapabilityCatalog(bootstrap, overrides),
      overrides,
      loadPublishedSnapshot: async () => published,
      refreshIntervalMs: 60_000,
      jitter: () => 60_000,
    })

    await store.refresh()

    expect(store.get("local/discovered")?.aliases).toEqual(["original"])
    expect(store.get("local/other")?.aliases).toEqual(["claimed"])
    expect(store.rejectedOverrides()).toEqual([
      {
        id: "local/discovered",
        reason: expect.stringContaining("alias claimed is already an alias of local/other"),
      },
    ])
    store.stop()
  })

  test("snapshot identity collisions yield to operator profiles and aliases", async () => {
    const operatorBootstrap: ShippedCatalogInput = {
      ...bootstrap,
      profiles: [{ id: "local/base" }],
    }
    const overrides = {
      schemaVersion: 1,
      profiles: [{ id: "local/operator", aliases: ["operator-alias", "local/id-claim"] }],
      overrides: [{ id: "local/base", aliases: ["local/override-alias", "local/collision"] }],
    } as const
    const published: { readonly revision: string; readonly payload: unknown } | undefined = {
      revision: "snapshot-1",
      payload: snapshot([
        { id: "local/operator", aliases: ["discarded"] },
        { id: "local/id-claim" },
        { id: "local/collision" },
        {
          id: "local/other",
          aliases: ["operator-alias", "local/override-alias", "kept"],
        },
      ]),
    }
    const store = createCapabilityCatalogStore({
      bootstrap: operatorBootstrap,
      initialCatalog: buildCapabilityCatalog(operatorBootstrap, overrides),
      overrides,
      loadPublishedSnapshot: async () => published,
      refreshIntervalMs: 60_000,
      jitter: () => 60_000,
    })

    await store.refresh()
    expect(store.get("local/operator")?.origin).toBe("operator")
    expect(store.get("local/id-claim")).toBeNull()
    expect(store.get("local/collision")).toBeNull()
    expect(store.get("local/other")?.aliases).toEqual(["kept"])
    expect(store.resolve("operator-alias")?.id).toBe("local/operator")
    expect(store.resolve("local/override-alias")?.id).toBe("local/base")
    expect(store.unmatchedOverrideIds()).toEqual([])
    store.stop()
  })
})
