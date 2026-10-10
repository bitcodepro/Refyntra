import { describe, it } from 'vitest';
import { conformanceCases } from '../src/conformance';

for (const kind of ['memory', 'loopback'] as const) {
  describe(`fixture adapter conformance (${kind} transport)`, () => {
    for (const c of conformanceCases) it(c.name, () => c.run(kind));
  });
}
