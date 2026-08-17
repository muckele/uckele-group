import React, { useId } from 'react';

export default function AdminTourTooltip({
  backProps,
  closeProps,
  continuous,
  index,
  isLastStep,
  primaryProps,
  size,
  skipProps,
  step,
  tooltipProps,
}) {
  const titleId = useId();

  return (
    <div
      {...tooltipProps}
      aria-labelledby={titleId}
      className="admin-tour-tooltip"
      data-admin-onboarding-dialog="true"
    >
      <div className="admin-tour-tooltip-heading">
        <p className="admin-tour-kicker">Page guide · {index + 1} of {size}</p>
        <button {...closeProps} className="admin-tour-close" type="button">
          Close
        </button>
      </div>

      <h2 className="admin-tour-title" id={titleId}>{step.title}</h2>
      <div className="admin-tour-content">{step.content}</div>

      <div className="admin-tour-footer">
        {!isLastStep ? (
          <button {...skipProps} className="admin-tour-button admin-tour-button-secondary" type="button">
            {skipProps.title}
          </button>
        ) : <span />}

        <div className="admin-tour-primary-actions">
          {index > 0 ? (
            <button {...backProps} className="admin-tour-button admin-tour-button-secondary" type="button">
              {backProps.title}
            </button>
          ) : null}
          {continuous ? (
            <button {...primaryProps} className="admin-tour-button admin-tour-button-primary" type="button">
              {primaryProps.title}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
