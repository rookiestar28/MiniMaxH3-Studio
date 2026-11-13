// Profile observation is lazy and successful observations are cached for one controller.
import type { GenerationProfile } from "../contracts/generationProfileCodec";
import { createGenerationProfileClient } from "./generationProfileClient";
import { probeFetchApi } from "./hostSeams";
import { admitGenerationProfile } from "./appModeAdmission";
import type {
  AppModeApi,
  AppModeAdmission,
  AppModeProfileLoader,
} from "./appModeContract";

export function createAppModeProfileAdmission(
  api: AppModeApi,
  options: { loadProfile?: AppModeProfileLoader },
) {
  // Bind fetchApi: its route resolver requires the host's this value.
  const fetchApiSeam = probeFetchApi(api);
  const profileClient = createGenerationProfileClient({
    fetchApi: fetchApiSeam.status === "ready" ? fetchApiSeam.value : undefined,
  });
  const loadProfile =
    options.loadProfile ??
    ((signal?: AbortSignal) => profileClient.load(signal));
  // Reuse successful host observations; do not cache a transient refusal.
  let pendingProfile: Promise<GenerationProfile> | undefined;
  const profile = (signal?: AbortSignal): Promise<GenerationProfile> => {
    if (pendingProfile === undefined)
      pendingProfile = Promise.resolve(loadProfile(signal)).catch(
        (error: unknown) => {
          pendingProfile = undefined;
          throw error;
        },
      );
    return pendingProfile;
  };
  const admission = async (
    taskMode: string,
    settings: { signal?: AbortSignal; refresh?: boolean } = {},
  ): Promise<AppModeAdmission> => {
    if (settings.refresh === true) pendingProfile = undefined;
    try {
      return admitGenerationProfile(await profile(settings.signal), taskMode);
    } catch {
      // CRITICAL: fail closed. A host that cannot say whether generation is
      // possible has not qualified it, and guessing here is how a shell queues a
      // graph the host cannot run.
      return {
        status: "refused",
        reason: "profile_unavailable",
        remediation: "upgrade_host",
        unsatisfiedSlots: [],
      };
    }
  };
  return admission;
}
