import * as EventEmitter from 'eventemitter3';
import {autobind} from 'core-decorators';
import {strEnum} from './utils/strEnum';
import {StringKeys} from './utils/stringKeys';
import {forEach, uniq, compact, size, over} from 'lodash';

export type EventSubscription = () => void;
export type Event = string;
export type Listenable<E extends Event> = E|E[]|'*';
type SingleEventHandler<TEventMap extends object> =
  <T extends StringKeys<TEventMap>>(payload: TEventMap[T]) => void;
type AmbiguousEventHandler = () => void;
export type ProxyHandler<TEventMap extends object> =
  <T extends StringKeys<TEventMap>>(event: T, payload: TEventMap[T]) => void;

export type OnHandler<TEventMap extends object, TEvent> =
  TEvent extends StringKeys<TEventMap>[]
    ? ProxyHandler<TEventMap>
    : TEvent extends StringKeys<TEventMap>
      ? SingleEventHandler<TEventMap>
      : AmbiguousEventHandler;

export const Lifecycle = strEnum([
  'willActivate',
  'active',
  'willIdle',
  'idle',
  'willAddListener',
  'didAddListener',
  'willRemoveListener',
  'didRemoveListener'
]);
export type Lifecycle = keyof typeof Lifecycle;

/**
 * @prop allowUnhandledEvents [true] - should the Bus throw an error when an event is emitted and there are no listeners
 * @prop maxListeners [50] - number of max listeners expected for events. Will raise a benign info message when exceeded.
 *  Bus will still accept listeners after the this threshold is exceeded.
 * @prop name [Anonymous] - a name for the bus. included in warn/info messages and errors thrown
 * @prop potentialMemoryLeakWarningThreshold [500] - when to raise a more serious warning about high listener counts.
 */
export interface Options {
  allowUnhandledEvents?: boolean;
  maxListeners?: number;
  name?: string;
  potentialMemoryLeakWarningThreshold?: number;
}

@autobind
export class Bus<TEventMap extends object = object> {

  private static defaultOptions: Required<Options> = {
    allowUnhandledEvents: true,
    maxListeners: 50,
    name: 'Anonymous',
    potentialMemoryLeakWarningThreshold: 500
  };

  protected static reservedEvents = {
    EVERY: '*',
    PROXY: '@@PROXY@@'
  };

  public static set defaultAllowUnhandledEvents(allow: boolean) {
    this.defaultOptions.allowUnhandledEvents = allow;
  }

  public static set defaultMaxListeners(max: number) {
    this.defaultOptions.maxListeners = max;
  }

  public static set defaultMemoryLeakWarningThreshold(threshold: number) {
    this.defaultOptions.potentialMemoryLeakWarningThreshold = threshold;
  }

  private _active = false;
  private _delegates = new Map<Bus<TEventMap>, EventSubscription[]>();

  private lifecycle: EventEmitter<Lifecycle> = new EventEmitter<Lifecycle>();
  private bus: EventEmitter = new EventEmitter();
  private readonly options: Required<Options>;

  constructor(options?: Options) {
    this.options = {
      ...Bus.defaultOptions,
      ...options
    };
    this.decorateOnMethod();
    this.decorateEmitMethod();
    this.decorateRemoveListenerMethod();
  }

  /**
   * @override
   * @param event
   * @param message
   */
  protected handleUnexpectedEvent<T extends StringKeys<TEventMap>>(event: T, payload: TEventMap[T]) {
    const errorMessage = [
      `TypedMsgBus received unexpected message type '${event}' with contents:`,
      JSON.stringify(payload, null, 2)
    ].join('\n');

    throw new Error(errorMessage);
  }

  /**
   * @description subscribe a callback to event(s)
   *  alias of <Bus>.every when invoked with `*`
   *  alias of <Bus>.any when invoked with an array of events
   */
  public on<T extends Listenable<StringKeys<TEventMap>>>(
    event: T,
    handler: OnHandler<TEventMap, T>
  ): EventSubscription {
    if(Array.isArray(event)) {
      return this.any(event, handler as ProxyHandler<TEventMap>);
    } else if(event === Bus.reservedEvents.EVERY) {
      const wrappedHandler = () => (handler as any)();
      this.bus.on(event as '*', wrappedHandler);
      return () => this.bus.removeListener(event as '*', wrappedHandler);
    } else {
      this.bus.on(event as StringKeys<TEventMap>, handler);
      return () => this.bus.removeListener(event as string, handler);
    }
  }

