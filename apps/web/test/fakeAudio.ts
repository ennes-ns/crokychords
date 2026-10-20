/**
 * A tiny fake of the Web Audio API subset in `SynthContext`: it records every node, every
 * connection and every parameter automation call, so graph construction can be tested in jsdom.
 */
import type {
  BufferLike,
  BufferSourceLike,
  CompressorLike,
  FilterLike,
  GainLike,
  NodeLike,
  OscillatorLike,
  ParamLike,
  SynthContext,
} from '../src/audio/graph';

export interface ParamCall {
  method: string;
  value: number;
  time: number;
  constant?: number;
}

export class FakeParam implements ParamLike {
  value = 0;
  calls: ParamCall[] = [];
  setValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'set', value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'linear', value, time });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.calls.push({ method: 'exp', value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number, constant: number): this {
    this.calls.push({ method: 'target', value, time, constant });
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.calls.push({ method: 'cancel', value: 0, time });
    return this;
  }
  /** The highest value any call sets or ramps to. */
  get max(): number {
    return Math.max(this.value, ...this.calls.map((c) => c.value));
  }
}

export class FakeNode implements NodeLike {
  readonly outputs: NodeLike[] = [];
  constructor(readonly kind: string) {}
  connect(destination: NodeLike): NodeLike {
    this.outputs.push(destination);
    return destination;
  }
}

export class FakeGain extends FakeNode implements GainLike {
  readonly gain = new FakeParam();
  constructor() {
    super('gain');
  }
}

export class FakeFilter extends FakeNode implements FilterLike {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  constructor() {
    super('filter');
  }
}

class FakeSource extends FakeNode {
  starts: number[] = [];
  stops: number[] = [];
  start(when = 0): void {
    this.starts.push(when);
  }
  stop(when = 0): void {
    this.stops.push(when);
  }
}

export class FakeOscillator extends FakeSource implements OscillatorLike {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
  constructor() {
    super('oscillator');
  }
}

export class FakeBufferSource extends FakeSource implements BufferSourceLike {
  buffer: BufferLike | null = null;
  constructor() {
    super('buffer-source');
  }
}

export class FakeCompressor extends FakeNode implements CompressorLike {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
  constructor() {
    super('compressor');
  }
}

export class FakeContext implements SynthContext {
  currentTime = 0;
  readonly sampleRate = 100;
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  buffers = 0;

  #add<T extends FakeNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }
  createGain(): FakeGain {
    return this.#add(new FakeGain());
  }
  createOscillator(): FakeOscillator {
    return this.#add(new FakeOscillator());
  }
  createBiquadFilter(): FakeFilter {
    return this.#add(new FakeFilter());
  }
  createDynamicsCompressor(): FakeCompressor {
    return this.#add(new FakeCompressor());
  }
  createBuffer(_channels: number, length: number): BufferLike {
    this.buffers++;
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createBufferSource(): FakeBufferSource {
    return this.#add(new FakeBufferSource());
  }

  of<T extends FakeNode>(type: new () => T): T[] {
    return this.nodes.filter((n): n is T => n instanceof type);
  }

  /** Kinds of the nodes from `node` to the destination, following first outputs. */
  route(node: NodeLike): string[] {
    const kinds: string[] = [];
    let current: NodeLike | undefined = node;
    for (let i = 0; current !== undefined && i < 20; i++) {
      if (!(current instanceof FakeNode)) break;
      kinds.push(current.kind);
      current = current.outputs[0];
    }
    return kinds;
  }
}
