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

export function patchWllamaIndex(source) {
  const first = source.indexOf(terminalBreak);
  if (first < 0 || source.indexOf(terminalBreak, first + terminalBreak.length) >= 0) {
    throw new Error("The pinned wllama response-loop patch no longer has one exact target.");
  }
  return source.replace(terminalBreak, drainPatch);
}
