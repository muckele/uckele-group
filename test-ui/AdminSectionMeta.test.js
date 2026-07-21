import { describe, expect, test } from 'vitest';
import { adminSectionMeta } from '../src/content/adminSectionMeta.js';

describe('admin workspace page metadata', () => {
  test('gives every admin route a distinct, task-oriented page identity', () => {
    const expectedSections = [
      'overview',
      'crm',
      'crm-detail',
      'command-center',
      'deal-hunter',
      'follow-ups',
      'operations',
      'new-record',
    ];

    expect(Object.keys(adminSectionMeta).sort()).toEqual(expectedSections.sort());
    expect(new Set(Object.values(adminSectionMeta).map((section) => section.title)).size).toBe(expectedSections.length);

    Object.values(adminSectionMeta).forEach((section) => {
      expect(section.eyebrow.length).toBeGreaterThan(3);
      expect(section.description.length).toBeGreaterThan(30);
      expect(section.guidance.length).toBeGreaterThan(30);
    });
  });
});
