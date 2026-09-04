import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateAcquisitionMaterialsState } from '../server/services/acquisitionMaterials.js';

test('acquisition materials ignores unrelated secure documents', () => {
  const state = evaluateAcquisitionMaterialsState({
    submission: {
      metadata: {
        diligence: {
          stage: 'not-started',
          memo: 'Internal note about scheduling a call with the broker.',
          checklist: { nda: true },
        },
      },
    },
    secureDocuments: [
      { document_type: 'nda', original_name: 'signed-nda.pdf' },
      { document_type: 'other', original_name: 'team-note.txt', note: 'CIM might be requested later' },
      { document_type: 'other', original_name: 'insurance-certificate.pdf' },
    ],
    latestUploadRequest: {
      status: 'completed',
      requested_documents: [{ category: 'nda' }],
    },
  });

  assert.deepEqual(state, {
    materialsReceived: false,
    advancedBeyondBrokerOutreach: false,
    evidenceCodes: [],
  });
});

test('acquisition materials accepts canonical CIM teaser offering memorandum and completed broker upload evidence', async (t) => {
  const cases = [
    {
      name: 'prospectus URL',
      input: { submission: { prospectus_url: 'https://broker.example/cim.pdf' } },
      evidenceCode: 'prospectus-url',
    },
    {
      name: 'controlled CIM document type',
      input: { secureDocuments: [{ document_type: 'cim', original_name: 'document.pdf' }] },
      evidenceCode: 'secure-document-cim',
    },
    {
      name: 'bounded teaser filename',
      input: { secureDocuments: [{ document_type: 'other', original_name: 'Company Teaser.pdf' }] },
      evidenceCode: 'secure-document-cim',
    },
    {
      name: 'bounded offering memorandum filename',
      input: { secureDocuments: [{ document_type: 'other', original_name: 'Offering Memorandum.pdf' }] },
      evidenceCode: 'secure-document-cim',
    },
    {
      name: 'completed broker-material upload request',
      input: {
        latestUploadRequest: {
          status: 'completed',
          requested_documents: [{ category: 'financials' }],
        },
      },
      evidenceCode: 'broker-upload-completed',
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const state = evaluateAcquisitionMaterialsState(fixture.input);
      assert.equal(state.materialsReceived, true);
      assert.equal(state.evidenceCodes.includes(fixture.evidenceCode), true);
    });
  }
});

test('acquisition materials reports diligence or LOI advancement separately from materials receipt', () => {
  const financialReview = evaluateAcquisitionMaterialsState({
    submission: { metadata: { diligence: { stage: 'financial-review' } } },
  });
  assert.deepEqual(financialReview, {
    materialsReceived: true,
    advancedBeyondBrokerOutreach: true,
    evidenceCodes: ['diligence-stage-materials-received', 'diligence-stage-advanced'],
  });

  const loiCandidate = evaluateAcquisitionMaterialsState({
    submission: { metadata: { diligence: { stage: 'loi-candidate' } } },
  });
  assert.deepEqual(loiCandidate, {
    materialsReceived: false,
    advancedBeyondBrokerOutreach: true,
    evidenceCodes: ['diligence-stage-advanced'],
  });
});

test('acquisition materials evidence codes are stable bounded and contain no raw document metadata', () => {
  const privateSentinel = 'private-broker-document-identifier';
  const state = evaluateAcquisitionMaterialsState({
    submission: {
      prospectus_url: 'https://broker.example/private-cim.pdf',
      metadata: {
        diligence: {
          stage: 'cim-received',
          checklist: { cim: true, p_and_l: true, tax_returns: true, balance_sheet: true },
        },
      },
    },
    secureDocuments: Array.from({ length: 40 }, (_, index) => ({
      id: `${privateSentinel}-${index}`,
      document_type: index % 2 === 0 ? 'cim' : 'financials',
      original_name: `${privateSentinel}-${index}.pdf`,
      note: privateSentinel,
    })),
    latestUploadRequest: {
      id: privateSentinel,
      status: 'completed',
      requested_documents: [{ category: 'cim' }],
    },
  });

  assert.deepEqual(state.evidenceCodes, [
    'prospectus-url',
    'broker-upload-completed',
    'diligence-checklist-cim',
    'diligence-checklist-financial-package',
    'secure-document-cim',
    'secure-document-financial-package',
    'diligence-stage-materials-received',
  ]);
  assert.equal(state.evidenceCodes.length <= 10, true);
  assert.equal(JSON.stringify(state).includes(privateSentinel), false);
  assert.deepEqual(Object.keys(state).sort(), [
    'advancedBeyondBrokerOutreach',
    'evidenceCodes',
    'materialsReceived',
  ]);
});

test('acquisition materials recognizes a qualifying controlled document beyond the first 500 unrelated rows', () => {
  const state = evaluateAcquisitionMaterialsState({
    secureDocuments: [
      ...Array.from({ length: 500 }, (_, index) => ({
        document_type: 'other',
        original_name: `insurance-certificate-${index}.pdf`,
      })),
      { document_type: 'cim', original_name: 'controlled-material.pdf' },
    ],
  });

  assert.deepEqual(state, {
    materialsReceived: true,
    advancedBeyondBrokerOutreach: false,
    evidenceCodes: ['secure-document-cim'],
  });
});
