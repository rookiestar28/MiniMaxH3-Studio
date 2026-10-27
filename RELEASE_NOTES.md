# Release 1.4.1

## Newer ComfyUI frontends

- App Mode works with ComfyUI frontend 1.56.1 and later. These frontends add the node pack's
  identity (`cnr_id`, `aux_id` and `ver`) beside each node's title in the compiled workflow. 1.4.0
  accepted only the title there, so preparing, connecting or queueing an H3 graph stopped with "The
  visible H3 graph could not be compiled." These three details are now accepted as short text; any
  other addition is still refused. Earlier frontends behave as before.
- The clip editor and image crop open with frontend 1.57.1 and later. These frontends report
  whether ComfyUI's mask editor is open in a different way, so 1.4.0 could not keep its own keys
  apart from ComfyUI's shortcuts there: **Open full editor** said the full editor was unavailable,
  and **Crop image** said the image could not be opened. Both ways are now supported. Keys used
  inside the editor or the crop dialog, such as Ctrl+Z, still stay there instead of changing the
  canvas, and ComfyUI's own shortcuts work again once they close.
- ComfyUI frontends from 1.59.0 no longer mark a dark palette the way earlier frontends do, so
  1.4.0 showed the sidebar, crop dialog and clip editor in light colours even with a dark palette.
  They now also read the palette's colour scheme, and earlier frontends' dark-palette marker works
  as before.
- Frontend 1.57.1 and later lay out the side panels differently, so 1.4.0 lost the sidebar's width
  limits there: it kept its minimum width in a narrow window and could reach past the window edge.
  The sidebar now finds both panel layouts and stays within the window and clear of a panel open on
  the other side. It keeps its usual minimum width when the window has room.
- On earlier frontends, a sidebar at its minimum width could stay too wide after the window was
  made narrower, and reach past the window edge until the window was widened again. It now follows
  the window in both directions, on every frontend.

## Clip editor

- Hover descriptions of icon buttons keep a readable width, up to the space the editor shows. A
  button alone in its group used to squeeze its description to the button's width, which split
  words across lines.
- The empty preview monitor and empty timeline tracks now say to click a thumbnail in **Media**,
  which adds it to the timeline. They no longer mention a **+** button that the media bin does not
  show. The hints are updated in English, Traditional Chinese and Simplified Chinese.

## Language setting

- **Settings → Language** lists the Traditional Chinese option as 正體中文, in every interface
  language. The saved setting is unchanged, so an existing choice stays selected.

## Compatibility

- The clip editor, image crop and App Mode were tested on ComfyUI 0.42.0 with frontend 1.55.18 and
  with frontend 1.57.1, including the light and dark palettes and narrow windows.

## Package links

- The package's repository, documentation, issue tracker and icon links now use the repository's
  current name, `MiniMaxH3-Studio`, so they no longer go through GitHub's redirect from the old name.
  The Comfy Registry name **ComfyUI-MiniMaxH3-Studio** is unchanged.

## Developer notes

- Browser tests model both side-panel layouts and both palette signals, and narrow and widen one
  page step by step instead of only loading it at each size. Unit tests cover both ways the host
  reports the mask editor and the node pack details in compiled workflows.

## Upgrade and limits

Replace the complete package, restart ComfyUI and refresh the browser. Project, settings and other
public data formats are unchanged from 1.4.0. The supported FFmpeg build, platform requirements and
storage requirements are unchanged.

---

# Release 1.4.0

## Clip editor transitions

- The Transition tab offers four directional wipes beside **Cross dissolve**: wipe from the left,
  right, top or bottom. A wipe uses the same transition length in frames, and the final video
  closely matches the browser preview.
- The final render now encodes H.264 at a fixed constant quality (CRF 18) instead of the encoder
  default, so flat colours match the preview more closely. Exported files can be larger.
- When a dissolve or wipe is refused, the Inspector now says it needs an enabled clip on a lower
  track that plays for the whole transition, and a length this clip allows.

## Clip editor titles

- **Add title** and the Inspector's title text and style changes refuse characters that the
  bundled Noto Sans fonts cannot draw, such as Chinese, Japanese, Korean or emoji. The reason is
  shown in English, Traditional Chinese and Simplified Chinese, and the text you typed stays in
  place. Before, such a title was accepted and only the final render failed.
- A title like this from an older project still opens and can be moved, trimmed or deleted, but
  it still cannot be rendered. If a final render fails for this reason, the message now says so.

## Compatibility

