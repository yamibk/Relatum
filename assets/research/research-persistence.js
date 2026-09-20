const WORKSPACE_ENDPOINT = '/api/research/workspace';

export class ResearchPersistenceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ResearchPersistenceError';
    this.status = Number(options.status) || 0;
    this.code = String(options.code || 'request-failed');
    this.currentRevision = String(options.currentRevision || '');
    this.issues = Array.isArray(options.issues) ? options.issues : [];
  }
}

async function responsePayload(response) {
  try {
    const payload = await response.json();
    return payload && typeof payload === 'object' ? payload : {};
  } catch (_error) {
    return {};
  }
}

async function requestWorkspace(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new ResearchPersistenceError('无法连接本地研究数据服务', { code: 'offline' });
  }
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new ResearchPersistenceError(payload.error || '研究数据请求失败', {
      status: response.status,
      code: payload.code,
      currentRevision: payload.currentRevision,
      issues: payload.issues,
    });
  }
  return payload;
}

export function loadResearchWorkspace() {
  return requestWorkspace(WORKSPACE_ENDPOINT, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
}

export function saveResearchWorkspace(document, revision, options = {}) {
  return requestWorkspace(WORKSPACE_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ document, revision: String(revision || '') }),
    cache: 'no-store',
    keepalive: options.keepalive === true,
  });
}

