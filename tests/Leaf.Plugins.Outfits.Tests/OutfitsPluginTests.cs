using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
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

    [Fact]
    public void MigrateAutomationPrompt_UsesEntityOwnedComfyUiWorkflow()
    {
        const string prompt = "Generate:\n```bash\ncurl -s -o outfit.png -X POST http://localhost:18800/image-gen/generate -H \"Content-Type: application/json\" -d \"legacy\"\n```";

        var migrated = OutfitsPlugin.MigrateAutomationPrompt(prompt)!;

        Assert.Contains("/api/apps/provider-comfyui/workflows/nova_outfit_zturbo/generate", migrated);
        Assert.Contains("Authorization: Bearer $REDLEAF_EXECUTION_TOKEN", migrated);
        Assert.Contains("\\\"wait\\\":true", migrated);
        Assert.DoesNotContain("localhost:18800/image-gen/generate", migrated);
    }

    [Fact]
    public void MigrateAutomationPrompt_CarriesSessionIdentityThroughEveryMutation()
    {
        const string prompt = """
            curl -sS -o outfit.png -X POST http://127.0.0.1:18804/api/apps/provider-comfyui/workflows/nova_outfit_zturbo/generate -H "Content-Type: application/json" -d "{}"
            curl -s -X POST http://localhost:18804/api/assets/upload -F file=@outfit.png
            curl -s -X POST http://127.0.0.1:18804/api/apps/outfits -H "Content-Type: application/json" -d "{}"
            curl -s -X POST http://127.0.0.1:18804/api/apps/outfits/select -H "Content-Type: application/json" -d "{}"
            """;

        var migrated = OutfitsPlugin.MigrateAutomationPrompt(prompt)!;

        Assert.Equal(4, Regex.Matches(migrated,
            "Authorization: Bearer \\$REDLEAF_EXECUTION_TOKEN").Count);
        Assert.Equal(migrated, OutfitsPlugin.MigrateAutomationPrompt(migrated));
    }

    [Fact]
    public void MigrateFlowGraph_RewritesNovaSessionPromptWithoutMutatingSource()
    {
        var graph = JsonNode.Parse("""
            {"nodes":[{"type":"nova-session","data":{"config":{"prompt":"old"}}}]}
            """)!.AsObject();

        var migrated = OutfitsPlugin.MigrateFlowGraph(graph, "new")!;

        Assert.Equal("old", graph["nodes"]![0]!["data"]!["config"]!["prompt"]!.GetValue<string>());
        Assert.Equal("new", migrated["nodes"]![0]!["data"]!["config"]!["prompt"]!.GetValue<string>());
        Assert.Null(OutfitsPlugin.MigrateFlowGraph(migrated, "new"));
    }

    [Fact]
    public void MigrateSkillInstructions_ReplacesDirectComputeAndRetiresManualProvenanceRecipe()
    {
        const string instructions = """
            ## Key APIs
            - **Generate image**: `POST http://127.0.0.1:18800/image-gen/generate` - `{workflow: "nova_outfit_zturbo", prompt}`

            ## Interactive provenance
            Send a hand-written X-Compute-Provenance header.

            ## Prompt structure
            Keep this section.
            """;

        var migrated = OutfitsPlugin.MigrateSkillInstructions(instructions)!;

        Assert.Contains("/api/apps/provider-comfyui/workflows/nova_outfit_zturbo/generate", migrated);
        Assert.Contains("Authorization: Bearer $REDLEAF_EXECUTION_TOKEN", migrated);
        Assert.DoesNotContain("127.0.0.1:18800", migrated);
        Assert.DoesNotContain("Interactive provenance", migrated);
        Assert.Contains("## Prompt structure", migrated);
    }
}