- The clip editor opens with ComfyUI frontend 1.55.11 and later, which current ComfyUI versions
  require. These frontends changed how the graph canvas is exposed, and 1.3.2 and earlier could
  not open the editor there. Older frontends work as before.
- The clip editor and image crop were tested on ComfyUI 0.41.0 with frontend 1.55.18.

## App Mode sources

- **Start H3 App Mode** and **Replace canvas and start H3 App Mode** prepare I2VA, FL2VA, L2VA and
  Ref2VA canvases before a source is chosen. The official template's **Load Image** nodes are kept
  and hold the template's sample images until you set your own. Queueing works as before; for
  Ref2VA, choose the references in the pickers before queueing.
- When a source list is empty, the sidebar names the node to add to the main canvas (outside
  subgraphs). After preparation it lists which **Load Image** nodes still hold the template's
  samples. This guidance stays in place when ComfyUI rescans the graph, in English, Traditional
  Chinese and Simplified Chinese.

## Image crop

- **Crop image** beside a first frame, last frame or reference image opens a crop dialog. Drag the
  rectangle or its eight handles. The arrow keys move a focused rectangle by one source pixel, or
  ten with Shift; on a focused handle they resize by the same amount in Free mode, and in whole
  ratio steps with Original or a fixed aspect ratio. Choose Free, Original or a fixed aspect ratio,
  then **Apply**. The source row shows the cropped size. To remove a crop, choose **Reset**, which
  returns the rectangle to the full image, then **Apply**.
- Starting or replacing a canvas inserts one native **Crop Image** node per cropped source, before
  all of its consumers. On an existing canvas, edit that visible node directly. Videos and audio
  have no crop action, and changing modes or removing the image clears its crop.
- In I2VA the output follows the crop's aspect ratio. In FL2VA and L2VA the output size comes from
  the canvas resolution setting, so choose a crop ratio that matches it.
- A crop is applied only when the canvas is prepared. While a crop is applied, **Execute** asks you
  to use **Start H3 App Mode** or **Replace canvas and start H3 App Mode**, or to reset the crop.
- Opening the dialog reads the image from your ComfyUI host into the browser. App Mode writes no
  image file; ComfyUI's crop node may save a preview of the cropped picture in its temporary
  folder. A host without the native Crop Image node cannot prepare a cropped canvas.

## Model loaders

- App Mode identifies each official H3 loader by the complete set of official file names for its
  role, including loaders inside nested or promoted widgets.
- It keeps the template's own choice when that file is installed in any subfolder; otherwise it
  uses another installed official variant for the role, such as the int8 convrot video VAE or the
  pruned w6a8 FL2VA and Ref2VA models. If none is installed, the loader is named as a warning as
  before.

## Assisted authoring

- **Refine prompt** follows instructions that ask for camera moves or cuts between shots. The
  request counts at every check of the suggestion, including after you edit or accept it. An
  explicit static-camera, no-cuts or single-shot restriction still wins, and dialogue, on-screen
  text, reference labels, roles and timing stay exact.
- A suggestion that drops, adds or reorders a reference label gets the single repair attempt, which
  asks for the original labels; if they are still wrong, the suggestion is refused.
- A suggestion that would change protected text, change the references or fail the audit is
  refused with a specific message, and your prompt is left unchanged. **Optimize prompt** behaves
  as before.
- **Optimize prompt** and **Refine prompt** keep required content that is already in the prompt and
  never add forbidden content. The check runs on the first suggestion, its single repair, your
  edits and acceptance; a suggestion that would break it is refused with its own message. Problems
  already present in your prompt are not blamed on the suggestion and stay fixable.

## Platform

- The prompt pipeline supports Windows, Linux and WSL. The editor, Production import, assembly and
  final rendering still need Windows x64 with 64-bit Python and the supported FFmpeg build, and
  durable recovery still needs its qualified Windows host. Linux support for these features is
  coming in an upcoming update.

## Developer notes

- Browser test failure evidence now includes bounded, sanitized presentation stage clocks for the
  integrated navigation and continuous preview journeys, and the test job log keeps numeric
  summaries of the same stages. Reports omit prompt, media, path, URL and credential content. This
  improves diagnosis; no performance budget changes.

## Repository name

- The GitHub repository is renamed from `ComfyUI-MiniMaxH3-Studio` to `MiniMaxH3-Studio`. GitHub
  redirects the old address, so existing clones, remotes and links keep working, and an existing
  installation folder can keep its name. The Comfy Registry name **ComfyUI-MiniMaxH3-Studio** and
  the `minimax-h3-studio` install name are unchanged.

