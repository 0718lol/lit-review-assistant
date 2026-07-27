export function createSerialExecutor() {
  let tail = Promise.resolve();
  return Object.freeze({
    run(operation) {
      if (typeof operation !== "function") return Promise.reject(new TypeError("operation must be a function."));
      const pending = tail.then(operation, operation);
      tail = pending.catch(() => {});
      return pending;
    }
  });
}
