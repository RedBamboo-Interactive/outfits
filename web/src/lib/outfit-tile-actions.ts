// Outfit tile actions as descriptors for the tile's Leaf context menu (right-click
// and long-press). The only action a tile has is the one its click runs: wear it.
// No runtime imports, so node tests load it directly.
import type { ContextMenuEntry } from "@redbamboo/ui"

export interface OutfitTileActions {
  /** The base avatar tile rather than an outfit from the history. */
  base: boolean
  /** Already worn: choosing it again would change nothing. */
  active: boolean
  /** A selection request is in flight. */
  busy: boolean
  onUse: () => void
}

export function outfitTileEntries({ base, active, busy, onUse }: OutfitTileActions): ContextMenuEntry[] {
  return [{
    id: "use",
    label: base ? "Use base avatar" : "Use this outfit",
    icon: base ? "ph-bold ph-user-circle" : "ph-bold ph-t-shirt",
    disabled: active || busy,
    run: () => onUse(),
  }]
}

export interface OutfitEntitySubject {
  id: string
  typeSlug: "outfit"
  name: string
  href: string | null
}

/** Each history tile is an `outfit` entity, so other plugins' entity contributions attach. */
export function outfitEntitySubject(outfit: { id: string; name: string | null }): OutfitEntitySubject {
  return { id: outfit.id, typeSlug: "outfit", name: outfit.name ?? "Outfit", href: null }
}