  public emit<T extends StringKeys<TEventMap>>(
    event: T,
    payload: TEventMap[T]
  ): boolean {
    return this.bus.emit(event, payload);
  }

  /**
   * @description Handle multiple events with the same handler.
   * Handler receives raised event as first argument, payload as second argument
   */
  public any<T extends StringKeys<TEventMap>>(events: T[], handler: ProxyHandler<TEventMap>): EventSubscription {
    return over(
      events.map((e: T) => {
        const anyHandler = (payload: TEventMap[T]) => handler(e, payload);
        this.bus.on(e, anyHandler);
        return () => this.bus.removeListener(e, anyHandler);
      })
    );
  }

  /**
   * @description Handle ALL events raised with a single handler.
   * Handler is invoked with no payload, and is unaware of the event that was emitted
   */
  public every(handler: AmbiguousEventHandler): EventSubscription {
    const {EVERY} = Bus.reservedEvents;
    const wrappedHandler = () => handler();
    this.bus.on(EVERY, wrappedHandler);
    return () => this.bus.removeListener(EVERY, wrappedHandler);
  }

  /**
   * @alias every
   */
  public all(handler: AmbiguousEventHandler): EventSubscription {
    return this.every(handler);
  }

  /**
   * Create a proxy for all events raised. Like `any`, handlers receive the raised event as first
   * argument and payload as second argument. Think of this as a combination of `any` and `every`
   */
  public proxy(handler: ProxyHandler<TEventMap>): EventSubscription {
    const {PROXY} = Bus.reservedEvents;
    this.bus.on(PROXY, handler);
    return () => this.bus.removeListener(PROXY, handler);
  }

  public pipe<TDelegate extends Bus<TEventMap>>(delegate: TDelegate): TDelegate {
    if(delegate !== this as any) {
      if(!this._delegates.has(delegate)) {
        this._delegates.set(delegate, [
          delegate.hook(Lifecycle.willAddListener, this.willAddListener),
          delegate.hook(Lifecycle.didAddListener, this.didAddListener),
          delegate.hook(Lifecycle.willRemoveListener, this.willRemoveListener),
          delegate.hook(Lifecycle.didRemoveListener, this.didRemoveListener)
        ]);
      }
    }
    return delegate;
  }

  public unpipe<TDelegate extends Bus<TEventMap>>(delegate: TDelegate): void {
    over(this._delegates.get(delegate))();
    this._delegates.delete(delegate);
  }

  public hook(event: Lifecycle, handler: EventEmitter.ListenerFn): EventSubscription {
    this.lifecycle.on(event, handler);
    return () => this.lifecycle.removeListener(event, handler);
  }

  public monitor(handler: (activeState: boolean) => void): EventSubscription {
    return over([
      this.hook(Lifecycle.active, () => handler(true)),
      this.hook(Lifecycle.idle, () => handler(false))
    ]);
  }

  public get active(): boolean {
    return this._active;
  }

  public get name(): string {
    return `${this.options.name} ${this.constructor.name}`;
  }

  public get hasListeners(): boolean {
    return this.hasOwnListeners || this.hasDelegateListeners;
  }

  public get hasOwnListeners(): boolean {
    return Boolean(this.bus.eventNames().reduce((acc, event) => {
      return (this.bus.listeners(event) || acc) as boolean;
    }, false));
  }

  public get hasDelegateListeners(): boolean {
    return Array.from(this._delegates.keys())
      .reduce((acc, d) => (d.hasListeners || acc), false);
  }

  public get listeners(): {[event: string]: EventEmitter.ListenerFn[]} {
    const ownListeners = this.ownListeners;
    const delegates = Array.from(this._delegates.keys());
    const delegateListenersByEvent: {[event: string]: EventEmitter.ListenerFn[]} = delegates.reduce((acc, delegate) => {
      forEach(delegate.listeners, (listeners: EventEmitter.ListenerFn[], event: Event) => {
        event = event.toString();
        if(acc[event]) {
          acc[event] = [
            ...acc[event],
            ...listeners
          ];
        } else {
          acc[event] = listeners;
        }
      });
      return acc;
    }, {} as {[event: string]: EventEmitter.ListenerFn[]});

    const allEvents = uniq([...Object.keys(ownListeners), ...Object.keys(delegateListenersByEvent)]);
    return allEvents.reduce((acc: {[event: string]: EventEmitter.ListenerFn[]}, event: string) => {
      const eventListeners = compact([
        ...(ownListeners[event] || []),
        ...(delegateListenersByEvent[event] || [])
      ]);
      if(eventListeners && eventListeners.length) {
        acc[event] = eventListeners;
      }
      return acc;
    }, {});
  }

