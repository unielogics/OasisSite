/* eslint-disable @typescript-eslint/no-explicit-any */

/** The slice of DCHost a logic instance talks to. */
export interface DCHostLike {
  __setLogicState(update: object | ((prev: any) => object), cb?: () => void): void
  forceUpdate(cb?: () => void): void
}

/**
 * Port of the dc runtime's StreamableLogic (exposed to the screen scripts as both `DCLogic` and
 * `StreamableLogic`). Semantics that the original scripts depend on:
 *  - setState applies the patch to `this.state` synchronously, so the next line already reads the new state;
 *    only the re-render is deferred (a React bump, `cb` fires after the commit);
 *  - until a host is attached (`__host`, installed after construction) setState is a complete no-op;
 *  - subclass class fields run after this constructor, so `state = (() => ...)()` replaces the `{}` below.
 *
 * TypeScript subclasses that redeclare `props`, `state` or `__host` must use `declare` (never a bare field),
 * otherwise define-semantics would reset the base-initialised value.
 */
export class DCLogic<S extends object = Record<string, any>, P extends object = Record<string, any>> {
  props: P
  state: S = {} as S
  __host: DCHostLike | undefined = undefined

  constructor(props?: P) {
    this.props = (props || {}) as P
  }

  setState(update: Partial<S> | ((prev: S) => Partial<S>), cb?: () => void): void {
    if (this.__host) this.__host.__setLogicState(update as object | ((prev: any) => object), cb)
  }

  forceUpdate(): void {
    if (this.__host) this.__host.forceUpdate()
  }

  componentDidMount(): void {}
  componentDidUpdate(_prevProps?: P): void {}
  componentWillUnmount(): void {}

  /** The flat object the compiled template renders against (merged over props). */
  renderVals(): Record<string, any> {
    return {}
  }
}

export { DCLogic as StreamableLogic }
