/**
 * B7 — server helper over the Trigger.dev API for HTTP routes.
 *
 * Single responsibility: deploy an `investigate` task run and issue a public
 * access token for Realtime subscription. Token is scoped to read ONLY this
 * run (canonical trigger-realtime skill: auth.createPublicToken → scopes.read.runs)
 * and lives 1 hour — comfortably covers max run duration (300 s).
 *
 * Only the task TYPE is imported from src/trigger/ (type-only import) — task
 * code does not land in the route bundle.
 */
import { auth, tasks } from "@trigger.dev/sdk";
import type { investigateTask } from "@/trigger/investigate";
import type { AskRequest, AskResponse } from "@/lib/contracts";

/** Trigger.dev API communication error — route turns it into 502. */
export class TriggerApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TriggerApiError";
  }
}

/**
 * Deploys an investigate run and issues a read-only token for that run.
 * Response strictly matches askResponseSchema ({ runId, publicAccessToken }).
 */
export async function triggerInvestigate(payload: AskRequest): Promise<AskResponse> {
  let runId: string;
  try {
    const handle = await tasks.trigger<typeof investigateTask>("investigate", payload);
    runId = handle.id;
  } catch (err) {
    throw new TriggerApiError(
      `Failed to deploy investigate run: ${errorMessage(err)}`,
      { cause: err },
    );
  }

  let publicAccessToken: string;
  try {
    publicAccessToken = await auth.createPublicToken({
      scopes: { read: { runs: [runId] } },
      expirationTime: "1h",
    });
  } catch (err) {
    throw new TriggerApiError(
      `Run ${runId} created, but failed to issue public access token: ${errorMessage(err)}`,
      { cause: err },
    );
  }

  return { runId, publicAccessToken };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
