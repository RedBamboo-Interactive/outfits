using System.Reflection;
using System.Text.Json.Nodes;
using Leaf.Sdk;
using Leaf.Sdk.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Leaf.Plugins.Outfits;

public sealed class OutfitsPlugin : ILeafPlugin
{
    public const string PluginId = "outfits";
    private const string OutfitAutomationSlug = "automation-nova-outfit-change";
    private const string LegacyApiPath = "/api/apps/nova/outfits";
    private const string ApiPath = "/api/apps/outfits";

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
        var automation = await store.GetBySlugAsync(OutfitAutomationSlug, ct);
        if (automation?.TypeSlug != "automation") return;

        var prompt = OutfitData.String(automation.Data, "prompt");
        var migrated = MigrateAutomationPrompt(prompt);
        if (migrated == null || migrated == prompt) return;

        await store.PatchAsync(automation.Id, new JsonObject { ["prompt"] = migrated }, ct: ct);
    }

    internal static string? MigrateAutomationPrompt(string? prompt)
        => prompt?.Replace(LegacyApiPath, ApiPath, StringComparison.Ordinal);
}
