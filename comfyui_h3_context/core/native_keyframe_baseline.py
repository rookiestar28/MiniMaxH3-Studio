"""Audited native keyframe/image-guide AST digests and closed dependency surface.

Provenance identifies the audited input only; runtime admission never compares it.
The complete AddGuide definition is conserved; this does not enable audio execution.
"""

from typing import TypedDict


class _ManifestData(TypedDict):
    source_revision: str
    source_blob: str
    definitions: tuple[tuple[str, str], ...]
    constants: tuple[tuple[str, str], ...]
    package_roots: tuple[str, ...]
    required_imports: tuple[str, ...]
    from_bindings: tuple[tuple[str, str], ...]
    envelope_bindings: tuple[tuple[str, str], ...]
    protected_builtins: tuple[str, ...]
    external_paths: tuple[str, ...]


MANIFEST_DATA: _ManifestData = {
    "source_revision": "fe298e4e20f1ff26d30e8639267bbd0b57811390",  # pragma: allowlist secret
    "source_blob": "1ad3c6a4095fdcb756d6222f08ba589452b72091",  # pragma: allowlist secret
    "definitions": (
        (
            "align_frame_count",
            "sha256:815144140ac0f0c20a42a56f1168ca3086485456a52b4cb552b1d84c362c5cd3",
        ),
        (
            "video_latent_t",
            "sha256:ddbe78607984329c205ec059fbad8114c5055e2a639c64cb7aceeb685316b0af",
        ),
        (
            "temporal_shape",
            "sha256:5632544f143ed19e2cda997c2493292317d42bd117c572a4cb0bdf0e1c60b86f",
        ),
        ("_resize", "sha256:96f2913538594100cb93e5b1c7bcb0d9b7c3fc9e9c174797c1a40410a4e3eb2f"),
        (
            "_encode_ref_audio",
            "sha256:b26132500b2e30d77567c5a5f39faf3beadbeadcf3e43c6235c8b467c6bdbed0",
        ),
        (
            "_empty_av_latent",
            "sha256:26fadedcd7bbed2d72094e8bb20ec2f4b4f3b125dad8eeba57f14092a6e3351d",
        ),
        (
            "EmptyMiniMaxH3LatentAV",
            "sha256:86eada1c51a9b09e633bb3404517041df858963f8873a914b042883f0005d717",
        ),
        (
            "MiniMaxH3SigmaShift",
            "sha256:6cb500867f47b7a0c6498d5cf564663d079ce1ac60bde13ab3a23b947248cbc6",
        ),
        (
            "MiniMaxH3ImageToVideo.define_schema",
            "sha256:48dbcd4e98c2b9afa141e3087700d870a385f9d901591489efe0b364abbb2857",
        ),
        (
            "MiniMaxH3ImageToVideo.execute",
            "sha256:6f3fd4575f704aec42ae1af1caf9391804aa1918d58ef13e0fe84a08564cb893",
        ),
        (
            "MiniMaxH3ImageToVideo",
            "sha256:1fbe4e8c7fcb3c103ad1b24933b2b0759f7bfdb50df741013a409895db2ac33f",
        ),
        (
            "MiniMaxH3AddGuide.define_schema",
            "sha256:9102fff0ecaea9c0d18683db8736825644d44ec432af0f750b5c27afd62abace",
        ),
        (
            "MiniMaxH3AddGuide.execute",
            "sha256:36eaca7843593620bddc95b837c097ae835ce2be8ed83ea9b80bd8f409c91485",
        ),
        (
            "MiniMaxH3AddGuide",
            "sha256:09c402c1a3f08725eae7ac983b15a4483c1a76fcb356987ee704d29f1303c64b",
        ),
    ),  # pragma: allowlist secret
    "constants": (
        (
            "CANVAS_MULTIPLE",
            "sha256:4bbc40eb232c133e8bfac3e9ad8c165931f54112e6a4d551c7f95e085ab55b32",
        ),
        (
            "BASE_SHORT_EDGE",
            "sha256:383289f43aec04145db7c86df39ccb6565aaf082853fb99f94e3429cd7684556",
        ),
        ("MAX_PIXELS", "sha256:ff31347e6d92b88b7149ba78d54671ce195da18493b701b5900584aab950956c"),
        (
            "REF_IMAGE_SHORT_EDGE",
            "sha256:a60810bf232af0fd71e3fb9a7bba6bdec75c7beb956760663bbb41bf3102ed10",
        ),
        ("FPS", "sha256:27b17d774039c50a8b7aef6aaf060822b36c06f89a6b813fce2ada32caaaf0a9"),
        (
            "AUDIO_LATENT_FPS",
            "sha256:ddd3a27d187f8af6911bdaab2b520ec49bae831f1c30d48f923cc0440d2dff98",
        ),
    ),  # pragma: allowlist secret
    "package_roots": (
        "comfy",
        "math",
        "node_helpers",
        "nodes",
        "torch",
    ),  # pragma: allowlist secret
    "required_imports": (
        "comfy.audio",
        "comfy.model_management",
        "comfy.model_sampling",
        "comfy.nested_tensor",
        "comfy.utils",
        "math",
        "node_helpers",
        "nodes",
        "torch",
    ),  # pragma: allowlist secret
    "from_bindings": (
        ("FRAME_PER_TOKEN", "comfy.ldm.minimax.model"),
        ("FRAME_RESCALE", "comfy.ldm.minimax.model"),
        ("io", "comfy_api.latest"),
    ),  # pragma: allowlist secret
    "envelope_bindings": (("ComfyExtension", "comfy_api.latest"),),  # pragma: allowlist secret
    "protected_builtins": (
        "ValueError",
        "classmethod",
        "getattr",
        "hasattr",
        "len",
        "list",
        "max",
        "range",
        "round",
        "staticmethod",
        "sum",
    ),  # pragma: allowlist secret
    "external_paths": (
        "comfy.audio.resample",
        "comfy.model_management.intermediate_device",
        "comfy.model_sampling.CONST",
        "comfy.model_sampling.ModelSamplingAV",
        "comfy.nested_tensor.NestedTensor",
        "comfy.utils.common_upscale",
        "io.Audio.Input",
        "io.Clip.Input",
        "io.ComfyNode",
        "io.Conditioning.Input",
        "io.Conditioning.Output",
        "io.Float.Input",
        "io.Image.Input",
        "io.Int.Input",
        "io.Latent.Input",
        "io.Latent.Output",
        "io.Model.Input",
        "io.Model.Output",
        "io.NodeOutput",
        "io.Schema",
        "io.String.Input",
        "io.Vae.Input",
        "math.floor",
        "node_helpers.conditioning_set_values",
        "nodes.MAX_RESOLUTION",
        "torch.zeros",
    ),  # pragma: allowlist secret
}
