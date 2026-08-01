using Leaf.Plugins.Outfits;
using Xunit;

namespace Leaf.Plugins.Outfits.Tests;

public sealed class OutfitsPluginTests
{
    [Fact]
    public void Manifest_ExtendsNovaWithoutMakingItALifecycleDependency()
    {
        var manifest = new OutfitsPlugin().Manifest;

        Assert.DoesNotContain("nova", manifest.Requires);
        Assert.Contains("entities", manifest.Requires);
        Assert.Contains("assets", manifest.Requires);
        Assert.Contains("discussions", manifest.Requires);
        var extension = Assert.Single(manifest.Frontend!.Extensions);
        Assert.Equal("avatar-action", extension.Id);
        Assert.Equal("nova", extension.Target);
        Assert.Equal("chat-avatar-overlay", extension.Slot);
    }

    [Fact]
    public void MigrateAutomationPrompt_RewritesEveryLegacyEndpoint()
    {
        const string prompt = "GET /api/apps/nova/outfits then POST /api/apps/nova/outfits/select";

        var migrated = OutfitsPlugin.MigrateAutomationPrompt(prompt);

        Assert.Equal("GET /api/apps/outfits then POST /api/apps/outfits/select", migrated);
        Assert.DoesNotContain("/api/apps/nova/outfits", migrated, StringComparison.Ordinal);
    }

    [Fact]
    public void MigrateAutomationPrompt_IsIdempotentAndNullSafe()
    {
        const string prompt = "POST /api/apps/outfits";

        Assert.Equal(prompt, OutfitsPlugin.MigrateAutomationPrompt(prompt));
        Assert.Null(OutfitsPlugin.MigrateAutomationPrompt(null));
    }
}
