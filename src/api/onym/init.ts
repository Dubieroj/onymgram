import type { MethodArgs, MethodResponse, Methods } from '../gramjs/methods/types';
import type { ApiInitialArgs, ApiOnProgress, OnApiUpdate } from '../types';

import { DEBUG } from '../../config';
import { init as initUpdateEmitter } from '../gramjs/updates/apiUpdateEmitter';
import { start } from './methods/client';
import * as methods from './methods/index';

// Methods the Onym network has no counterpart for (stickers, stories, payments, calls...) answer `undefined`,
// which the UI already treats as "not available": every global action checks `callApi` results for `undefined`
const IMPLEMENTED: Partial<Record<keyof Methods, AnyFunction>> = methods satisfies Partial<Methods>;
const reportedMissing = new Set<string>();

export function initApi(onUpdate: OnApiUpdate, initialArgs: ApiInitialArgs) {
  initUpdateEmitter(onUpdate);
  return start(initialArgs);
}

export function callApi<T extends keyof Methods>(fnName: T, ...args: MethodArgs<T>): MethodResponse<T> {
  const method = IMPLEMENTED[fnName];
  if (!method) {
    if (DEBUG && !reportedMissing.has(fnName)) {
      reportedMissing.add(fnName);
      // eslint-disable-next-line no-console
      console.debug('[onym] not in the Onym network:', fnName);
    }
    return Promise.resolve(undefined) as MethodResponse<T>;
  }

  return method(...args) as MethodResponse<T>;
}

export function cancelApiProgress(progressCallback: ApiOnProgress) {
  progressCallback.isCanceled = true;
}
