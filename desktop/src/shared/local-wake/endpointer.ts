// Decides when a recorded enrolment / self-test word is over, from the level meter alone (pure, no audio kept here).
export type EndpointState = 'waiting' | 'speaking' | 'done' | 'timeout';

export const ENDPOINT_START_RMS = 0.012;
export const ENDPOINT_QUIET_RMS = 0.006;
/** Silence after the word that ends the take. Longer than any gap inside "Sudo" (the d closure), shorter than a person's patience. */
export const ENDPOINT_QUIET_MS = 450;
export const ENDPOINT_WAIT_MS = 4000;
export const ENDPOINT_MAX_SPEECH_MS = 3000;

export class WordEndpointer {
  private state: EndpointState = 'waiting';
  private waited = 0;
  private spoken = 0;
  private quiet = 0;

  /** Feed one audio buffer's RMS and duration; returns the state after it. 'done' and 'timeout' are final. */
  feed(rms: number, ms: number): EndpointState {
    if (this.state === 'done' || this.state === 'timeout') return this.state;
    if (this.state === 'waiting') {
      if (rms > ENDPOINT_START_RMS) { this.state = 'speaking'; this.spoken = ms; this.quiet = 0; }
      else if ((this.waited += ms) >= ENDPOINT_WAIT_MS) this.state = 'timeout';
      return this.state;
    }
    this.spoken += ms;
    this.quiet = rms < ENDPOINT_QUIET_RMS ? this.quiet + ms : 0;
    if (this.quiet >= ENDPOINT_QUIET_MS || this.spoken >= ENDPOINT_MAX_SPEECH_MS) this.state = 'done';
    return this.state;
  }
}
