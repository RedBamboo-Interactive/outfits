using System.Text.Json.Nodes;
using Leaf.Sdk;
using Leaf.Sdk.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Leaf.Plugins.Outfits;

internal static class OutfitEndpoints
{
    public static void Map(RouteGroupBuilder group)
    {
        group.MapGet("/", async (
            HttpContext ctx,
            [FromKeyedServices(OutfitsPlugin.PluginId)] IEntityStore entities,
            CancellationToken ct) =>
        {
            var requestedAgent = QueryString(ctx, "agentId");
            var agent = await ResolveAgentAsync(entities, requestedAgent, ct);
            if (agent == null)
                return Results.Ok(EmptyPage());

            var limit = ParseInt(ctx, "limit", 20, 1, 100);
            var offset = ParseInt(ctx, "offset", 0, 0, int.MaxValue);
            var agentId = agent.Id.ToString();
            var current = OutfitData.String(agent.Data, "outfit");
            var items = await entities.QueryAsync(new EntityQuery
            {
                TypeSlug = "outfit",
                DataEquals = new Dictionary<string, object?> { ["agent"] = agentId },
                Limit = limit + 1,
                Offset = offset,
            }, ct);

            var outfits = items.Take(limit).Select(outfit => (object)new
            {
                id = outfit.Id.ToString(),
                name = outfit.Name,
                url = OutfitData.String(outfit.Data, "asset"),
                prompt = OutfitData.String(outfit.Data, "prompt"),
                reasoning = OutfitData.String(outfit.Data, "reasoning"),
                nsfw = OutfitData.Boolean(outfit.Data, "nsfw"),
                date = outfit.CreatedAt.UtcDateTime.ToString("O"),
                active = outfit.Id.ToString() == current,
            }).ToList();

            return Results.Ok(new
            {
                baseAvatarUrl = OutfitData.BaseAvatarUrl(agent.Data),
                currentOverride = current,
                outfits,
                hasMore = items.Count > limit,
            });
        });

        group.MapPost("/", async (
            HttpContext ctx,
            [FromKeyedServices(OutfitsPlugin.PluginId)] IEntityStore entities,
            CancellationToken ct) =>
        {
            var body = await ReadBodyAsync(ctx, ct);
            if (body == null) return Results.BadRequest(new { error = "Invalid JSON" });

            var agent = await ResolveAgentAsync(entities, OutfitData.String(body, "agentId"), ct);
            if (agent == null) return Results.BadRequest(new { error = "No agent configured" });

            var data = new JsonObject
            {
                ["agent"] = agent.Id.ToString(),
                ["asset"] = OutfitData.String(body, "url"),
                ["prompt"] = OutfitData.String(body, "prompt"),
                ["nsfw"] = OutfitData.Boolean(body, "nsfw"),
            };
            if (OutfitData.String(body, "reasoning") is { } reasoning)
                data["reasoning"] = reasoning;

            var name = OutfitData.String(body, "name") ?? "Outfit";
            var outfit = await entities.CreateAsync("outfit", name, data, ct);
            return Results.Ok(new { success = true, id = outfit.Id.ToString() });
        });

        group.MapPost("/select", async (
            HttpContext ctx,
            [FromKeyedServices(OutfitsPlugin.PluginId)] IEntityStore entities,
            [FromKeyedServices(OutfitsPlugin.PluginId)] IPluginEvents events,
            IDiscussions discussions,
            CancellationToken ct) =>
        {
            var body = await ReadBodyAsync(ctx, ct);
            if (body == null) return Results.BadRequest(new { error = "Invalid JSON" });

            var agent = await ResolveAgentAsync(entities, OutfitData.String(body, "agentId"), ct);
            if (agent == null) return Results.BadRequest(new { error = "No agent configured" });

            var outfitId = OutfitData.String(body, "outfitId");
            LeafEntity? outfit = null;
            var resolvedUrl = "";
            if (!string.IsNullOrWhiteSpace(outfitId))
            {
                if (!Guid.TryParse(outfitId, out var outfitGuid))
                    return Results.BadRequest(new { error = "Invalid outfit id" });

                outfit = await entities.GetAsync(outfitGuid, ct);
                if (outfit?.TypeSlug != "outfit")
                    return Results.NotFound(new { error = "Outfit not found" });
                if (OutfitData.String(outfit.Data, "agent") is { } ownerAgent
                    && ownerAgent != agent.Id.ToString())
                    return Results.BadRequest(new { error = "Outfit belongs to another agent" });

                resolvedUrl = OutfitData.String(outfit.Data, "asset") ?? "";
            }

            await entities.PatchAsync(
                agent.Id,
                new JsonObject { ["outfit"] = string.IsNullOrWhiteSpace(outfitId) ? "" : outfitId },
                ct: ct);

            await events.PublishAsync("agent.avatar-changed", new JsonObject
            {
                ["agentId"] = agent.Id.ToString(),
                ["url"] = resolvedUrl,
            }, ct);

            await PostTimelineEventAsync(
                entities,
                discussions,
                events,
                agent.Id.ToString(),
                outfit,
                resolvedUrl,
                ct);

            return Results.Ok(new { success = true, url = resolvedUrl });
        });
    }

