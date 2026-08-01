# Outfits

Optional outfit history and avatar selection for Nova agents. Outfits is a
real extension of the Nova extension: its manifest contributes the avatar
action to Nova's declared `chat-avatar-overlay` frontend slot. That relationship
is optional, so Outfits can grow integrations with other agent extensions
without making every target a lifecycle dependency. Its strict `requires` list
contains only the kernel capabilities its own backend needs.

Removing or disabling Outfits removes the picker and its API without disabling
Nova. Existing outfit entities and the selected `agent.outfit` reference are
never recreated or cleared, so the current avatar remains stable and enabling
the extension again restores the same history and selection.

## Layout

```text
plugin.json                     strict requirements and optional Nova contribution
src/Leaf.Plugins.Outfits/       API, events, and persisted automation migration
web/                            lazy avatar action and outfit browser
seeds/                          outfit schema and event metadata
build-leafpkg.ps1               produce dist/outfits-<version>.leafpkg
```

## Build

```powershell
cd web
pnpm install
cd ..
dotnet build
./build-leafpkg.ps1
```

Building against a kernel checkout instead of the Leaf.Sdk package:
`dotnet build -p:LeafSdkProject=<kernel>\src\Leaf.Sdk\Leaf.Sdk.csproj`.

## API

- `GET /api/apps/outfits?agentId=<id>` lists history and the active selection.
- `POST /api/apps/outfits` records a generated outfit.
- `POST /api/apps/outfits/select` selects an outfit or resets to the base avatar.

On first startup the plugin rewrites Nova's existing daily outfit automation
prompt from the former `/api/apps/nova/outfits` path to the canonical endpoint.
The automation entity, schedule, history, and all outfit entities stay intact.

## Develop against a running RedLeaf

1. Enable Dev Mode in RedLeaf Settings.
2. Open Extensions, choose **Add dev plugin**, and select this directory. The
   kernel registers it in `leaf.workspace.json` and loads it in place of any
   installed copy.
3. Run `pnpm dev` in `web/` for the frontend watch build. Run `dotnet build`
   after backend changes, then restart RedLeaf through the approved app flow.

## Publish

Run `./build-leafpkg.ps1`, attach the `.leafpkg` to a GitHub Release, then submit
the release URL and SHA-256 to a registry index. Users install it from
`/extensions` or by URL with SHA-256 verification.

## Rules that will save you a debugging afternoon

- Never remove entries from the shared dependency list in `web/vite.config.ts`.
  A second bundled React forks hooks and context at runtime.
- Never ship `Leaf.Sdk.dll` or `RedBamboo.AppHost.dll` inside the package. It
  breaks plugin type identity; the packaging script strips them automatically.
- Kernel services in endpoint handlers need
  `[FromKeyedServices(OutfitsPlugin.PluginId)]`. A plain parameter fails at
  kernel startup, not at build time.
