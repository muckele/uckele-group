// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import SecureDocumentsPage from '../src/pages/SecureDocumentsPage.jsx';

vi.mock('../src/components/Seo.jsx', () => ({ default: () => null }));
vi.mock('../src/components/PageHero.jsx', () => ({ default: ({ title }) => <h1>{title}</h1> }));
vi.mock('../src/components/Reveal.jsx', () => ({ default: ({ children, ...props }) => <div {...props}>{children}</div> }));

const activeContext = {
  success: true,
  request: {
    id: 'request-1',
    status: 'awaiting-documents',
    expires_at: '2026-07-20T12:00:00.000Z',
    contact_name: 'Seller Example',
    email: 'seller@example.com',
  },
  submission: {
    id: 'submission-1',
    name: 'Seller Example',
    company: 'Example Services',
  },
  documents: [],
};

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('SecureDocumentsPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/secure-documents?token=signed-token');
    global.fetch = vi.fn(() => jsonResponse(activeContext));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test('keeps the upload form visible after correctable client validation errors', async () => {
    render(<SecureDocumentsPage />);
    const uploadButton = await screen.findByRole('button', { name: 'Upload Documents' });

    fireEvent.click(uploadButton);

    expect(await screen.findByRole('alert')).toHaveTextContent('choose at least one file');
    expect(screen.getByRole('button', { name: 'Upload Documents' })).toBeVisible();
    expect(screen.getByLabelText('Files')).toBeVisible();
  });

  test('keeps the form available after a recoverable server rejection', async () => {
    global.fetch = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse(activeContext))
      .mockImplementationOnce(() => jsonResponse(
        { success: false, error: 'The selected file type is not allowed.' },
        { ok: false, status: 400 },
      ));
    render(<SecureDocumentsPage />);

    const fileInput = await screen.findByLabelText('Files');
    fireEvent.change(fileInput, {
      target: { files: [new File(['invalid'], 'financials.exe', { type: 'application/octet-stream' })] },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm these documents/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload Documents' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('file type is not allowed'));
    expect(screen.getByLabelText('Files')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Upload Documents' })).toBeVisible();
  });

  test('replaces the form when a request is already complete', async () => {
    global.fetch = vi.fn(() => jsonResponse({
      ...activeContext,
      request: { ...activeContext.request, status: 'documents-received' },
    }));
    render(<SecureDocumentsPage />);

    expect(await screen.findByRole('heading', { name: 'Documents received' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Upload Documents' })).not.toBeInTheDocument();
  });
});
