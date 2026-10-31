import assert from "node:assert/strict"
import test from "node:test"
import type { ContextMenuItem } from "@redbamboo/ui"
import { outfitEntitySubject, outfitTileEntries } from "./outfit-tile-actions.ts"

test("an outfit tile offers Use this outfit, running the tile's own select", () => {
  let used = 0
  const entries = outfitTileEntries({ base: false, active: false, busy: false, onUse: () => { used += 1 } })
  assert.deepEqual(entries.map((entry) => entry.id), ["use"])
  const use = entries[0] as ContextMenuItem
  assert.equal(use.label, "Use this outfit")
  assert.equal(use.disabled, false)
  use.run?.({} as never)
  assert.equal(used, 1)
})

test("the base tile offers Use base avatar", () => {
  const use = outfitTileEntries({ base: true, active: false, busy: false, onUse: () => {} })[0] as ContextMenuItem
  assert.equal(use.label, "Use base avatar")
})

test("use is disabled when already worn or while a selection is in flight", () => {
  assert.equal((outfitTileEntries({ base: false, active: true, busy: false, onUse: () => {} })[0] as ContextMenuItem).disabled, true)
  assert.equal((outfitTileEntries({ base: true, active: false, busy: true, onUse: () => {} })[0] as ContextMenuItem).disabled, true)
})

test("no item is destructive", () => {
  const use = outfitTileEntries({ base: false, active: false, busy: false, onUse: () => {} })[0] as ContextMenuItem
  assert.equal(use.danger, undefined)
})

test("outfit entity subject", () => {
  assert.deepEqual(outfitEntitySubject({ id: "o1", name: "Rain coat" }), { id: "o1", typeSlug: "outfit", name: "Rain coat", href: null })
  assert.equal(outfitEntitySubject({ id: "o2", name: null }).name, "Outfit")
})
