import type * as onymMethods from '../../onym/methods/onymOnly';
import type * as methods from './index';

export type Methods = typeof methods & typeof onymMethods;
export type MethodArgs<N extends keyof Methods> = Parameters<Methods[N]>;
export type MethodResponse<N extends keyof Methods> = ReturnType<Methods[N]>;