  private get ownListeners(): {[event: string]: EventEmitter.ListenerFn[]} {
    return this.bus.eventNames().reduce((acc, event) => {
      return {
        ...acc,
        [event]: this.bus.listeners(event)
      };
    }, {});
  }

  public destroy() {
    this.bus.removeAllListeners();
    this.lifecycle.removeAllListeners();
    this._delegates.clear();
  }

  private decorateOnMethod() {
    const on: EventEmitter['on'] = (...args) => EventEmitter.prototype.on.call(this.bus, ...args);

    this.bus.on = (event: StringKeys<TEventMap>, handler: EventEmitter.ListenerFn, context?: any): EventEmitter => {
      const {maxListeners, potentialMemoryLeakWarningThreshold} = this.options;
      const n: number = this.bus.listeners(event).length;
      if(n > maxListeners) {
        console.info(`${this.name} has ${n} listeners for "${event}", ${maxListeners} max listeners expected.`);
      } else if(n > potentialMemoryLeakWarningThreshold) {
        console.warn(`Potential Memory Leak. ${this.name} has ${n} listeners for "${event}", exceeds threshold set to ${potentialMemoryLeakWarningThreshold}`);
      }
      this.willAddListener(event);
      const emitter = on(event, handler, context);
      this.didAddListener(event);
      return emitter;
    };
  }

  private decorateEmitMethod() {

    const raise: EventEmitter['emit'] = (...args): boolean => EventEmitter.prototype.emit.call(this.bus, ...args);

    this.bus.emit = <T extends StringKeys<TEventMap>>(event: T, payload: TEventMap[T], ...args: any[]): boolean => {
      let handled = false;
      const {EVERY, PROXY} = Bus.reservedEvents;

      if(event === EVERY || event === PROXY) {
        throw new Error(`Do not emit "${event}" manually. Reserved for internal use.`);
      }

      handled = raise(event, payload) || handled;
      handled = raise(EVERY, payload) || handled;
      handled = raise(PROXY, event, payload) || handled;
      handled = this.forward(event, payload) || handled;

      if(!handled && !this.options.allowUnhandledEvents) {
        this.handleUnexpectedEvent(event, payload);
      }
      return handled;
    };
  }

  private decorateRemoveListenerMethod() {
    const removeListener: EventEmitter['removeListener'] = (...args): EventEmitter => EventEmitter.prototype.removeListener.call(this.bus, ...args);

    this.bus.removeListener = (event: StringKeys<TEventMap>, handler: EventEmitter.ListenerFn, context?: any, once?: boolean): EventEmitter => {
      this.willRemoveListener(event);
      const emitter = removeListener(event, handler, context, once);
      this.didRemoveListener(event);
      return emitter;
    };
  }

  private forward<T extends StringKeys<TEventMap>>(event: T, payload: TEventMap[T], ...args: any[]): boolean {
    const {_delegates} = this;
    if(_delegates.size) {
      return Array.from(_delegates.keys())
        .reduce((acc, d) => (d.emit(event, payload) || acc), false);
    } else {
      return false;
    }
  }

  private willAddListener(event: StringKeys<TEventMap>) {
    this.lifecycle.emit(Lifecycle.willAddListener, event);
    if(!this.active) {
      this.lifecycle.emit(Lifecycle.willActivate);
    }
  }

  private didAddListener(event: StringKeys<TEventMap>) {
    this.lifecycle.emit(Lifecycle.didAddListener, event);
    if(!this.active && this.hasListeners) {
      this._active = true;
      this.lifecycle.emit(Lifecycle.active);
    }
  }

  private willRemoveListener(event: StringKeys<TEventMap>) {
    this.lifecycle.emit(Lifecycle.willRemoveListener, event);
    if(this.active && size(this.listeners) === 1) {
      this.lifecycle.emit(Lifecycle.willIdle);
    }
  }

  private didRemoveListener(event: StringKeys<TEventMap>) {
    this.lifecycle.emit(Lifecycle.didRemoveListener, event);
    if(this.active && !this.hasListeners) {
      this._active = false;
      this.lifecycle.emit(Lifecycle.idle);
    }
  }
}