## Upgrade and limits

Replace the complete package, restart ComfyUI and refresh the browser. Project format version 1 is
unchanged, but a project or saved draft that uses a directional wipe needs 1.4.0 or later; 1.3.2
and earlier refuse it rather than dropping the wipe. The supported FFmpeg build, platform
requirements and storage requirements are unchanged from 1.3.2.

---

# Release 1.3.2

## App Mode output verification

- App Mode runs finish on current ComfyUI versions. ComfyUI now annotates each saved video entry
  with media details and, when its asset system is enabled, an asset identifier. 1.3.0 accepted
  only the exact earlier entry shape, so it ignored the saved video, and the finished run stayed at
  "Verifying the exact saved output" indefinitely.
- Saved video entries are read by their file name, folder and output type; any other detail is
  ignored and never stored.
- If ComfyUI's saved-video message is missing or not recognized when the run finishes, the sidebar
  reads that run's ComfyUI history for up to about 16 seconds. Exactly one saved video completes
  the run through the same verification as before. Otherwise the run ends with the existing "could
  not be verified safely" message and **Continue with native nodes**; the saved file is left
  unchanged and nothing is queued again. A saved-video message that arrives while the sidebar is
  still waiting still completes the run.

## Reference limits

- The Reference Registry, reference normalization and reference-set authoring refuse more than
  three audio tracks in total, including video soundtracks. The Registry node refuses before
  generation starts; authoring refuses when a source is added or restored. Before, canvas graphs
  could pass up to six audio tracks, and only the native adapter refused them when the run reached
  it. The sidebar limits and the native node are unchanged.

## Developer notes

- Tests decode the current ComfyUI saved-output shape. A model-free host row decodes the host's real
  saved-output message and history record. The weight-backed sample also checks that the sidebar
  reaches its finished state.

## Upgrade and limits

Replace the complete package, restart ComfyUI and refresh the browser. Project, receipt and settings
formats and the other public data formats are unchanged from 1.3.0. A graph that passes more than
three audio tracks in total to the reference nodes was already refused by the native adapter; it is
now refused before generation starts, with a message naming the audio limit.

---

# Release 1.3.0

## Reference generation

- Ref2VA now executes linked image, video and audio references from the sidebar and bundled
  Reference graphs. The Reference Registry accepts the individual numbered inputs created by
  these graphs while preserving callers that provide grouped reference values.
- Select up to 9 images, 3 videos and 3 standalone audio references. The combined limit is
  12 files and 3 audio tracks, including soundtracks taken from videos. At least one image or
  video is required in the sidebar. Video soundtracks are included for all selected videos or
  excluded for all; a selection that exceeds the combined limits is refused before execution.
- Reorder or remove individual references with keyboard-accessible controls. Source chips and
  final labels show their order before graph application, and each new loader occupies its own
  row. Paired soundtracks keep their video identity; standalone audio numbering stays independent.
- Ref2VA duration hints are guidance for preparing inputs. Selecting canvas nodes does not read
  their media files or verify their duration.

## Sequence assembly

- New assemblies default to **Original size (24 fps)**: the segments' common original size,
  24 fps video and 32 kHz stereo audio, with one aggregate video encode. Segments with mismatched
  sizes are refused. The previous **512 × 512 (30 fps)** format with 48 kHz stereo sound remains
  selectable before assembly.
- View a per-cut report after assembly. **smooth**, **visible change** and **not measured** are
  bounded measurements of the segment boundary, not guarantees of visual/audio continuity.
  Assembly still joins independently generated segments and does not create new transition frames.
- A sequence that finishes before the media runtime activates now offers assembly after the
  runtime becomes available and Production is read again. Runtime checks remain non-blocking.
- English assembly inputs show segment and cut counts without fixed plural nouns. Both Chinese
  translations keep their existing meaning.

## Developer diagnostics

- Browser test failure evidence includes bounded, sanitized presentation timings for the current
  interaction phase. Reports omit prompt, media, path, URL and credential content. This improves
  diagnosis; no presentation-time budget or performance guarantee changes.
- Frontend unit tests use a bounded worker pool so evidence collection keeps its original deadline.
- Sequence browser fixtures use the current assembly profile contract and cover unavailable,
  ready, running and completed states. Executable admission comments now state the integrity
  threat model and the limits of the Windows read pin; the mechanism is unchanged.
- Workspace maintenance tools bind removal to a reviewed manifest, reverify quarantined entries
  before resumed removal, and handle WSL links explicitly while refusing unproven reparse tags.

