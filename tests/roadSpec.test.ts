import { describe, expect, it } from 'vitest';
import { roadSection } from '../src/world/roadSpec.ts';
import { utmScale } from '../src/world/scaleCommands.ts';

describe('road cross-sections (1:1 against German guidelines)', () => {
  it('motorway carriageway: 2 × 3.75 m lanes plus hard shoulder', () => {
    const s = roadSection({ highway: 'motorway', oneway: 'yes', lanes: '2' })!;
    expect(s.width).toBeCloseTo(11.25);
    expect(s.dividers).toHaveLength(1);
    // Traffic keeps right: the right lane lies between the divider and the shoulder.
    expect(s.rightLane).toBeGreaterThan(s.dividers[0]);
    expect(s.rightLane + s.lane / 2).toBeLessThan(s.width / 2 + s.shift - 2.5);
    // OSM puts the line in the middle of the lanes: the divider is on it, the hard shoulder lies further right.
    expect(s.dividers[0]).toBeCloseTo(0);
    expect(s.shift).toBeCloseTo((s.outer - s.inner) / 2);
  });
  it('motorway ramp is about 6 m, three-lane motorway about 15 m', () => {
    expect(roadSection({ highway: 'motorway_link', oneway: 'yes', lanes: '1' })!.width).toBeCloseTo(6);
    expect(roadSection({ highway: 'motorway', lanes: '3' })!.width).toBeCloseTo(15);
  });
  it('town streets', () => {
    expect(roadSection({ highway: 'primary', lanes: '2' })!.width).toBeCloseTo(8);
    expect(roadSection({ highway: 'residential' })!.width).toBeCloseTo(6);
    // One-way side street keeps room for parking.
    expect(roadSection({ highway: 'residential', oneway: 'yes' })!.width).toBeGreaterThanOrEqual(4.5);
  });
  it('a tagged width wins and lanes scale into it', () => {
    const s = roadSection({ highway: 'secondary', width: '9', lanes: '2' })!;
    expect(s.width).toBe(9);
    expect(s.source).toBe('width');
    expect(s.rightLane).toBeCloseTo(s.lane / 2);
  });
  it('four-lane two-way road has dividers but no centre divider', () => {
    const s = roadSection({ highway: 'primary', lanes: '4' })!;
    expect(s.dividers.map((d) => Math.round(d * 100) / 100)).toEqual([-3.5, 3.5]);
    expect(s.rightLane).toBeCloseTo(5.25);
  });
  it('UTM distortion in Saarlouis is below 0.01 %', () => {
    // Großer Markt lies at about E 337 400 in zone 32.
    expect(Math.abs(utmScale(337_400) - 1)).toBeLessThan(1e-4);
  });
});
