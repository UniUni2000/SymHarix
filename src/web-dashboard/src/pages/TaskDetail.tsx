import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchTask, cancelTask, deleteTask } from '../api/client';

interface Task {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  description?: string;
  output?: string;
}

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: task, isLoading, error } = useQuery<Task>({
    queryKey: ['task', id],
    queryFn: () => fetchTask(id!),
    enabled: !!id,
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelTask(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['task', id] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteTask(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      navigate('/');
    },
  });

  const StateBadge = ({ state }: { state: string }) => {
    const config: Record<string, { class: string; label: string }> = {
      pending: { class: 'badge-pending', label: 'Pending' },
      running: { class: 'badge-running', label: 'Running' },
      completed: { class: 'badge-success', label: 'Completed' },
      failed: { class: 'badge-error', label: 'Failed' },
    };
    const { class: className, label } = config[state] || config.pending;
    return <span className={`badge ${className}`}>{label}</span>;
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="spinner"></div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="card border-red-500/20 bg-red-500/5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
            <svg className="w-5 h-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-medium text-red-400">Error loading task</h3>
            <p className="text-red-400/70 text-sm mt-1">
              {(error as Error)?.message || 'Task not found'}
            </p>
          </div>
        </div>
        <Link to="/" className="btn btn-primary mt-4 inline-block">
          Back to Tasks
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm">
        <Link to="/" className="text-gray-400 hover:text-white transition-colors">
          Tasks
        </Link>
        <svg className="w-4 h-4 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-gray-400 truncate">{task.title}</span>
      </div>

      {/* Task Header */}
      <div className="card">
        <div className="flex flex-col lg:flex-row justify-between items-start gap-4 mb-6">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 flex items-center justify-center border border-blue-500/30">
              <svg className="w-7 h-7 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white mb-1">{task.title}</h1>
              <div className="flex items-center gap-3">
                <StateBadge state={task.status} />
              </div>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <div className="p-4 rounded-xl bg-gray-500/5 border border-gray-500/20">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Created</p>
            <p className="text-sm text-white font-medium">
              {new Date(task.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              })}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {new Date(task.createdAt).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit'
              })}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-gray-500/5 border border-gray-500/20">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Updated</p>
            <p className="text-sm text-white font-medium">
              {new Date(task.updatedAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
              })}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {new Date(task.updatedAt).toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit'
              })}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-gray-500/5 border border-gray-500/20">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">Status</p>
            <p className="text-sm text-white font-medium capitalize">{task.status}</p>
          </div>
        </div>

        {/* Description */}
        {task.description && (
          <div className="mb-6">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Description</h3>
            <p className="text-gray-300 whitespace-pre-wrap leading-relaxed">{task.description}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-6 border-t border-gray-700">
          {task.status === 'running' && (
            <button
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              className="btn btn-secondary"
            >
              {cancelMutation.isPending ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"></div>
                  Cancelling...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                  </svg>
                  Cancel Task
                </>
              )}
            </button>
          )}
          <button
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
            className="btn"
            style={{ background: 'rgba(244, 63, 94, 0.15)', color: '#f43f5e', borderColor: 'rgba(244, 63, 94, 0.3)' }}
          >
            {deleteMutation.isPending ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"></div>
                Deleting...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete Task
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
