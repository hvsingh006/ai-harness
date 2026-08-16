(() => {
  const STATES = Object.freeze({ IDLE: 'IDLE', PREPARING: 'PREPARING', PREPARED: 'PREPARED', ATTACHING: 'ATTACHING', REPLAYING: 'REPLAYING', WAITING_FOR_PROVIDER_ACCEPT: 'WAITING_FOR_PROVIDER_ACCEPT', DONE: 'DONE', ERROR: 'ERROR' });
  const ALLOWED = Object.freeze({
    IDLE: new Set(['PREPARING']),
    PREPARING: new Set(['PREPARED', 'ERROR']),
    PREPARED: new Set(['ATTACHING', 'ERROR']),
    ATTACHING: new Set(['REPLAYING', 'ERROR']),
    REPLAYING: new Set(['WAITING_FOR_PROVIDER_ACCEPT', 'ERROR']),
    WAITING_FOR_PROVIDER_ACCEPT: new Set(['DONE', 'ERROR']),
    DONE: new Set(['IDLE']),
    ERROR: new Set(['IDLE'])
  });

  function shouldManageEnter(event, insideComposer) {
    return Boolean(insideComposer && event?.key === 'Enter' && !event.repeat && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing);
  }

  function createAttempt(identity) {
    let state = STATES.IDLE;
    let invalidated = false;
    let replayArmed = false;
    return {
      identity: Object.freeze({ ...identity }),
      get state() { return state; },
      get invalidated() { return invalidated; },
      transition(next) {
        if (!ALLOWED[state]?.has(next)) throw new Error(`invalid send transition ${state} -> ${next}`);
        state = next;
        if (next !== STATES.REPLAYING) replayArmed = false;
        return state;
      },
      invalidate() { invalidated = true; },
      armReplay() {
        if (state !== STATES.REPLAYING || replayArmed) return false;
        replayArmed = true;
        return true;
      },
      consumeReplay() {
        if (state !== STATES.REPLAYING || !replayArmed) return false;
        replayArmed = false;
        return true;
      }
    };
  }

  globalThis.AIH_SEND_TRANSACTION = Object.freeze({ STATES, shouldManageEnter, createAttempt });
})();
