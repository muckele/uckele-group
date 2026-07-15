// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DashboardPage from '../src/pages/DashboardPage.jsx';

function renderDashboard() {
  vi.stubGlobal('React', React);
  return render(
    <HelmetProvider>
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route element={<DashboardPage />} path="/admin" />
        </Routes>
      </MemoryRouter>
    </HelmetProvider>,
  );
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

describe('Dashboard authentication bootstrap', () => {
  test('removes an invalid magic-link token and presents sign-in instead of staying on the loading screen', async () => {
    window.history.replaceState({}, '', '/admin?admin_token=expired-secret');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(
        { success: false, error: 'That sign-in link is invalid or has expired.' },
        { ok: false, status: 401 },
      ))
      .mockResolvedValueOnce(jsonResponse({
        authenticated: false,
        authMode: 'hybrid',
        magicLinkEnabled: true,
        passwordEnabled: true,
        adminEmailHint: 'ma***@example.com',
        viewerAccessEnabled: false,
      }));
    vi.stubGlobal('fetch', fetchMock);

    renderDashboard();

    expect(await screen.findByText('That sign-in link is invalid or has expired.')).toBeTruthy();
    expect(screen.getByText('Authorized CRM access')).toBeTruthy();
    expect(window.location.search).not.toContain('admin_token');
    expect(screen.queryByText('Loading admin CRM')).toBeNull();
  });

  test('shows a retryable error when the session endpoint is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network unavailable')));

    renderDashboard();

    expect(await screen.findByText('Network unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry session check' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Loading admin CRM')).toBeNull());
  });
});
