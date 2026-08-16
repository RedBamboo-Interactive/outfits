using System.Reflection;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Leaf.Sdk;
using Leaf.Sdk.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Leaf.Plugins.Outfits;

public sealed class OutfitsPlugin : ILeafPlugin
{
    public const string PluginId = "outfits";
    private const string OutfitAutomationSlug = "automation-nova-outfit-change";
    private const string OutfitSkillSlug = "outfit";
    private const string LegacyApiPath = "/api/apps/nova/outfits";
    private const string ApiPath = "/api/apps/outfits";
    private const string ExecutionAuthHeader = "-H \"Authorization: Bearer $REDLEAF_EXECUTION_TOKEN\"";
    private const string EntityGenerateCommand =
        "curl -sS -o outfit.png -X POST http://127.0.0.1:18804/api/apps/provider-comfyui/workflows/nova_outfit_zturbo/generate " +
        ExecutionAuthHeader + " -H \"Content-Type: application/json\" " +
        "-d \"{\\\"wait\\\":true,\\\"inputs\\\":{\\\"prompt\\\":\\\"YOUR PROMPT HERE\\\",\\\"width\\\":1024,\\\"height\\\":1024}}\"";

    public PluginManifest Manifest { get; } = LoadManifest();

    private static PluginManifest LoadManifest()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("plugin.json")
            ?? throw new InvalidOperationException("Embedded plugin.json is missing");
        using var reader = new StreamReader(stream);
        return PluginManifest.Parse(reader.ReadToEnd());
    }

    public void ConfigureServices(IServiceCollection services, PluginContext ctx) { }

    public void MapEndpoints(RouteGroupBuilder group) => OutfitEndpoints.Map(group);

    public async Task OnStartupAsync(IPluginHost host, CancellationToken ct)
    {
        // The existing daily automation is user data, not a plugin seed. Its
        // persisted prompt contains the former Nova-owned endpoint, so migrate
        // that string in place without recreating the automation or its history.
        var store = host.GetRequiredService<IEntityStore>();
        var skill = await store.GetBySlugAsync("agent-skill", OutfitSkillSlug, ct);
        var instructions = skill is null ? null : OutfitData.String(skill.Data, "instructions");
        var migratedInstructions = MigrateSkillInstructions(instructions);
        if (skill is not null && migratedInstructions != null && migratedInstructions != instructions)
            await store.PatchAsync(skill.Id, new JsonObject { ["instructions"] = migratedInstructions }, ct: ct);

        var automation = await store.GetBySlugAsync("automation", OutfitAutomationSlug, ct);
        if (automation?.TypeSlug == "automation")
        {
            var prompt = OutfitData.String(automation.Data, "prompt");
            var migrated = MigrateAutomationPrompt(prompt);
            if (migrated != null)
            {
                if (migrated != prompt)
                    await store.PatchAsync(automation.Id, new JsonObject { ["prompt"] = migrated }, ct: ct);

                var flowIdText = automation.Data["workflow"]?["entity_id"]?.GetValue<string>();
                if (Guid.TryParse(flowIdText, out var flowId)
                    && await store.GetAsync(flowId, ct) is { TypeSlug: "flow" } flow
                    && flow.Data["graph"] is JsonObject graph)
                {
                    var migratedGraph = MigrateFlowGraph(graph, migrated);
                    if (migratedGraph is not null)
                        await store.PatchAsync(flow.Id, new JsonObject { ["graph"] = migratedGraph }, ct: ct);
                }
            }
        }

        // Older disabled automation wrappers still point at historical outfit flows.
        // Keep those executable too instead of only repairing today's linked flow.
        var flows = new List<LeafEntity>();
        for (var offset = 0;; offset += 500)
        {
            var page = await store.QueryAsync(new EntityQuery
            {
                TypeSlug = "flow",
                Limit = 500,
                Offset = offset,
            }, ct);
            flows.AddRange(page);
            if (page.Count < 500) break;
        }

        foreach (var flow in flows)
        {
            if (flow.Data.ContainsKey("owner_plugin")) continue;
            var migratedGraph = MigrateStoredFlowPrompts(flow.Data["graph"]);
            if (migratedGraph is not null)
                await store.PatchAsync(flow.Id, new JsonObject { ["graph"] = migratedGraph }, ct: ct);
        }

    }

    internal static string? MigrateAutomationPrompt(string? prompt)
    {
        if (prompt is null) return null;
        var migrated = prompt.Replace(LegacyApiPath, ApiPath, StringComparison.Ordinal);
        migrated = Regex.Replace(migrated,
            @"(?m)^\s*curl -s -o outfit\.png -X POST http://localhost:18800/image-gen/generate[^\r\n]*$",
            EntityGenerateCommand);
        migrated = AddExecutionIdentity(migrated,
            "http://127.0.0.1:18804/api/apps/provider-comfyui/workflows/nova_outfit_zturbo/generate");
        migrated = AddExecutionIdentity(migrated,
            "http://localhost:18804/api/assets/upload");
        migrated = AddExecutionIdentity(migrated,
            "http://127.0.0.1:18804/api/assets/upload");
        migrated = AddExecutionIdentity(migrated,
            "http://127.0.0.1:18804/api/apps/outfits/select");
        return AddExecutionIdentity(migrated,
            "http://127.0.0.1:18804/api/apps/outfits");
    }

    internal static JsonObject? MigrateFlowGraph(JsonObject graph, string prompt)
    {
        var clone = (JsonObject)graph.DeepClone();
        if (clone["nodes"] is not JsonArray nodes) return null;

        foreach (var node in nodes.OfType<JsonObject>())
        {
            if (node["type"]?.GetValue<string>() != "nova-session") continue;
            if (node["data"]?["config"] is not JsonObject config) continue;
            if (config["prompt"]?.GetValue<string>() == prompt) return null;
            config["prompt"] = prompt;
            return clone;
        }

        return null;
    }

    internal static JsonNode? MigrateStoredFlowPrompts(JsonNode? storedGraph)
    {
        var wasString = false;
        JsonObject graph;
        if (storedGraph is JsonObject graphObject)
        {
            graph = graphObject;
        }
        else if (storedGraph is JsonValue value
                 && value.TryGetValue<string>(out var json)
                 && JsonNode.Parse(json) is JsonObject parsed)
        {
            graph = parsed;
            wasString = true;
        }
        else
        {
            return null;
        }

        var clone = (JsonObject)graph.DeepClone();
        if (clone["nodes"] is not JsonArray nodes) return null;
        var changed = false;
        foreach (var node in nodes.OfType<JsonObject>())
        {
            if (node["type"]?.GetValue<string>() != "nova-session") continue;
            if (node["data"]?["config"] is not JsonObject config) continue;
            var prompt = config["prompt"]?.GetValue<string>();
            var migrated = MigrateAutomationPrompt(prompt);
            if (migrated is null || migrated == prompt) continue;
            config["prompt"] = migrated;
            changed = true;
        }

        if (!changed) return null;
        return wasString ? JsonValue.Create(clone.ToJsonString()) : clone;
    }

    internal static string? MigrateSkillInstructions(string? instructions)
    {
        if (instructions is null) return null;
        var migrated = Regex.Replace(instructions,
            @"(?m)^- \*\*Generate image\*\*: `POST http://127\.0\.0\.1:18800/image-gen/generate`[^\r\n]*$",
            "- **Generate image**: `POST http://127.0.0.1:18804/api/apps/provider-comfyui/workflows/nova_outfit_zturbo/generate` - `{wait: true, inputs: {prompt, width: 1024, height: 1024, steps: 12, cfg: 1.3}}`. Send `Authorization: Bearer $REDLEAF_EXECUTION_TOKEN` on every mutating RedLeaf request so the parent session's signed identity is preserved. The provider resolves and validates the versioned workflow entity, submits a frozen snapshot to RedCompute, and returns the image when `wait` is true.");
        if (migrated.Contains("/api/apps/provider-comfyui/workflows/", StringComparison.Ordinal)
            && !migrated.Contains("REDLEAF_EXECUTION_TOKEN", StringComparison.Ordinal))
            migrated = migrated.Replace(
                "The provider resolves and validates the versioned workflow entity",
                "Send `Authorization: Bearer $REDLEAF_EXECUTION_TOKEN` on every mutating RedLeaf request so the parent session's signed identity is preserved. The provider resolves and validates the versioned workflow entity",
                StringComparison.Ordinal);
        return Regex.Replace(migrated,
            @"(?s)\r?\n## Interactive provenance\r?\n.*?(?=\r?\n## Prompt structure)",
            "\n");
    }

    private static string AddExecutionIdentity(string text, string endpoint)
    {
        return Regex.Replace(text,
            $@"(?m)^(?<prefix>\s*curl[^\r\n]*?{Regex.Escape(endpoint)})(?<suffix>[^\r\n]*)$",
            match => match.Value.Contains("REDLEAF_EXECUTION_TOKEN", StringComparison.Ordinal)
                ? match.Value
                : $"{match.Groups["prefix"].Value} {ExecutionAuthHeader}{match.Groups["suffix"].Value}");
    }
}
