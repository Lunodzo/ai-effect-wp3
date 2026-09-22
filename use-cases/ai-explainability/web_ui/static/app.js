let manifest = null;
let workflowId = null;
let latestStatus = null;
let pollHandle = null;

const fieldsEl = document.getElementById('fields');
const formEl = document.getElementById('workflowForm');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const timelineEl = document.getElementById('timeline');
const actionsEl = document.getElementById('actions');
const submitBtn = document.getElementById('submitBtn');
const resetBtn = document.getElementById('resetBtn');
const outputTitle = document.getElementById('outputTitle');
const pipelineBadge = document.getElementById('pipelineBadge');
const pageTitle = document.getElementById('pageTitle');
const pageDescription = document.getElementById('pageDescription');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

// Generate HTML for a single form field based on its type and properties
function fieldHtml(field) {
  const required = field.required ? 'required' : '';
  const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';
  const value = field.default ?? '';
  const hint = field.help ? `<div class="hint">${escapeHtml(field.help)}</div>` : '';
  const label = `<label class="form-label" for="field-${field.name}">${escapeHtml(field.label || field.name)}</label>`;

  let control = '';
  if (field.type === 'select') {
    const options = (field.options || [])
      .map(option => `<option value="${escapeHtml(option.value ?? option)}">${escapeHtml(option.label ?? option)}</option>`)
      .join('');
    control = `<select class="form-select" id="field-${field.name}" name="${escapeHtml(field.name)}" ${required}>${options}</select>`;
  } else if (field.type === 'number') {
    control = `<input class="form-control" id="field-${field.name}" name="${escapeHtml(field.name)}" type="number" value="${escapeHtml(value)}" ${placeholder} ${required}>`;
  } else if (field.type === 'checkbox') {
    return `<div class="form-check field"><input class="form-check-input" id="field-${field.name}" name="${escapeHtml(field.name)}" type="checkbox" ${value ? 'checked' : ''}><label class="form-check-label" for="field-${field.name}">${escapeHtml(field.label || field.name)}</label>${hint}</div>`;
  } else if (field.type === 'file') {
    const accept = field.accept ? `accept="${escapeHtml(field.accept)}"` : '';
    control = `<input class="form-control" id="field-${field.name}" name="${escapeHtml(field.name)}" type="file" ${accept} ${required}>`;
  } else if (field.type === 'textarea') {
    control = `<textarea class="form-control" id="field-${field.name}" name="${escapeHtml(field.name)}" ${placeholder} ${required}>${escapeHtml(value)}</textarea>`;
  } else {
    control = `<input class="form-control" id="field-${field.name}" name="${escapeHtml(field.name)}" type="text" value="${escapeHtml(value)}" ${placeholder} ${required}>`;
  }

  return `<div class="field">${label}${control}${hint}</div>`;
}

// Collect values from all input fields in the form
function collectInputs() {
  const result = {};
  for (const field of manifest.inputs || []) {
    const element = document.getElementById(`field-${field.name}`);
    if (!element) continue;
    if (field.type === 'file') continue;

    result[field.name] = field.type === 'checkbox' ? element.checked : element.value;
    if (field.type === 'number' && result[field.name] !== '') {
      result[field.name] = Number(result[field.name]);
    }
  }
  return result;
}

async function uploadConfiguredFiles() {
  const uploadedPaths = {};
  for (const field of manifest.inputs || []) {
    if (field.type !== 'file') continue;

    const element = document.getElementById(`field-${field.name}`);
    const file = element?.files?.[0];
    if (!file) continue;
    if (!field.config_field || !field.upload_category) {
      throw new Error(`Upload field '${field.name}' is missing configuration.`);
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('category', field.upload_category);
    const response = await fetch('/uploads', {method: 'POST', body: formData});
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || `Could not upload ${file.name}.`);
    }
    uploadedPaths[field.config_field] = data.path;
  }

  if (!Object.keys(uploadedPaths).length) return;

  const configFieldName = manifest.upload_config_field || 'config_json';
  const configElement = document.getElementById(`field-${configFieldName}`);
  if (!configElement) {
    throw new Error(`Upload configuration field '${configFieldName}' was not found.`);
  }

  let config;
  try {
    config = JSON.parse(configElement.value);
  } catch {
    throw new Error('Analysis configuration must be valid JSON before files can be uploaded.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Analysis configuration must be a JSON object.');
  }

  Object.assign(config, uploadedPaths);
  configElement.value = JSON.stringify(config, null, 2);
}

