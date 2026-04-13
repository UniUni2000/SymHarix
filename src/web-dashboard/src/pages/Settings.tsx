import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSettings, updateSettings } from '../api/client';

interface Settings {
  serverUrl: string;
  telegramBotToken: string;
  autoRefresh: boolean;
  refreshInterval: number;
}

export default function Settings() {
  const queryClient = useQueryClient();
  const [serverUrl, setServerUrl] = useState('http://localhost:8080');
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(30);
  const [showToken, setShowToken] = useState(false);

  const { data: settings } = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: fetchSettings,
  });

  useEffect(() => {
    if (settings) {
      setServerUrl(settings.serverUrl || 'http://localhost:8080');
      setTelegramBotToken(settings.telegramBotToken || '');
      setAutoRefresh(settings.autoRefresh ?? true);
      setRefreshInterval(settings.refreshInterval ?? 30);
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: () => updateSettings({ serverUrl, telegramBotToken, autoRefresh, refreshInterval }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const handleSave = () => {
    saveMutation.mutate();
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-white mb-1">Settings</h1>
        <p className="text-gray-400 text-sm">Configure your Symphony preferences</p>
      </div>

      {/* Server Configuration */}
      <div className="card">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
            <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Server Configuration</h2>
            <p className="text-sm text-gray-400">HTTP API endpoint settings</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="serverUrl" className="block text-sm font-medium text-gray-300 mb-2">
              Server URL
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </div>
              <input
                id="serverUrl"
                type="text"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                className="input pl-10"
                placeholder="http://localhost:8080"
              />
            </div>
            <p className="text-sm text-gray-500 mt-2">
              Base URL for the Symphony HTTP server API
            </p>
          </div>
        </div>
      </div>

      {/* Telegram Integration */}
      <div className="card">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center">
            <svg className="w-5 h-5 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Telegram Integration</h2>
            <p className="text-sm text-gray-400">Bot configuration for notifications</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label htmlFor="telegramBotToken" className="block text-sm font-medium text-gray-300 mb-2">
              Bot Token
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg className="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <input
                id="telegramBotToken"
                type={showToken ? 'text' : 'password'}
                value={telegramBotToken}
                onChange={(e) => setTelegramBotToken(e.target.value)}
                className="input pl-10 pr-20"
                placeholder="Enter your Telegram bot token"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-white transition-colors"
              >
                {showToken ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.872 3.882L4.3 13.454a9.98 9.98 0 003.032 6.344c.52.443 1.065.842 1.632 1.193M21 21l-4.35-4.35M17 7a5 5 0 11-10 0 5 5 0 0110 0z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.872 3.882L4.3 13.454a9.98 9.98 0 003.032 6.344c.52.443 1.065.842 1.632 1.193M21 21l-4.35-4.35M19 10.5a7.495 7.495 0 00-1.177-4.042L5.043 19.337A7.5 7.5 0 0019 10.5zm-3.293 3.293l-3.414-3.414" />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-sm text-gray-500 mt-2">
              Get your bot token from <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">@BotFather</a> on Telegram
            </p>
          </div>
        </div>
      </div>

      {/* Dashboard Preferences */}
      <div className="card">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
            <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Dashboard Preferences</h2>
            <p className="text-sm text-gray-400">Customize your experience</p>
          </div>
        </div>

        <div className="space-y-6">
          {/* Auto-refresh Toggle */}
          <div className="flex items-center justify-between p-4 rounded-xl bg-gray-500/5 border border-gray-500/20">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </div>
              <div>
                <label htmlFor="autoRefresh" className="block text-sm font-medium text-white">
                  Auto-refresh
                </label>
                <p className="text-xs text-gray-500">Automatically refresh task data</p>
              </div>
            </div>
            <button
              id="autoRefresh"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                autoRefresh ? 'bg-blue-600' : 'bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${
                  autoRefresh ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Refresh Interval */}
          <div className="p-4 rounded-xl bg-gray-500/5 border border-gray-500/20">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <label htmlFor="refreshInterval" className="block text-sm font-medium text-white">
                  Refresh Interval
                </label>
                <p className="text-xs text-gray-500">How often to check for updates</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <input
                id="refreshInterval"
                type="number"
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Number(e.target.value))}
                className="input w-32"
                min={5}
                max={300}
              />
              <span className="text-sm text-gray-400">seconds</span>
            </div>
            <input
              type="range"
              min={5}
              max={300}
              step={5}
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              className="w-full mt-4 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex flex-wrap gap-4">
        <button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="btn btn-primary"
        >
          {saveMutation.isPending ? (
            <>
              <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin"></div>
              Saving...
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
              Save Changes
            </>
          )}
        </button>
        <button
          onClick={() => {
            setServerUrl('http://localhost:8080');
            setTelegramBotToken('');
            setAutoRefresh(true);
            setRefreshInterval(30);
          }}
          className="btn btn-secondary"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