## Upgrade and limits

Replace the complete package, restart ComfyUI and refresh the browser. Save editable projects and
preserve media separately before updating. Project format version 1 and its existing title
decoration compatibility remain unchanged. Assembly receipts use the new version 2 profile/cut
report contract; older software that understands only version 1 refuses the new receipts.

Use the current bundled reference examples. For an older saved API prompt, connect each reference
to its own numbered Registry input instead of placing multiple links inside one input value.

The editor's final render remains 1920 × 1080 at 24 fps and is separate from sequence assembly.
The supported FFmpeg build, native Windows media/recovery requirements, manual tool setup and
local-only perception setup are unchanged. Longer-video sequence generation remains limited to
text-to-video plans; this release does not enable continuous-sequence generation or qualify new
hosts or models.

---

# Release 1.2.1

## Manual media tools setup

- The extension no longer downloads, extracts or installs FFmpeg. **Settings → Media tools**
  replaces in-panel installation with a manual setup guide: **Open download page** opens the
  exact release page in your browser, and the card shows the archive name and its SHA-256 with a
  copy button.
- Enter the extracted **bin** folder and choose **Use folder**. Both programs are verified against
  their fixed digests before the selection is saved. A supported pair in your Python environment
  or on `PATH` is still found automatically; choose **Check again** after changing `PATH`.
- A **?** button beside **Media tools** explains download, checksum verification (with Windows
  commands), extraction, folder selection and why other builds are refused. It is available in
  English, Traditional Chinese and Simplified Chinese.
- After you select the tools, retry the original media action yourself; it is not resumed
  automatically.
- Clean up known earlier setup leftovers only when requested, preserving unknown files and any
  parked runtime without a verified replacement.

## Sequence assembly fix

- Sequences built from your own ComfyUI video generations now assemble. Earlier versions
  refused these segments: first because of the color tag ComfyUI writes into its video files,
  and then, for 5-second and 15-second segments, because the file states its length rounded to
  the millisecond.
- Segments with that color tag are converted to the standard video color space while they are
  prepared for assembly. Segments that are already standard are prepared as before.

## Upgrade and limits

Replace the complete package, restart ComfyUI and refresh the browser. Tools that 1.2.0 or an
earlier version already installed are still discovered and verified; no action is needed. The
supported build, platforms and project format are unchanged from 1.2.0.

---

# Release 1.2.0

## Titles and editing

- Add strokes, sharp shadows and background padding to titles. Enable or reset
  each decoration separately while preserving the other text settings.
- Preserve literal line breaks, including blank and trailing lines, in both the
  browser preview and native rendering. Text alignment places individual lines
  inside the title canvas; clip alignment places the whole canvas.
- Save accepted decoration settings in project files and acknowledged draft
  recovery, with the existing undo/redo behavior.
- Rename the ripple toggle to **Ripple edits**. Trims and ripple deletes keep
  their existing edited-track scope, including supported overlay tracks.
- Separate timeline viewport, gestures, transport and presentation responsibilities
  while preserving the existing editor commands and interactions.
- Reuse unchanged clip controls while keeping clip identities and action handlers
  synchronized with the current editor state.

- Reduce repeated redraws of unchanged timeline, monitor and media controls during
  edits. Keep seeking and toolbar actions synchronized with the current editor state.

## Optional local perception

- Configure the existing qualified visual or audio profile through an
  operator-owned startup file, or keep using the existing programmatic host
  registration. Configuration is separate from assisted-authoring provider settings.
- Inspect finite local-perception readiness in Settings. The status read does not
  launch a model, edit host paths or install dependencies.
- Queue the full-reference visual timeline when a qualified connected visual result,
  the configured local profile and explicit user consent are available. The resulting
  timeline remains partial.
- Finish owned process termination before cleaning its temporary files, preserving
  cancellation and cleanup failures.

## Developer tools and distributions

- Strengthen Windows validation, subprocess accounting and CI admission while
  preserving complete test identities and native result reporting.
- Provide independently stated native-behavior oracles and explicit catalogue gaps.
- Check declared public Python interfaces against the released baseline with the
  static consumer compatibility tool.
- Separate Production assembly execution and media-use responsibilities without
  changing public generation or persistence contracts.
- Refresh generated contracts, inventories, fingerprints and provenance from their
  actual inputs, with a clean fixed point and explicit failure reporting.
- Keep public source distributions complete for developers, including tests and
  support inputs, while omitting private maintainer material. Preserve executable
  source semantics through public comment/docstring redaction and audit the actual
  source, wheel and Registry archives.

