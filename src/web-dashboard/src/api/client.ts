const API_BASE_URL = '/api/v1';

interface Task {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  description?: string;
  output?: string;
}

interface Settings {
  serverUrl: string;
  telegramBotToken: string;
  autoRefresh: boolean;
  refreshInterval: number;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${response.status}: ${error}`);
  }
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    const json = await response.json();
    // Backend wraps responses in { success, data, ... } envelope
    if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
      return json.data as T;
    }
    return json as T;
  }
  return response.text() as unknown as T;
}

// Task APIs
export async function fetchTasks(): Promise<Task[]> {
  const response = await fetch(`${API_BASE_URL}/tasks`);
  return handleResponse<Task[]>(response);
}

export async function fetchTask(id: string): Promise<Task> {
  const response = await fetch(`${API_BASE_URL}/tasks/${id}`);
  return handleResponse<Task>(response);
}

export async function createTask(data: { title: string; description?: string }): Promise<Task> {
  const response = await fetch(`${API_BASE_URL}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  return handleResponse<Task>(response);
}

export async function cancelTask(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/tasks/${id}/cancel`, {
    method: 'POST',
  });
  await handleResponse(response);
}

export async function deleteTask(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/tasks/${id}`, {
    method: 'DELETE',
  });
  await handleResponse(response);
}

// Settings APIs
export async function fetchSettings(): Promise<Settings> {
  const response = await fetch(`${API_BASE_URL}/settings`);
  return handleResponse<Settings>(response);
}

export async function updateSettings(data: Partial<Settings>): Promise<Settings> {
  const response = await fetch(`${API_BASE_URL}/settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });
  return handleResponse<Settings>(response);
}

// Health check
export async function checkHealth(): Promise<{ status: string; version: string }> {
  const response = await fetch(`${API_BASE_URL}/health`);
  return handleResponse<{ status: string; version: string }>(response);
}
