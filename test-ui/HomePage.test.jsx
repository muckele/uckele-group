// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import HomePage from '../src/pages/HomePage.jsx';
import { homePage } from '../src/content/siteContent.js';

globalThis.React = React;

vi.mock('../src/components/Seo.jsx', () => ({ default: () => null }));
vi.mock('../src/components/Reveal.jsx', () => ({ default: ({ as: Tag = 'div', children, delay: _delay, ...props }) => <Tag {...props}>{children}</Tag> }));

afterEach(() => {
  cleanup();
});

describe('HomePage', () => {
  test('renders the requested seller narrative in order', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    const sectionTitles = [
      homePage.hero.title,
      homePage.operatorExperience.title,
      homePage.criteriaAtAGlance.title,
      homePage.readiness.title,
      homePage.transitionApproach.title,
      homePage.professionalCredibility.title,
      homePage.essentialFaqs.title,
      homePage.contactCta.title,
    ];
    const positions = sectionTitles.map((title) => headings.indexOf(title));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(homePage.essentialFaqs.items).toHaveLength(5);
  });

  test('keeps the primary seller actions available', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole('link', { name: /Start a Conversation|Contact Mathew/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Download Summary/i })).toHaveAttribute('href', '/downloads/uckele-group-acquisition-criteria.pdf');
    expect(screen.getByRole('link', { name: /View Mathew’s LinkedIn/i })).toHaveAttribute('target', '_blank');
  });
});
