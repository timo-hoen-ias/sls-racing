import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AddressBook, normalizeStreet, parseAddress, type AddressData } from '../src/nav/addresses.ts';

const data: AddressData = {
  v: 1, attribution: 'test',
  streets: ['Lothringer Straße', 'Großer Markt', 'Französische Straße'],
  a: [
    [0, '12', 336500, 5464600, '66740'], [0, '12a', 336505, 5464600, '66740'], [0, '3', 336400, 5464650, '66740'],
    [1, '1', 336590, 5464720, '66740'], [2, '7', 336620, 5464800, '66740'],
  ],
};

describe('addresses', () => {
  it('normalizes typed street names', () => {
    expect(normalizeStreet('Lothringer Str. ')).toBe('lothringer strasse');
    expect(normalizeStreet('Großer Markt')).toBe('grosser markt');
    expect(normalizeStreet('franzoesische strasse')).toBe(normalizeStreet('Französische Straße'));
  });

  it('splits street and house number', () => {
    expect(parseAddress('Lothringer Straße 12a')).toEqual({ street: 'Lothringer Straße', number: '12a' });
    expect(parseAddress('Großer Markt')).toEqual({ street: 'Großer Markt' });
    expect(parseAddress('Lothringer Str, 12 A')).toEqual({ street: 'Lothringer Str', number: '12a' });
  });

  it('finds the exact address first and falls back to the street', () => {
    const b = new AddressBook(data);
    expect(b.find('lothringer str 12a')[0].label).toBe('Lothringer Straße 12a');
    expect(b.find('Lothringer Straße 12')[0].label).toBe('Lothringer Straße 12');
    expect(b.find('lothringer').map((a) => a.number)).toEqual(['3', '12', '12a']);
    expect(b.find('Lothringer Straße 99')).toEqual([]);
    expect(b.find('franzosische')).toEqual([]);
    expect(b.find('französische 7')[0].street).toBe('Französische Straße');
  });

  it('ships the committed Saarlouis address file', () => {
    const real = JSON.parse(readFileSync('public/data/addresses.json', 'utf8')) as AddressData;
    const b = new AddressBook(real);
    expect(b.list.length).toBeGreaterThan(5000);
    expect(b.find('Großer Markt 1')[0]?.street).toBe('Großer Markt');
  });
});
