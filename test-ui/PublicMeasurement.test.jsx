// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Breadcrumbs from '../src/components/Breadcrumbs';
import ContactForm from '../src/components/ContactForm';
import Footer from '../src/components/Footer';
import CriteriaPage from '../src/pages/CriteriaPage';
import HomePage from '../src/pages/HomePage';
import { trackAnalyticsEvent } from '../src/utils/analytics';

globalThis.React = React;

vi.mock('../src/utils/analytics', () => ({
  getSafeAttribution: vi.fn(() => ({
    referrerHost: 'broker.example',
    utmSource: 'newsletter',
    utmMedium: 'email',
    utmCampaign: 'owners',
  })),
  trackAnalyticsEvent: vi.fn(),
}));

function renderWithRouter(children, initialEntries = ['/']) {
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </HelmetProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('public conversion measurement', () => {
  test('the homepage criteria download reports its distinct placement', () => {
    renderWithRouter(<HomePage />);

    const link = screen.getByRole('link', { name: /Download Summary/ });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(trackAnalyticsEvent).toHaveBeenCalledWith('criteria_downloaded', {
      path: '/',
      placement: 'homepage',
    });
    expect(link).toHaveAttribute('download');
  });

  test('the criteria page download reports its distinct placement', () => {
    renderWithRouter(<CriteriaPage />, ['/criteria']);
    const link = screen.getByRole('link', { name: /Download Criteria/ });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(trackAnalyticsEvent).toHaveBeenCalledWith('criteria_downloaded', { path: '/criteria', placement: 'criteria_page' });
  });

  test('the footer declares its distinct criteria-download placement', () => {
    renderWithRouter(<Footer />);
    const link = screen.getByRole('link', { name: 'Download Criteria' });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(trackAnalyticsEvent).toHaveBeenCalledWith('criteria_downloaded', { path: '/', placement: 'footer' });
  });

  test('a successful form submission measures start and success before routing to thank-you', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, turnstileEnabled: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, message: 'Received.' }) });
    vi.stubGlobal('fetch', fetchMock);

    renderWithRouter(
      <Routes>
        <Route element={<ContactForm />} path="/contact" />
        <Route element={<p>Dedicated thank-you route</p>} path="/thank-you" />
      </Routes>,
      ['/contact'],
    );

    fireEvent.focus(screen.getByLabelText('Name'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Owner Name' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'I would like to discuss a transition.' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send Inquiry' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send Inquiry' }));

    expect(await screen.findByText('Dedicated thank-you route')).toBeInTheDocument();
    expect(trackAnalyticsEvent).toHaveBeenCalledWith('contact_form_started', { path: '/contact' });
    expect(trackAnalyticsEvent).toHaveBeenCalledWith('contact_submission_succeeded', { path: '/contact' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).attribution).toEqual({
      referrerHost: 'broker.example',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'owners',
    });
  });
});

test('interior pages expose matching visible breadcrumb context', () => {
  renderWithRouter(<Breadcrumbs />, ['/criteria']);
  const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(breadcrumb).toHaveTextContent('Home');
  expect(breadcrumb).toHaveTextContent('What I’m Looking For');
  expect(within(breadcrumb).getByText('What I’m Looking For')).toHaveAttribute('aria-current', 'page');
});