## Upgrade and limits

Replace the complete package, restart ComfyUI and refresh the browser. Save editable
projects and preserve media separately before updating.

Project format version 1 remains in use. Existing 1.1.0 project documents remain
readable. A project using the new optional title decoration members requires the
current reader; 1.1.0 readers refuse those members rather than silently discarding
them. Project files do not embed media or restore execution permissions.

The prompt pipeline supports Windows, Linux and WSL. Local perception execution
in this release supports only its qualified native Windows setup. The editor,
Production import, assembly, native rendering and durable recovery retain their
existing Windows and trusted-local-host requirements. This release does not extend
those features to Linux or WSL. Models and dependencies are never downloaded or
installed automatically; provider permission and costs remain under user control.

---

# Release 1.1.0

This release collects the completed improvements since 1.0.0, including the assisted-authoring
updates previously delivered in 1.0.2.

## Projects and recovery

- Save and open editable `.h3proj` files containing accepted Production and editor data, including
  segment relationships, storyboard, tracks, cuts, titles, transforms, effects and clip audio.
- Keep documents editable when media is missing. Explicitly relink compatible retained videos
  after current-byte and timing-profile verification; opening a file does not start work.
- Separately opt in to content-free workspace metadata, verified generated-video retention or
  editable draft recovery. All three settings are off by default.
- Recover acknowledged drafts and bounded data-only undo/redo as a new project after a restart,
  without restoring execution permissions. Pending tracked server drafts are protected from
  workspace expiry; browser-only edits are not presumed saved.
- Generated-video working copies now live outside ComfyUI's served directories. Original outputs
  are unchanged, and cleanup is bounded to recognized dead-owner storage.

## Editor and playback

- Adjust each main-track video's volume, mute and fades in the Inspector, browser preview and
  final render. Overlay videos remain silent; separate audio tracks are not supported.
- Preserve compatible preview resources through edits, prepare playback before use, and improve
  picture/audio handoff at adjacent cuts without keeping revoked sources current.
- Make title insertion atomic, explain unavailable insertion, and improve media-bin dragging
  with owned cancellation.
- Keep timeline shortcuts usable after toolbar actions and contained within the editor, and close
  clip/track menus on an outside press.
- Align the current native renderer qualification, packaged assets, import boundaries and
  downstream artifact guards without weakening source or executable verification.

## Prompt writing and provider setup

- Separate provider connections from exact model selection. Reload models without losing a still
  available selection, and show provider-reported dates, limits and lifecycle information.
- Support local Ollama and observed Gemini assisted execution; OpenAI and Anthropic retain model
  discovery and readiness checks. Provider permission remains explicit and text-only.
- Add guided prompt refinement while preserving exact dialogue, visible text, reference roles
  and timing. Review typed semantic suggestions, including one bounded repair for invalid output.
- Preserve local edits, focus, text selection and scroll position across Reader and comparison
  views. No suggestion is accepted automatically.
- Carry speaker identity and delivery through dialogue prompts, retain usable language tags and
  restrict reference perception to the conditioned footage actually used by generation.

## Compatibility and distributions

- Accept POSIX host roots for verified generated-video closure instead of applying the Windows
  drive-path grammar to Linux hosts. Storage refusals now report the correct category and remedy.
- Build complete Python source distributions from reviewed public tracked sources, including
  developer tests, compressed fixtures, frontend inputs, tooling and governance data.
- Exclude ignored/private records, installed dependencies, caches and stale build metadata from
  public artifacts. Issued source distributions support hash-verified Git-less rebuilds.
- Independently audit actual source, wheel and Registry payloads for required files, exact source
  bytes and unsafe paths. Keep public release automation and its declared helpers available.
- Refresh the README and public guides for the current project, storage and compatibility behavior.

## Upgrade and limits

Replace the complete package, restart ComfyUI and refresh the browser. Save editable projects and
preserve media separately before updating; a ComfyUI workflow does not back up the editor timeline.

The prompt pipeline supports Windows, Linux and WSL. The editor's native media tools, Production
import, assembly and final rendering still require Windows x64 and the qualified FFmpeg build.
Durable metadata, retained videos and draft recovery require a trusted single-user loopback Windows
host with fixed local NTFS storage, no permissive CORS and no public-origin override. POSIX root
admission does not qualify Linux rendering or durable recovery.

Project files do not embed media. Recovery covers only the acknowledged revision and is not a
zero-loss, power-loss or cloud-backup guarantee. Provider/model installation, live generation and
provider costs remain under the user's control.
