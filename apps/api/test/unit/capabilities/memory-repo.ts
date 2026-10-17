import type {
  CapabilityIntelligenceRepository,
  CapabilityObservationRow,
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
      return [...observations].sort(
        (a, b) =>
          a.observedAt.getTime() - b.observedAt.getTime() ||
          a.ingestedAt.getTime() - b.ingestedAt.getTime() ||
          (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0),
      )
    },

    async listResolvedObservations() {
      return (await this.listObservations()).filter((o) => o.canonicalModelId !== null)
    },

    async listUnresolvedObservations() {
      return observations.filter((o) => o.canonicalModelId === null)
    },

    async saveSnapshot(snap) {
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
    },

    async publishSnapshot(revision, publishedAt) {
      if (failNextPublish) {
        failNextPublish = false
        throw new Error("simulated atomic publish transaction failure")
      }
      const targetIdx = snapshots.findIndex((s) => s.revision === revision)
      if (targetIdx === -1) throw new Error(`unknown snapshot ${revision}`)
      for (let i = 0; i < snapshots.length; i++) {
        const s = snapshots[i]
        if (s && s.publicationState === "published") {
          snapshots[i] = { ...s, publicationState: "superseded" }
        }
      }
      const target = snapshots[targetIdx]
      if (!target) throw new Error(`unknown snapshot ${revision}`)
      const published: CapabilitySnapshotRow = {
        ...target,
        publicationState: "published",
        publishedAt,
      }
      snapshots[targetIdx] = published
      return published
    },

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
      return [...routeRows.values()].sort((a, b) =>
        `${a.source}/${a.routeModelId}` < `${b.source}/${b.routeModelId}` ? -1 : 1,
      )
    },

    async saveRouteModels(rows) {
      for (const row of rows) routeRows.set(`${row.source}/${row.routeModelId}`, row)
    },
  }
}
