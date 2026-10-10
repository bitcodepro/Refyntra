import { describe, it } from 'vitest';
import { delegatedConformanceCases } from '../src/delegatedConformance';

describe('delegated TS/JS route conformance (public provider commands, fake executor)', () => {
  for (const c of delegatedConformanceCases) it(c.name, () => c.run());
});
