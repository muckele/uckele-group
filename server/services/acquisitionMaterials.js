const relevantDocumentTypes = new Set([
  'cim',
  'teaser',
  'prospectus',
  'offering_memorandum',
  'offering_materials',
  'data_room',
  'broker_materials',
  'financials',
  'financial_package',
  'financial_statements',
  'p_and_l',
  'tax_returns',
  'balance_sheet',
]);

const cimDocumentTypes = new Set([
  'cim',
  'teaser',
  'prospectus',
  'offering_memorandum',
  'offering_materials',
  'data_room',
  'broker_materials',
]);

const financialDocumentTypes = new Set([
  'financials',
  'financial_package',
  'financial_statements',
  'p_and_l',
  'tax_returns',
  'balance_sheet',
]);

const materialsDiligenceStages = new Set(['cim-received', 'financial-review', 'lender-review']);
const advancedDiligenceStages = new Set(['financial-review', 'lender-review', 'loi-candidate']);
const materialsPipelineStages = new Set(['docs-received', 'diligence']);
const advancedPipelineStages = new Set(['diligence', 'loi-candidate']);

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizedToken(value, maximum = 120) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .slice(0, maximum);
}

function normalizedText(value, maximum = 300) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, maximum);
}

function filenameMaterialKind(document = {}) {
  const filename = normalizedText(document.original_name || document.name || document.filename);
  if (!filename) return '';
  if (/\b(cim|teaser|prospectus)\b|\bconfidential information memorandum\b|\boffering (memorandum|materials?)\b/.test(filename)) {
    return 'cim';
  }
  if (/\bfinancial (package|statements?)\b|\bp\s*(?:&|and)\s*l\b|\bprofit and loss\b|\btax returns?\b|\bbalance sheet\b/.test(filename)) {
    return 'financial';
  }
  return '';
}

function requestedDocumentTypes(request = {}) {
  const requested = Array.isArray(request.requested_documents)
    ? request.requested_documents
    : Array.isArray(request.requestedDocuments)
      ? request.requestedDocuments
      : [];
  return requested.map((item) => normalizedToken(typeof item === 'string' ? item : item?.category || item?.id));
}

export function evaluateAcquisitionMaterialsState({
  submission = {},
  secureDocuments = [],
  latestUploadRequest = null,
} = {}) {
  const safeSubmission = objectValue(submission);
  const metadata = objectValue(safeSubmission.metadata);
  const diligence = objectValue(metadata.diligence);
  const checklist = objectValue(diligence.checklist);
  const command = objectValue(metadata.acquisitionCommand);
  const diligenceStage = normalizedToken(diligence.stage).replace(/_/g, '-');
  const pipelineStage = normalizedToken(command.pipelineStage).replace(/_/g, '-');
  const documents = Array.isArray(secureDocuments) ? secureDocuments : [];
  const evidence = new Set();

  if (String(safeSubmission.prospectus_url || safeSubmission.prospectusUrl || '').trim()) {
    evidence.add('prospectus-url');
  }

  const upload = objectValue(latestUploadRequest);
  const uploadStatus = normalizedToken(upload.status).replace(/_/g, '-');
  const requestedTypes = requestedDocumentTypes(upload);
  if (
    uploadStatus === 'documents-received'
    || (uploadStatus === 'completed' && requestedTypes.some((type) => relevantDocumentTypes.has(type)))
  ) {
    evidence.add('broker-upload-completed');
  }

  if (checklist.cim === true) evidence.add('diligence-checklist-cim');
  if (['p_and_l', 'tax_returns', 'balance_sheet'].some((key) => checklist[key] === true)) {
    evidence.add('diligence-checklist-financial-package');
  }

  let hasCimDocument = false;
  let hasFinancialDocument = false;
  for (const document of documents.slice(0, 500)) {
    const type = normalizedToken(document?.document_type || document?.documentType);
    const filenameKind = filenameMaterialKind(document);
    if (cimDocumentTypes.has(type) || filenameKind === 'cim') hasCimDocument = true;
    if (financialDocumentTypes.has(type) || filenameKind === 'financial') hasFinancialDocument = true;
  }
  if (hasCimDocument) evidence.add('secure-document-cim');
  if (hasFinancialDocument) evidence.add('secure-document-financial-package');

  if (materialsDiligenceStages.has(diligenceStage)) evidence.add('diligence-stage-materials-received');
  if (materialsPipelineStages.has(pipelineStage)) evidence.add('pipeline-stage-materials-received');
  if (advancedDiligenceStages.has(diligenceStage)) evidence.add('diligence-stage-advanced');
  if (advancedPipelineStages.has(pipelineStage)) evidence.add('pipeline-stage-advanced');

  const evidenceCodes = [
    'prospectus-url',
    'broker-upload-completed',
    'diligence-checklist-cim',
    'diligence-checklist-financial-package',
    'secure-document-cim',
    'secure-document-financial-package',
    'diligence-stage-materials-received',
    'pipeline-stage-materials-received',
    'diligence-stage-advanced',
    'pipeline-stage-advanced',
  ].filter((code) => evidence.has(code));

  return {
    materialsReceived: evidenceCodes.some((code) => !code.endsWith('-advanced')),
    advancedBeyondBrokerOutreach: evidenceCodes.some((code) => code.endsWith('-advanced')),
    evidenceCodes,
  };
}
