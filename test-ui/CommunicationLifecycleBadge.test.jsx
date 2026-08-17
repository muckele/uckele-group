// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import CommunicationLifecycleBadge, { getCommunicationLifecyclePresentation } from '../src/components/admin/CommunicationLifecycleBadge.jsx';

afterEach(cleanup);

describe('CommunicationLifecycleBadge', () => {
  test('presents request acceptance and delivery progress as independent states', () => {
    render(<CommunicationLifecycleBadge deliveryState="awaiting_delivery" requestState="provider_accepted" />);

    const lifecycle = screen.getByLabelText('Communication lifecycle');
    expect(lifecycle).toHaveTextContent('Provider accepted');
    expect(lifecycle).toHaveTextContent('Awaiting delivery');
    expect(lifecycle.querySelector('[data-lifecycle-kind="request"]')).toHaveAttribute('data-lifecycle-state', 'provider-accepted');
    expect(lifecycle.querySelector('[data-lifecycle-kind="delivery"]')).toHaveAttribute('data-lifecycle-state', 'awaiting-delivery');
  });

  test.each([
    ['accepted', 'Awaiting delivery'],
    ['delivered', 'Delivered'],
    ['delayed', 'Delayed'],
    ['bounced', 'Bounced'],
    ['failed', 'Failed'],
    ['complained', 'Complained'],
    ['suppressed', 'Suppressed'],
    ['replied', 'Replied'],
    ['development-only', 'Development only'],
  ])('labels the %s delivery state precisely', (state, expectedLabel) => {
    expect(getCommunicationLifecyclePresentation({ deliveryState: state })).toEqual([
      expect.objectContaining({ id: 'delivery', label: expectedLabel, state }),
    ]);
  });

  test('adds explicit replied and development-only badges without claiming live delivery', () => {
    render(<CommunicationLifecycleBadge deliveryState="accepted" developmentOnly replied requestState="provider-accepted" />);

    expect(screen.getByText('Development only')).toBeVisible();
    expect(screen.getByText('Replied')).toBeVisible();
    expect(screen.queryByText('Provider accepted')).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting delivery')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });
});
