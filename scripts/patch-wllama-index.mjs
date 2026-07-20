const terminalBreak = `        if (!result_chunk.has_more) {
          break;
        }
      }
      return finalResult;`;

const drainPatch = `        // WebAI patch: the native glue can report no active task while its result
        // queue still contains the terminal chunk. Continue until get_result returns
        // both an empty payload and has_more=false so one request cannot bleed into the next.
      }
      return finalResult;`;

const workerExit = `      if (this.worker) {
        this.worker.terminate();
      }`;

const workerExitPatch = `      if (this.worker) {
        this.worker.terminate();
        // WebAI patch: terminating a busy worker cannot produce callback messages,
        // so reject its queued promises instead of leaving generation hung forever.
        this.abort("Worker terminated.", "");
        this.worker = void 0;
      }`;

export function patchWllamaIndex(source) {
  const first = source.indexOf(terminalBreak);
  if (first < 0 || source.indexOf(terminalBreak, first + terminalBreak.length) >= 0) {
    throw new Error("The pinned wllama response-loop patch no longer has one exact target.");
  }
  const exit = source.indexOf(workerExit);
  if (exit < 0 || source.indexOf(workerExit, exit + workerExit.length) >= 0) {
    throw new Error("The pinned wllama worker-exit patch no longer has one exact target.");
  }
  return source.replace(terminalBreak, drainPatch).replace(workerExit, workerExitPatch);
}
