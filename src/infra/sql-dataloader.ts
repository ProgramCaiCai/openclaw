export type SqlDataLoader<K, V> = {
  load: (key: K) => Promise<V>;
  clear: (key: K) => void;
  clearAll: () => void;
};

export type SqlDataLoaderOptions = {
  cache?: boolean;
};

export function createSqlDataLoader<K, V>(
  batchLoad: (keys: readonly K[]) => Promise<Map<K, V>>,
  options: SqlDataLoaderOptions = {},
): SqlDataLoader<K, V> {
  const cacheEnabled = options.cache !== false;
  const cache = new Map<K, Promise<V>>();
  const pending = new Map<
    K,
    Array<{ resolve: (value: V) => void; reject: (err: unknown) => void }>
  >();
  const queuedKeys = new Set<K>();
  let flushScheduled = false;

  const flush = () => {
    flushScheduled = false;
    if (queuedKeys.size === 0) {
      return;
    }
    const keys = Array.from(queuedKeys);
    queuedKeys.clear();

    void batchLoad(keys)
      .then((result) => {
        for (const key of keys) {
          const listeners = pending.get(key) ?? [];
          pending.delete(key);
          if (!result.has(key)) {
            const err = new Error("sql dataloader batch missing requested key");
            for (const listener of listeners) {
              listener.reject(err);
            }
            continue;
          }
          const value = result.get(key) as V;
          for (const listener of listeners) {
            listener.resolve(value);
          }
        }
      })
      .catch((err) => {
        for (const key of keys) {
          const listeners = pending.get(key) ?? [];
          pending.delete(key);
          for (const listener of listeners) {
            listener.reject(err);
          }
        }
      });
  };

  const scheduleFlush = () => {
    if (flushScheduled) {
      return;
    }
    flushScheduled = true;
    queueMicrotask(flush);
  };

  const load = (key: K): Promise<V> => {
    if (cacheEnabled) {
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }
    }

    const promise = new Promise<V>((resolve, reject) => {
      const listeners = pending.get(key) ?? [];
      listeners.push({ resolve, reject });
      pending.set(key, listeners);
      queuedKeys.add(key);
      scheduleFlush();
    });

    if (cacheEnabled) {
      cache.set(key, promise);
    }
    return promise;
  };

  return {
    load,
    clear: (key: K) => {
      cache.delete(key);
    },
    clearAll: () => {
      cache.clear();
    },
  };
}
