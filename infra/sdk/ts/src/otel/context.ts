type ActiveSpan = {
  readonly context: { traceId: string; spanId: string };
  setAttribute(key: string, value: string | number | boolean): void;
};

type ActiveSpanStore = {
  getStore(): ActiveSpan | undefined;
  run<R>(store: ActiveSpan, fn: () => R): R;
};

let activeSpanStore: ActiveSpanStore = {
  getStore: () => undefined,
  run: (_store, fn) => fn(),
};

export const setActiveSpanStore = (store: ActiveSpanStore): void => {
  activeSpanStore = store;
};

export const formatTraceparent = (context: { traceId: string; spanId: string }): string =>
  `00-${context.traceId}-${context.spanId}-01`;

export const traceHeaders = (): Record<string, string> => {
  const span = activeSpanStore.getStore();
  return span ? { traceparent: formatTraceparent(span.context) } : {};
};

export const currentSpanContext = (): { traceId: string; spanId: string } | null =>
  activeSpanStore.getStore()?.context ?? null;

export const annotateSpan = (attributes: Record<string, string | number | boolean>): void => {
  const span = activeSpanStore.getStore();
  if (!span) {
    return;
  }
  for (const [key, value] of Object.entries(attributes)) {
    span.setAttribute(key, value);
  }
};

export const runWithActiveSpan = <R>(span: ActiveSpan, fn: () => R): R =>
  activeSpanStore.run(span, fn);

export type { ActiveSpan };
