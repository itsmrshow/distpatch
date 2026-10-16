import { describe, expect, test } from "bun:test"
import { recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("provider-neutral account annotations", () => {
  test("tags persist, are account-local, and never change lifecycle state", async () => {
    const first = await fixture.seed()
    const second = await fixture.seed()
    const repo = fixture.repositories().accounts
    expect(first.tags).toBeNull()
    const tags = ["local", "free", "dockerlm"]
    await repo.updateOperatorAccount({ id: first.id, patch: { tags }, now: new Date() })
    expect(await repo.findById(first.id)).toMatchObject({
      tags,
      lifecycleVersion: 0,
      status: "active",
    })
    expect((await repo.findById(second.id))?.tags).toBeNull()
    await repo.update(first.id, { label: "renamed" }, new Date())
    expect((await repo.findById(first.id))?.tags).toEqual(tags)
    await repo.update(first.id, { tags: null }, new Date())
    expect((await repo.findById(first.id))?.tags).toBeNull()
  })
})
