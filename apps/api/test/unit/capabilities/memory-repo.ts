import type {
  CapabilityIntelligenceRepository,
  CapabilityObservationRow,
  CapabilitySnapshotInsert,
  CapabilitySnapshotRow,
  RouteModelInventoryRow,
} from "@multi-ai-router/db"

export function createMemoryCapabilityRepo(): CapabilityIntelligenceRepository & {
  observations: CapabilityObservationRow[]
  snapshots: CapabilitySnapshotRow[]
  failNextPublish: boolean
  failNextRecord: boolean
} {
  const observations: CapabilityObservationRow[] = []
  const snapshots: CapabilitySnapshotRow[] = []
  let failNextPublish = false
  let failNextRecord = false
  const routeRows = new Map<string, RouteModelInventoryRow>()
  let publicationQueue: Promise<void> = Promise.resolve()
  const withPublicationLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = publicationQueue
    const { promise, resolve } = Promise.withResolvers<void>()
    publicationQueue = promise
    await previous
    try {
      return await work()
    } finally {
      resolve()
    }
  }

  const saveSnapshotUnlocked = (snap: CapabilitySnapshotInsert): CapabilitySnapshotRow => {
    const idx = snapshots.findIndex((s) => s.revision === snap.revision)
    if (idx !== -1) {
      const current = snapshots[idx]
      if (current && current.publicationState === "published") return current
      const updated: CapabilitySnapshotRow = {
        id: current?.id ?? crypto.randomUUID(),
        revision: snap.revision,
        generatedAt: snap.generatedAt,
        publishedAt: snap.publishedAt ?? current?.publishedAt ?? null,
        compilerVersion: snap.compilerVersion,
        normalizerVersion: snap.normalizerVersion,
        evidenceDigest: snap.evidenceDigest,
        publicationState: snap.publicationState,
        payload: snap.payload,
        summary: snap.summary,
      }
      snapshots[idx] = updated
      return updated
    }
    const created: CapabilitySnapshotRow = {
      id: crypto.randomUUID(),
      revision: snap.revision,
      generatedAt: snap.generatedAt,
      publishedAt: snap.publishedAt ?? null,
      compilerVersion: snap.compilerVersion,
      normalizerVersion: snap.normalizerVersion,
      evidenceDigest: snap.evidenceDigest,
      publicationState: snap.publicationState,
      payload: snap.payload,
      summary: snap.summary,
    }
    snapshots.push(created)
    return created
  }

  const publishSnapshotUnlocked = (
    revision: string,
    publishedAt: Date,
    simulateFailure = true,
  ): CapabilitySnapshotRow => {
    if (simulateFailure && failNextPublish) {
      failNextPublish = false
      throw new Error("simulated atomic publish transaction failure")
    }
    const targetIdx = snapshots.findIndex((s) => s.revision === revision)
    if (targetIdx === -1) throw new Error(`unknown snapshot ${revision}`)
    const target = snapshots[targetIdx]
    if (target?.publicationState === "rejected") {
      throw new Error(`Cannot publish rejected capability snapshot revision ${revision}`)
    }
    for (let i = 0; i < snapshots.length; i++) {
      const snapshot = snapshots[i]
      if (snapshot && snapshot.publicationState === "published") {
        snapshots[i] = { ...snapshot, publicationState: "superseded" }
      }
    }
    const published: CapabilitySnapshotRow = {
      ...target,
      publicationState: "published",
      publishedAt,
    }
    snapshots[targetIdx] = published
    return published
  }

  const sortedObservations = () =>
    [...observations].sort(
      (a, b) =>
        a.observedAt.getTime() - b.observedAt.getTime() ||
        a.ingestedAt.getTime() - b.ingestedAt.getTime() ||
        (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0),
    )

  const sortedRouteRows = () =>
    [...routeRows.values()].sort((a, b) =>
      `${a.source}/${a.routeModelId}` < `${b.source}/${b.routeModelId}` ? -1 : 1,
    )

  const saveRouteRows = (rows: readonly RouteModelInventoryRow[]) => {
    for (const row of rows) routeRows.set(`${row.source}/${row.routeModelId}`, row)
  }

  return {
    observations,
    snapshots,
    get failNextPublish() {
      return failNextPublish
    },
    set failNextPublish(v: boolean) {
      failNextPublish = v
    },
    get failNextRecord() {
      return failNextRecord
    },
    set failNextRecord(v: boolean) {
      failNextRecord = v
    },

    async recordObservations(rows) {
      if (failNextRecord) {
        failNextRecord = false
        throw new Error("simulated database write failure")
      }
      let inserted = 0
      let deduplicated = 0
      for (const row of rows) {
        const latest = [...observations]
          .filter(
            (o) =>
              o.source === row.source &&
              o.sourceModelId === row.sourceModelId &&
              o.metric === row.metric,
          )
          .sort(
            (a, b) =>
              b.observedAt.getTime() - a.observedAt.getTime() ||
              b.ingestedAt.getTime() - a.ingestedAt.getTime(),
          )[0]
        if (latest?.fingerprint === row.fingerprint) {
          deduplicated += 1
          continue
        }
        const existingIdx = observations.findIndex((o) => o.fingerprint === row.fingerprint)
        if (existingIdx !== -1) {
          const existing = observations[existingIdx]
          if (existing) {
            observations[existingIdx] = {
              ...existing,
              canonicalModelId: row.canonicalModelId,
              observedAt: row.observedAt,
              ingestedAt: row.ingestedAt,
              sourceRef: row.sourceRef,
              provenance: row.provenance,
            }
          }
          inserted += 1
          continue
        }
        observations.push({
          id: crypto.randomUUID(),
          ...row,
        })
        inserted += 1
      }
      return { inserted, deduplicated }
    },

    async resolveObservationIdentities(resolve) {
      let updated = 0
      for (let i = 0; i < observations.length; i++) {
        const obs = observations[i]
        if (!obs) continue
        const next = resolve(obs.source, obs.sourceModelId, obs.provenance)
        if (next !== obs.canonicalModelId) {
          observations[i] = { ...obs, canonicalModelId: next }
          updated += 1
        }
      }
      return updated
    },

    async listObservations() {
      return sortedObservations()
    },

    async listResolvedObservations() {
      return (await this.listObservations()).filter((o) => o.canonicalModelId !== null)
    },

    async listUnresolvedObservations() {
      return observations.filter((o) => o.canonicalModelId === null)
    },

    async saveSnapshot(snap) {
      return withPublicationLock(async () => saveSnapshotUnlocked(snap))
    },

    async publishSnapshot(revision, publishedAt) {
      return withPublicationLock(async () => publishSnapshotUnlocked(revision, publishedAt))
    },

    publishSnapshotWithCurrentEvidence: (build) =>
      withPublicationLock(async () => {
        const built = await build({
          observations: sortedObservations(),
          routeModels: sortedRouteRows(),
        })
        if (failNextPublish) {
          failNextPublish = false
          throw new Error("simulated atomic publish transaction failure")
        }
        saveSnapshotUnlocked(built.snapshot)
        const publishedSnapshot = publishSnapshotUnlocked(
          built.snapshot.revision,
          built.snapshot.generatedAt,
          false,
        )
        return { publishedSnapshot, result: built.result }
      }),

    async getPublishedSnapshot() {
      return snapshots.find((s) => s.publicationState === "published")
    },

    async getLatestSnapshot() {
      return [...snapshots].sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime())[0]
    },

    async listSnapshots(limit = 20) {
      return [...snapshots]
        .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime())
        .slice(0, limit)
    },

    async listRouteModels() {
      return sortedRouteRows()
    },

    async saveRouteModels(rows) {
      await withPublicationLock(async () => saveRouteRows(rows))
    },

    reconcileRouteModels: (reconcile) =>
      withPublicationLock(async () => {
        const { rows, result } = reconcile(sortedRouteRows())
        saveRouteRows(rows)
        return result
      }),
  }
}
