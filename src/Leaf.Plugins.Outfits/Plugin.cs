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
    private const string EntityGenerateCommand =
        "curl -sS -o outfit.png -X POST http://127.0.0.1:18804/api/apps/provider-comfyui/workflows/nova_outfit_zturbo/generate " +
        "-H \"Content-Type: application/json\" -d \"{\\\"wait\\\":true,\\\"inputs\\\":{\\\"prompt\\\":\\\"YOUR PROMPT HERE\\\",\\\"width\\\":1024,\\\"height\\\":1024}}\"";

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
        if (automation?.TypeSlug != "automation") return;

        var prompt = OutfitData.String(automation.Data, "prompt");
        var migrated = MigrateAutomationPrompt(prompt);
        if (migrated == null) return;

        if (migrated != prompt)
            await store.PatchAsync(automation.Id, new JsonObject { ["prompt"] = migrated }, ct: ct);

        var flowIdText = automation.Data["workflow"]?["entity_id"]?.GetValue<string>();
        if (!Guid.TryParse(flowIdText, out var flowId)) return;
        var flow = await store.GetAsync(flowId, ct);
        if (flow is not { TypeSlug: "flow" }) return;

        var graph = flow.Data["graph"] as JsonObject;
        if (graph is null) return;
        var migratedGraph = MigrateFlowGraph(graph, migrated);
        if (migratedGraph is not null)
            await store.PatchAsync(flow.Id, new JsonObject { ["graph"] = migratedGraph }, ct: ct);

    }

    internal static string? MigrateAutomationPrompt(string? prompt)
    {
        if (prompt is null) return null;
        var migrated = prompt.Replace(LegacyApiPath, ApiPath, StringComparison.Ordinal);
        return Regex.Replace(migrated,
            @"(?m)^\s*curl -s -o outfit\.png -X POST http://localhost:18800/image-gen/generate[^\r\n]*$",
            EntityGenerateCommand);
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

    internal static string? MigrateSkillInstructions(string? instructions)
    {
        if (instructions is null) return null;
        var migrated = Regex.Replace(instructions,
            @"(?m)^- \*\*Generate image\*\*: `POST http://127\.0\.0\.1:18800/image-gen/generate`[^\r\n]*$",
            "- **Generate image**: `POST http://127.0.0.1:18804/api/apps/provider-comfyui/workflows/nova_outfit_zturbo/generate` - `{wait: true, inputs: {prompt, width: 1024, height: 1024, steps: 12, cfg: 1.3}}`. The provider resolves and validates the versioned workflow entity, submits a frozen snapshot to RedCompute, and returns the image when `wait` is true.");
        return Regex.Replace(migrated,
            @"(?s)\r?\n## Interactive provenance\r?\n.*?(?=\r?\n## Prompt structure)",
            "\n");
    }
}
