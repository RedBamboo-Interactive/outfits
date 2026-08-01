import { useCallback, useEffect, useRef, useState } from "react"
import { ModalBase, ModalHeader } from "@redbamboo/ui"
import { apiFetch } from "@redbamboo/utility"

interface OutfitEntry {
  id: string
  name: string | null
  url: string
  prompt: string | null
  nsfw: boolean
  date: string | null
  active: boolean
}

interface OutfitPage {
  baseAvatarUrl: string
  currentOverride: string | null
  outfits: OutfitEntry[]
  hasMore: boolean
}

interface Props {
  onClose: () => void
  discussionId?: string | null
  agentId?: string | null
}

const PAGE_SIZE = 20
const API = "/api/apps/outfits"

function assetSrc(value: string): string {
  if (!value) return "/nova-avatar.png"
  if (value.startsWith("/") || value.includes("://")) return value
  return `/api/assets/${value.split("/").pop() ?? value}`
}

function relativeDate(iso: string | null): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${Math.max(0, mins)}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function OutfitBrowser({ onClose, discussionId, agentId }: Props) {
  const [outfits, setOutfits] = useState<OutfitEntry[]>([])
  const [meta, setMeta] = useState<{ baseAvatarUrl: string; currentOverride: string | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [selecting, setSelecting] = useState<string | null>(null)
  const [showNsfw, setShowNsfw] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const offsetRef = useRef(0)
  const loadingMoreRef = useRef(false)

  const fetchPage = useCallback(async (pageOffset: number): Promise<OutfitPage> => {
    const query = new URLSearchParams({ offset: String(pageOffset), limit: String(PAGE_SIZE) })
    if (agentId) query.set("agentId", agentId)
    return apiFetch<OutfitPage>(`${API}?${query}`)
  }, [agentId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchPage(0)
      .then((result) => {
        if (cancelled) return
        setMeta({ baseAvatarUrl: result.baseAvatarUrl, currentOverride: result.currentOverride })
        setOutfits(result.outfits)
        setHasMore(result.hasMore)
        offsetRef.current = result.outfits.length
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load outfits")
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchPage])

  const loadMoreRef = useRef<() => void>(() => {})
  loadMoreRef.current = async () => {
    if (loadingMoreRef.current || !hasMore) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const result = await fetchPage(offsetRef.current)
      setOutfits((previous) => [...previous, ...result.outfits])
      setHasMore(result.hasMore)
      offsetRef.current += result.outfits.length
    } catch {
      setError("Could not load more outfits")
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    const element = sentinelRef.current
    if (!element || !hasMore) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMoreRef.current() },
      { rootMargin: "200px" },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasMore])

  async function selectOutfit(outfit: OutfitEntry | null) {
    const key = outfit?.id ?? "__base__"
    setSelecting(key)
    setError(null)
    try {
      await apiFetch(`${API}/select`, {
        method: "POST",
        json: {
          outfitId: outfit?.id ?? null,
          discussionId,
          agentId,
        },
      })
      const selectedId = outfit?.id ?? null
      setMeta((previous) => previous ? { ...previous, currentOverride: selectedId } : previous)
      setOutfits((previous) => previous.map((entry) => ({ ...entry, active: entry.id === selectedId })))
      window.dispatchEvent(new Event("nova:avatar-changed"))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not select outfit")
    } finally {
      setSelecting(null)
    }
  }

  const baseActive = meta !== null && !outfits.some((outfit) => outfit.active)
  const filtered = outfits.filter((outfit) => outfit.active || showNsfw || !outfit.nsfw)
  const nsfwCount = outfits.filter((outfit) => outfit.nsfw).length

  return (
    <ModalBase dataModal="outfit-browser" ariaLabel="Browse outfits" onClose={onClose} size="lg">
      <ModalHeader
        icon={<i className="ph-bold ph-t-shirt text-primary" />}
        title={<span className="text-sm font-medium">Outfits</span>}
        onClose={onClose}
      />
      <div className="px-6 pb-5">
        {error && (
          <div className="mb-3 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-400" role="alert">
            {error}
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-8 text-text-muted text-sm">
            <i className="ph-bold ph-spinner animate-spin mr-2" /> Loading...
          </div>
        ) : (
          <>
            {nsfwCount > 0 && (
              <div className="flex items-center gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => setShowNsfw((value) => !value)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    showNsfw
                      ? "bg-rose-500/20 text-rose-400 hover:bg-rose-500/30"
                      : "bg-overlay-6 text-text-muted hover:bg-overlay-10"
                  }`}
                >
                  <i className={`ph-bold ${showNsfw ? "ph-eye" : "ph-eye-slash"} text-[10px]`} />
                  Show NSFW
                  <span className="text-[10px] opacity-60">({nsfwCount})</span>
                </button>
              </div>
            )}
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              <button
                type="button"
                onClick={() => selectOutfit(null)}
                className={`group relative aspect-[3/4] rounded-lg overflow-hidden border-2 transition-all ${
                  baseActive ? "border-primary ring-2 ring-primary/30" : "border-overlay-6 hover:border-overlay-10"
                }`}
              >
                <img
                  src={meta?.baseAvatarUrl ?? "/nova-avatar.png"}
                  alt="Base avatar"
                  className="w-full h-full object-cover object-top"
                  loading="lazy"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                  <span className="text-[10px] text-white font-medium">Base</span>
                </div>
                {selecting === "__base__" && <SpinnerOverlay />}
                {baseActive && <ActiveBadge />}
              </button>

              {filtered.map((outfit) => (
                <button
                  type="button"
                  key={outfit.id}
                  onClick={() => selectOutfit(outfit)}
                  className={`group relative aspect-[3/4] rounded-lg overflow-hidden border-2 transition-all ${
                    outfit.active ? "border-primary ring-2 ring-primary/30" : "border-overlay-6 hover:border-overlay-10"
                  }`}
                  title={outfit.prompt ?? undefined}
                >
                  <img
                    src={assetSrc(outfit.url)}
                    alt={outfit.name ?? "Outfit"}
                    className="w-full h-full object-cover object-top"
                    loading="lazy"
                    onError={(event) => { event.currentTarget.src = "/nova-avatar.png" }}
                  />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2">
                    <div className="text-[10px] text-white font-medium truncate">{outfit.name ?? "Outfit"}</div>
                    <div className="text-[9px] text-white/60">{relativeDate(outfit.date)}</div>
                  </div>
                  {outfit.nsfw && (
                    <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-rose-500/80 text-[8px] text-white font-bold">
                      NSFW
                    </div>
                  )}
                  {selecting === outfit.id && <SpinnerOverlay />}
                  {outfit.active && <ActiveBadge />}
                </button>
              ))}

              {filtered.length === 0 && (
                <div className="col-span-2 sm:col-span-3 flex items-center justify-center py-8 text-text-muted text-xs">
                  {nsfwCount > 0 && !showNsfw
                    ? "All outfits are NSFW. Toggle the filter to see them."
                    : "No outfit changes yet."}
                </div>
              )}
            </div>
            <div ref={sentinelRef} className="h-px" />
            {loadingMore && (
              <div className="flex items-center justify-center py-4 text-text-muted text-sm">
                <i className="ph-bold ph-spinner animate-spin mr-2" /> Loading more...
              </div>
            )}
          </>
        )}
      </div>
    </ModalBase>
  )
}

function SpinnerOverlay() {
  return (
    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
      <i className="ph-bold ph-spinner animate-spin text-white" />
    </div>
  )
}

function ActiveBadge() {
  return (
    <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
      <i className="ph-bold ph-check text-[10px] text-white" />
    </div>
  )
}
