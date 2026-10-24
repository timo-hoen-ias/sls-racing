import { describe, expect, it } from 'vitest';
import { BridgeJoints } from '../src/audio/bridgeJoints.ts';

const joint = { id: 1, x: 0, y: 10, z: 0, dx: 1, dz: 0, halfWidth: 5 };

describe('bridge joints', () => {
  it('clicks once per axle when the car drives over a joint on the deck', () => {
    const j = new BridgeJoints([joint]);
    const clicks: number[] = [];
    j.onClick = (k) => clicks.push(k);
    // 20 m/s along +x through the joint line at x = 0.
    for (let i = 0; i <= 40; i++) j.update(0.02, -4 + i * 0.4, 10, 1, 20);
    expect(clicks.length).toBe(2);
    expect(j.crossings).toBe(1);
  });

  it('stays silent beside the deck, below it and when standing', () => {
    const j = new BridgeJoints([joint]);
    let n = 0;
    j.onClick = () => n++;
    for (let i = 0; i <= 40; i++) j.update(0.02, -4 + i * 0.4, 10, 8, 20);
    for (let i = 0; i <= 40; i++) j.update(0.02, -4 + i * 0.4, 2, 0, 20);
    for (let i = 0; i <= 40; i++) j.update(0.02, -0.2 + i * 0.01, 10, 0, 0.5);
    expect(n).toBe(0);
  });
});
