const API_BASE = window.CONSTRUCT_API_BASE || import.meta.env.VITE_API_BASE || "/api/v1";
const inflightGetRequests = new Map();

function getRequestKey(path, { token = "", headers = {}, method = "GET" } = {}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const headerPairs = Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
  return `${normalizedMethod}::${token}::${path}::${headerPairs}`;
}

export async function apiRequest(path, { token = "", isFormData = false, ...options } = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };
  if (!isFormData && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const runRequest = async () => {
    const response = await fetch(`${API_BASE}${path}`, { ...options, method, headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.detail || `${response.status}`);
    }
    if (response.status === 204) {
      return null;
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  };

  const canDedupe = method === "GET" && !options.body && !isFormData;
  if (!canDedupe) {
    return runRequest();
  }

  const requestKey = getRequestKey(path, { token, headers, method });
  if (inflightGetRequests.has(requestKey)) {
    return inflightGetRequests.get(requestKey);
  }

  const requestPromise = runRequest().finally(() => {
    inflightGetRequests.delete(requestKey);
  });
  inflightGetRequests.set(requestKey, requestPromise);
  return requestPromise;
}

export async function apiDownload(path, { token = "", ...options } = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || `${response.status}`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/i);
  return {
    blob,
    filename: match ? match[1] : null,
    contentType: response.headers.get("content-type") || "",
  };
}
