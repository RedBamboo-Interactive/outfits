import { useState } from "react"
import { createPortal } from "react-dom"
import type { LeafAppPlugin, LeafPluginExtensionProps } from "@redbamboo/utility"
import { OutfitBrowser } from "./outfit-browser"

function EmptyPage() {
  return null
}

function OutfitAvatarAction({ context }: LeafPluginExtensionProps) {
  const [open, setOpen] = useState(false)
  const agentId = typeof context.agentId === "string" ? context.agentId : null
  const discussionId = typeof context.discussionId === "string" ? context.discussionId : null
  const large = context.variant === "sidebar"

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="absolute inset-0 z-10 rounded-full cursor-pointer group focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-[-2px]"
        title="Browse outfits"
        aria-label="Browse outfits"
      >
        <span className="absolute inset-0 rounded-full bg-black/0 group-hover:bg-black/20 group-focus-visible:bg-black/20 transition-colors flex items-center justify-center">
          <i className={`ph-bold ph-t-shirt text-white/0 group-hover:text-white/70 group-focus-visible:text-white/70 transition-colors ${large ? "text-lg" : "text-xs"}`} />
        </span>
      </button>
      {open && createPortal(
        <OutfitBrowser
          onClose={() => setOpen(false)}
          discussionId={discussionId}
          agentId={agentId}
        />,
        document.body,
      )}
    </>
  )
}

export const plugin: LeafAppPlugin = {
  id: "outfits",
  Page: EmptyPage,
  extensions: {
    "avatar-action": OutfitAvatarAction,
  },
}
