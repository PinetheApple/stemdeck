// Whether Browse library's Import queue is there: while imports run, and after the
// queue drains while a queued batch still has failed or not-queued items to deal with.

import { getQueueSnapshot, queueCount } from "./queue.js";
import { queueBatchProgress } from "./catalog.js";

export function importQueueShown(snap = getQueueSnapshot()) {
  return queueCount(snap) > 0 || queueBatchProgress(snap) !== null;
}
