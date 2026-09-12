const FULL_SYNCHRONOUS = 2;

function criticalError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function synchronousMode(readSynchronous) {
  const value = readSynchronous();
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3) {
    throw criticalError(
      "CRITICAL_TRANSACTION_SYNC_UNVERIFIED",
      "SQLite synchronous mode could not be verified",
    );
  }
  return value;
}

function isThenable(value) {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

function isNativeAsyncFunction(fn) {
  const tag = Object.prototype.toString.call(fn);
  return tag === "[object AsyncFunction]" || tag === "[object AsyncGeneratorFunction]";
}

/**
 * Track adapter transactions and add a synchronous, FULL-synced outer write.
 * SQLite does not allow changing `synchronous` inside a transaction, so the
 * critical boundary rejects nesting in either direction.
 */
export function createTransactionController({ exec, readSynchronous, isInTransaction }) {
  let transactionDepth = 0;
  let criticalActive = false;

  function transaction(run) {
    if (criticalActive) {
      throw criticalError(
        "CRITICAL_TRANSACTION_NESTED",
        "A critical SQLite transaction cannot contain another transaction",
      );
    }
    transactionDepth += 1;
    try {
      return run();
    } finally {
      transactionDepth -= 1;
    }
  }

  function criticalTransaction(fn) {
    if (typeof fn !== "function") throw new TypeError("criticalTransaction requires a function");
    if (isNativeAsyncFunction(fn)) {
      throw criticalError(
        "CRITICAL_TRANSACTION_ASYNC",
        "A critical SQLite transaction callback must be synchronous",
      );
    }
    if (criticalActive || transactionDepth > 0 || isInTransaction?.()) {
      throw criticalError(
        "CRITICAL_TRANSACTION_NESTED",
        "A critical SQLite transaction must be the outermost transaction",
      );
    }

    const previousMode = synchronousMode(readSynchronous);
    const requiredMode = Math.max(previousMode, FULL_SYNCHRONOUS);
    let modeChanged = false;
    let transactionOpen = false;
    let commitState = "not-started";
    let result;
    let failure = null;

    criticalActive = true;
    try {
      if (requiredMode !== previousMode) {
        exec(`PRAGMA synchronous=${requiredMode}`);
        modeChanged = true;
      }
      if (synchronousMode(readSynchronous) !== requiredMode) {
        throw criticalError(
          "CRITICAL_TRANSACTION_SYNC_UNVERIFIED",
          "SQLite refused the required synchronous mode",
        );
      }

      exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      commitState = "open";
      result = fn();
      if (isThenable(result)) {
        throw criticalError(
          "CRITICAL_TRANSACTION_ASYNC",
          "A critical SQLite transaction callback must be synchronous",
        );
      }
      exec("COMMIT");
      transactionOpen = false;
      commitState = "committed";
    } catch (error) {
      failure = error;
      if (transactionOpen || isInTransaction?.()) {
        try {
          exec("ROLLBACK");
          transactionOpen = false;
          commitState = "rolled-back";
        } catch (rollbackError) {
          failure = criticalError(
            "CRITICAL_TRANSACTION_ROLLBACK_FAILED",
            "Critical SQLite transaction rollback could not be confirmed",
            { cause: error, rollbackCause: rollbackError, commitState: "uncertain" },
          );
        }
      } else if (commitState === "open") {
        failure = criticalError(
          "CRITICAL_TRANSACTION_COMMIT_UNCERTAIN",
          "Critical SQLite transaction outcome could not be confirmed",
          { cause: error, commitState: "uncertain" },
        );
      }
    } finally {
      criticalActive = false;
      if (modeChanged) {
        try {
          exec(`PRAGMA synchronous=${previousMode}`);
          if (synchronousMode(readSynchronous) !== previousMode) {
            throw new Error("SQLite refused the previous synchronous mode");
          }
        } catch (restoreError) {
          if (!failure) {
            failure = criticalError(
              "CRITICAL_TRANSACTION_RESTORE_FAILED",
              "Critical SQLite transaction committed but synchronous mode restoration failed",
              { cause: restoreError, commitState },
            );
          }
        }
      }
    }

    if (failure) throw failure;
    return result;
  }

  return { transaction, criticalTransaction };
}