// Update the status message displayed to the user
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('alert-secondary', !isError);
  statusEl.classList.toggle('alert-danger', isError);
}


// Render the timeline of tasks for the workflow
function renderTimeline(tasks) {
  if (!tasks?.length) {
    timelineEl.innerHTML = '';
    return;
  }

  timelineEl.innerHTML = tasks.map(task => `
    <div class="list-group-item workflow-task">
      <div>
        <strong>${escapeHtml(task.service || task.service_name || task.task_id || 'Task')}</strong>
        <div class="form-text">${escapeHtml(task.method || task.method_name || '')}</div>
      </div>
      <span class="badge rounded-pill text-bg-light border">${escapeHtml(task.status || 'pending')}</span>
    </div>
  `).join('');
}


// Recursively search for a key in an object and return its value if found, otherwise return undefined
function deepFind(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];

  for (const child of Object.values(value)) {
    const found = deepFind(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Extract the first non-empty summary field from the payload
// it is used to display a brief summary of the workflow output
function firstSummary(payload) {
  const fields = manifest.output?.summary_fields || [];
  for (const field of fields) {
    const found = deepFind(payload, field);
    if (typeof found === 'string' && found.trim()) return found;
  }
  return '';
}

// Render images associated with the workflow output
// if no images are found, an empty string is returned
function renderImages(currentWorkflowId, payload) {
  const collectionField = manifest.output?.image_collection_field || 'drawings';
  const signatureField = manifest.output?.image_signature_field || 'signature';
  const drawings = deepFind(payload, collectionField);
  if (!Array.isArray(drawings) || !drawings.length) return '';

  const items = drawings.map((drawing, index) => {
    const signature = drawing?.[signatureField] || String(index + 1);
    return `<div class="col-12 col-md-6"><figure class="figure workflow-asset"><img class="figure-img img-fluid" src="/workflows/${encodeURIComponent(currentWorkflowId)}/assets/${encodeURIComponent(signature)}" alt="Workflow asset ${escapeHtml(signature)}"><figcaption class="figure-caption px-2 pb-2">${escapeHtml(signature)}</figcaption></figure></div>`;
  }).join('');
  return `<div class="row g-3">${items}</div>`;
}

function renderMarkdown(markdown) {
  if (!markdown) return '';
  return `<div class="report-markdown">${escapeHtml(markdown)
    .replace(/^### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^## (.*)$/gm, '<h4>$1</h4>')
    .replace(/^# (.*)$/gm, '<h3>$1</h3>')
    .replace(/^- (.*)$/gm, '<div class="report-item">$1</div>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '<br><br>')
    }</div>`;
}

function renderArtifacts(currentWorkflowId, payload, taskId) {
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  if (taskId && !artifacts.some(artifact => (typeof artifact === 'string' ? artifact : artifact.path) === 'report.md')) {
    artifacts.push('report.md');
  }
  if (!artifacts.length) return '';
  const links = artifacts.map(artifact => {
    const path = typeof artifact === 'string' ? artifact : artifact.path;
    if (!path) return '';
    const extension = path.split('.').pop().toLowerCase();
    const previewable = ['md', 'markdown', 'csv', 'json'].includes(extension);
    const preview = previewable
      ? `<div class="artifact-preview" data-artifact-path="${escapeHtml(path)}"><span class="preview-loading">Loading...</span></div>`
      : '';
    const filePath = [taskId, path].filter(Boolean).join('/');
    return `<li class="artifact-item"><div class="artifact-line"><span>${escapeHtml(path)}</span><a class="artifact-download" href="/workflows/${encodeURIComponent(currentWorkflowId)}/files/${filePath.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener">Download</a></div>${preview}</li>`;
  }).join('');
  const downloadAll = taskId
    ? `<a class="artifact-download-all" href="/workflows/${encodeURIComponent(currentWorkflowId)}/tasks/${encodeURIComponent(taskId)}/download">Download all</a>`
    : '';
  return `<div class="artifacts-heading"><h4>Artifacts</h4>${downloadAll}</div><ul>${links}</ul>`;
}

function artifactUrl(currentWorkflowId, taskId, path) {
  const filePath = [taskId, path].filter(Boolean).join('/');
  return `/workflows/${encodeURIComponent(currentWorkflowId)}/files/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

function renderCsvPreview(text) {
  const rows = text.trim().split(/\r?\n/).filter(Boolean).slice(0, 21)
    .map(row => row.split(',').map(cell => cell.trim()));
  if (!rows.length) return '<p class="preview-empty">CSV is empty.</p>';
  const header = rows[0];
  const body = rows.slice(1).map(row => `<tr>${header.map((_, index) => `<td>${escapeHtml(row[index] || '')}</td>`).join('')}</tr>`).join('');
  return `<div class="table-responsive"><table class="table table-sm artifact-table"><thead><tr>${header.map(cell => `<th>${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>${text.trim().split(/\r?\n/).length > 21 ? '<small class="preview-note">Showing the first 20 rows.</small>' : ''}`;
}

async function loadArtifactPreviews(currentWorkflowId, taskId) {
  const previews = outputEl.querySelectorAll('.artifact-preview');
  await Promise.all([...previews].map(async preview => {
    const path = preview.dataset.artifactPath;
    const extension = path.split('.').pop().toLowerCase();
    try {
      const response = await fetch(artifactUrl(currentWorkflowId, taskId, path));
      if (!response.ok) throw new Error('Preview unavailable');
      const text = await response.text();
      if (extension === 'md' || extension === 'markdown') {
        preview.innerHTML = `<div class="artifact-label">Report</div>${renderMarkdown(text)}`;
      } else if (extension === 'csv') {
        preview.innerHTML = `<div class="artifact-label">Data</div>${renderCsvPreview(text)}`;
      } else {
        preview.innerHTML = `<div class="artifact-label">JSON</div><pre>${escapeHtml(JSON.stringify(JSON.parse(text), null, 2))}</pre>`;
      }
    } catch (error) {
      preview.innerHTML = '<span class="preview-empty">Preview unavailable. Use Download.</span>';
    }
  }));
}

// Render the workflow outputs, including summaries, images, and raw payloads
function renderOutputs(statusData) {
  latestStatus = statusData;
  renderTimeline(statusData.tasks || []);
  outputTitle.textContent = manifest.output?.title || 'Workflow output';

  const outputs = statusData.outputs || [];
  if (!outputs.length) {
    outputEl.innerHTML = '<div class="empty-state">No workflow output is available yet.</div>';
    return;
  }

  outputEl.innerHTML = outputs.map(output => {
    const summary = firstSummary(output.payload);
    const images = renderImages(statusData.workflow_id, output.payload);
    const report = renderMarkdown(output.payload.report_markdown);
    const artifacts = renderArtifacts(statusData.workflow_id, output.payload, output.task_id);
    return `<article class="card output-card">
      <div class="card-body">
      <h3 class="h5 card-title">${escapeHtml(output.service || output.task_id || 'Output')}</h3>
      ${summary ? `<p class="summary">${escapeHtml(summary)}</p>` : ''}
      ${report}
      ${images}
      ${artifacts}
      <pre>${escapeHtml(JSON.stringify(output.payload, null, 2))}</pre>
      </div>
    </article>`;
  }).join('');
  loadArtifactPreviews(statusData.workflow_id, outputs[0].task_id);
}


// Retrieve the selected value from the workflow outputs based on the configured field
function selectedValue() {
  const field = manifest.output?.selected_value_field || 'signature';
  for (const output of latestStatus?.outputs || []) {
    const found = deepFind(output.payload, field);
    if (found !== undefined) return String(found);
  }
  return null;
}

// Render action buttons based on the configured actions in the manifest
function renderActions() {
  const actions = manifest.actions || [];
  if (!actions.length) return;

  actionsEl.hidden = false;
  actionsEl.innerHTML = actions.map(action => (
    `<button type="button" class="${buttonClass(action.style)}" data-action="${escapeHtml(action.name)}">${escapeHtml(action.label || action.name)}</button>`
  )).join('');
}

// Determine the CSS class for a button based on its style
function buttonClass(style) {
  const classes = {
    primary: 'btn btn-primary',
    secondary: 'btn btn-outline-secondary',
    danger: 'btn btn-outline-danger',
    success: 'btn btn-outline-success',
    warning: 'btn btn-outline-warning',
  };
  return classes[style] || classes.secondary;
}

// Poll the workflow status periodically and update the UI accordingly
// async operation enables non-blocking network requests for polling the workflow status
// Record a decision made by the user for the current workflow
async function recordDecision(action) {
  if (!workflowId) return;

  const response = await fetch('/decision', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({workflow_id: workflowId, action, value: selectedValue()}),
  });
  const data = await response.json();
  setStatus(data.message || data.status || 'Decision recorded.', !response.ok);
}

async function pollWorkflow() {
  if (!workflowId) return;

  const response = await fetch(`/workflows/${encodeURIComponent(workflowId)}`);
  const data = await response.json();
  if (!response.ok || data.status === 'failed') {
    setStatus(data.error || data.detail || 'Workflow failed.', true);
    renderOutputs(data);
    return;
  }

  renderOutputs(data);
  if (data.status === 'completed') {
    setStatus('Workflow completed.');
    return;
  }
  pollHandle = setTimeout(pollWorkflow, manifest.poll_interval_ms || 2000);
}


// Submit the workflow with the collected input values and start polling for its status
async function submitWorkflow(event) {
  event.preventDefault();
  if (pollHandle) clearTimeout(pollHandle);

  submitBtn.disabled = true;
  setStatus('Uploading selected files...');
  outputEl.innerHTML = '<div class="empty-state">Waiting for workflow output.</div>';

  try {
    await uploadConfiguredFiles();
  } catch (error) {
    submitBtn.disabled = false;
    setStatus(error.message || 'File upload failed.', true);
    return;
  }

  setStatus('Submitting workflow...');

  const response = await fetch('/submit', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({inputs: collectInputs()}),
  });
  const data = await response.json();
  submitBtn.disabled = false;

  if (!response.ok) {
    setStatus(data.detail || 'Submission failed.', true);
    return;
  }

  workflowId = data.workflow_id;
  setStatus(`Workflow started: ${workflowId}.`);
  renderOutputs(data);
  pollWorkflow();
}


// Reset the workflow state and clear the UI elements
function resetWorkflow() {
  formEl.reset();
  workflowId = null;
  latestStatus = null;
  if (pollHandle) clearTimeout(pollHandle);
  timelineEl.innerHTML = '';
  outputEl.innerHTML = '<div class="empty-state">Run a workflow to see results here.</div>';
  setStatus('Ready.');
}


// Render the manifest configuration and apply the theme
function renderManifest() {
  applyTheme();
  document.title = manifest.title || 'AI-EFFECT Workflow';
  pageTitle.textContent = manifest.title || 'AI-EFFECT Workflow';
  pageDescription.textContent = manifest.description || '';
  fieldsEl.innerHTML = (manifest.inputs || []).map(fieldHtml).join('');
  submitBtn.textContent = manifest.submit_label || 'Start workflow';
  pipelineBadge.textContent = `${(manifest.pipeline?.services || []).length} services`;
  renderActions();
  setStatus('Ready.');
}

// Apply the theme specified in the manifest to the document
function applyTheme() {
  const theme = manifest.theme || {};
  const properties = {
    accent: '--accent',
    accent_strong: '--accent-strong',
    ink: '--ink',
    muted: '--muted',
    line: '--line',
    background: '--workflow-background',
    font_family: '--workflow-font-family',
  };

  for (const [key, property] of Object.entries(properties)) {
    if (typeof theme[key] === 'string' && theme[key].trim()) {
      document.documentElement.style.setProperty(property, theme[key]);
    }
  }

  for (const className of manifest.body_classes || []) {
    if (/^[a-zA-Z0-9_-]+$/.test(className)) {
      document.body.classList.add(className);
    }
  }
}

async function loadManifest() {
  const response = await fetch('/ui/config');
  manifest = await response.json();
  if (!response.ok) {
    setStatus(manifest.detail || 'Workflow UI configuration failed to load.', true);
    return;
  }
  renderManifest();
}

formEl.addEventListener('submit', submitWorkflow);
resetBtn.addEventListener('click', resetWorkflow);
actionsEl.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (button) recordDecision(button.dataset.action);
});

loadManifest();