    private static async Task<LeafEntity?> ResolveAgentAsync(
        IEntityStore entities,
        string? requested,
        CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(requested))
        {
            var direct = Guid.TryParse(requested, out var id)
                ? await entities.GetAsync(id, ct)
                : await entities.GetBySlugAsync(requested, ct);
            return direct?.TypeSlug == "agent" ? direct : null;
        }

        var nova = await entities.GetBySlugAsync("nova", ct);
        return nova?.TypeSlug == "agent" ? nova : null;
    }

    private static async Task PostTimelineEventAsync(
        IEntityStore entities,
        IDiscussions discussions,
        IPluginEvents events,
        string agentId,
        LeafEntity? outfit,
        string asset,
        CancellationToken ct)
    {
        try
        {
            var candidates = await entities.QueryAsync(new EntityQuery
            {
                TypeSlug = "discussion",
                DataEquals = new Dictionary<string, object?> { ["agent"] = agentId },
                Limit = 100,
            }, ct);
            var live = candidates.FirstOrDefault(d =>
                OutfitData.String(d.Data, "type") == "live"
                && OutfitData.String(d.Data, "status") is not ("archived" or "archiving"));
            if (live == null) return;

            var reset = outfit == null;
            var content = reset
                ? "Reset to base avatar"
                : $"Changed into \"{outfit!.Name}\"";
            var eventData = reset
                ? new JsonObject { ["status"] = "reset" }
                : new JsonObject
                {
                    ["outfitId"] = outfit!.Id.ToString(),
                    ["outfitName"] = outfit.Name,
                    ["asset"] = asset,
                };
            var parts = new JsonArray
            {
                new JsonObject { ["type"] = "text", ["content"] = content },
                new JsonObject { ["type"] = "event_data", ["source"] = "outfit", ["data"] = eventData.DeepClone() },
            };
            var uid = Guid.NewGuid().ToString("N");

            await discussions.PostAsync(live.Id, "system", content, new JsonObject
            {
                ["parts_json"] = parts.ToJsonString(),
                ["source"] = "event:outfit",
                ["uid"] = uid,
            }, ct: ct);

            var discussionId = OutfitData.String(live.Data, "discussion_id");
            if (discussionId == null) return;
            await events.PublishAsync("discussion.event", new JsonObject
            {
                ["discussionId"] = discussionId,
                ["sessionId"] = OutfitData.String(live.Data, "session_id"),
                ["content"] = content,
                ["source"] = "outfit",
                ["metadata"] = eventData.DeepClone(),
                ["timestamp"] = DateTimeOffset.UtcNow.ToString("O"),
            }, ct);
        }
        catch
        {
            // Avatar selection is authoritative. The LIVE note is best-effort.
        }
    }

    private static async Task<JsonObject?> ReadBodyAsync(HttpContext ctx, CancellationToken ct)
    {
        try { return await ctx.Request.ReadFromJsonAsync<JsonObject>(cancellationToken: ct); }
        catch { return null; }
    }

    private static string? QueryString(HttpContext ctx, string key)
        => ctx.Request.Query.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value.ToString()
            : null;

    private static int ParseInt(HttpContext ctx, string key, int fallback, int min, int max)
        => ctx.Request.Query.TryGetValue(key, out var value) && int.TryParse(value, out var parsed)
            ? Math.Clamp(parsed, min, max)
            : fallback;

    private static object EmptyPage() => new
    {
        baseAvatarUrl = "/nova-avatar.png",
        currentOverride = (string?)null,
        outfits = Array.Empty<object>(),
        hasMore = false,
    };
}

internal static class OutfitData
{
    public static string? String(JsonObject data, string key)
    {
        var node = data[key];
        return node is JsonValue value && value.TryGetValue<string>(out var result)
            ? result
            : null;
    }

    public static bool Boolean(JsonObject data, string key)
    {
        var node = data[key];
        if (node is not JsonValue value) return false;
        if (value.TryGetValue<bool>(out var boolean)) return boolean;
        return value.TryGetValue<string>(out var text)
            && bool.TryParse(text, out var parsed)
            && parsed;
    }

    public static string BaseAvatarUrl(JsonObject data)
    {
        if (String(data, "avatar") is { } avatar) return AssetUrl(avatar);
        if (data["avatar"] is JsonObject objectAvatar)
        {
            if (String(objectAvatar, "filename") is { } filename) return AssetUrl(filename);
            if (String(objectAvatar, "url") is { } url) return AssetUrl(url);
        }
        return "/nova-avatar.png";
    }

    private static string AssetUrl(string value)
        => value.StartsWith('/') || value.Contains("://") ? value : $"/api/assets/{value}";
}
