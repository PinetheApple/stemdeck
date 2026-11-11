// A split that ran on its own, after an import or when its song opened, and
// failed: said in the notification centre, since nobody was watching its card.

import { t } from "./i18n.js";
import { notifyFailure } from "./notifications.js";
import { failureKey } from "./vocalSplit.js";

export const SPLIT_FAILURE_KIND = "vocalSplit";

/** For followSplit's onFailure. */
export function reportSplitFailure(jobId, view) {
  return notifyFailure({
    kind: SPLIT_FAILURE_KIND,
    message: t(failureKey(view?.error)),
    cause: view?.error ?? null,
    context: { jobId },
  });
}
