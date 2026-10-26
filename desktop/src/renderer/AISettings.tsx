import { useEffect, useRef, useState } from 'react';
import type { AIMode, AIState, CloudProviderId } from '../shared/types';
import { CLOUD_PRESETS } from '../shared/validation';

const GEMINI_PREFERRED_MODELS = [
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.5-flash-lite',
];

export function AISettings() {
  const [ai, setAI] = useState<AIState>({
    mode: 'local',
    model: '',
    models: [],
    modelSizes: {},
    connected: false,
    error: '',
    cloud: {
      provider: 'gemini',
      endpoint: CLOUD_PRESETS.gemini.endpoint,
      model: CLOUD_PRESETS.gemini.defaultModel,
      apiKeySet: false,
      maskedKey: '',
    },
  });
  const [checking, setChecking] = useState(false);
  const [localNotice, setLocalNotice] = useState('');
  const [isLocalError, setIsLocalError] = useState(false);
  const [pendingHeavyModel, setPendingHeavyModel] = useState<string | null>(null);

  // Cloud configuration form
  const [cloudProvider, setCloudProvider] = useState<CloudProviderId>('gemini');
  const [cloudEndpoint, setCloudEndpoint] = useState(CLOUD_PRESETS.gemini.endpoint);
  const [cloudModel, setCloudModel] = useState(CLOUD_PRESETS.gemini.defaultModel);
  const [cloudApiKey, setCloudApiKey] = useState('');
  const [savingCloud, setSavingCloud] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [detectedModels, setDetectedModels] = useState<string[]>([]);
  const [cloudNotice, setCloudNotice] = useState('');
  const [isCloudError, setIsCloudError] = useState(false);

  // Overhaul states
  const [userPicked, setUserPicked] = useState(false);
  const [statusBadge, setStatusBadge] = useState<'connected' | 'checking' | 'unavailable' | 'idle'>('idle');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [otherExpanded, setOtherExpanded] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!window.companion) return;
    const updateFromState = (next: AIState) => {
      setAI(next);
      setCloudProvider(next.cloud.provider);
      setCloudEndpoint(next.cloud.endpoint);
      setCloudModel(next.cloud.model);
      if (next.mode === 'cloud') {
        if (next.cloud.apiKeySet && next.connected && !next.error) {
          setStatusBadge('connected');
        } else if (next.error) {
          setStatusBadge('unavailable');
        }
      }
    };
    const unsub = window.companion.onAI(updateFromState);
    void window.companion.getAI().then(updateFromState).catch(() => {});
    return unsub;
  }, []);

  const check = async () => {
    if (!window.companion) return;
    setChecking(true);
    setLocalNotice('');
    try {
      const next = await window.companion.checkAI();
      setAI(next);
      setIsLocalError(false);
      setLocalNotice(next.connected ? 'Ollama connected and models updated.' : 'Could not connect to Ollama.');
    } catch {
      setIsLocalError(true);
      setLocalNotice('Could not check the connection. Please try again.');
    } finally {
      setChecking(false);
    }
  };

  const handleModeChange = async (mode: AIMode) => {
    if (!window.companion || ai.mode === mode) return;
    try {
      const result = await window.companion.setAIMode(mode);
      if (result.ok) {
        setAI(prev => ({ ...prev, mode }));
      }
    } catch {
      // ignore
    }
  };

  const executeSelectModel = async (model: string) => {
    if (!window.companion || !model) return;
    setChecking(true);
    setLocalNotice('');
    setPendingHeavyModel(null);
    try {
      const result = await window.companion.selectModel(model);
      if (result.ok) {
        setAI(previous => ({ ...previous, model }));
        setIsLocalError(false);
        setLocalNotice('Model saved. Your next message will use it.');
      } else {
        setIsLocalError(true);
        setLocalNotice(result.error ?? 'Could not change the model.');
      }
    } catch {
      setIsLocalError(true);
      setLocalNotice('Could not change the model. Please try again.');
    } finally {
      setChecking(false);
    }
  };

  const onModelDropdownChange = (model: string) => {
    if (!model) return;
    const meta = ai.modelSizes[model];
    if (meta?.heavy) {
      setPendingHeavyModel(model);
    } else {
      void executeSelectModel(model);
    }
  };

  const handleProviderSelect = (p: CloudProviderId) => {
    setCloudProvider(p);
    setCloudEndpoint(CLOUD_PRESETS[p].endpoint);
    setCloudModel(CLOUD_PRESETS[p].defaultModel);
    setDetectedModels([]);
    setUserPicked(false);
    setCloudNotice('');
    setIsCloudError(false);
    setStatusBadge('idle');
  };

  const testCandidateModel = async (model: string): Promise<boolean> => {
    if (!window.companion || !model.trim()) return false;
    setStatusBadge('checking');
    try {
      const clean = cloudProvider === 'gemini' ? model.trim().replace(/^models\//i, '') : model.trim();
      const res = await window.companion.testCloud({
        provider: cloudProvider,
        endpoint: cloudEndpoint,
        model: clean,
        apiKey: cloudApiKey.trim() || undefined,
      });
      if (res.ok) {
        setStatusBadge('connected');
        setIsCloudError(false);
        setCloudNotice(`Model "${clean}" connected successfully.`);
        void window.companion.saveCloudConfig({
          provider: cloudProvider,
          endpoint: cloudEndpoint,
          model: clean,
          apiKey: cloudApiKey.trim() || undefined,
        });
        return true;
      }
      setStatusBadge('unavailable');
      setIsCloudError(true);
      setCloudNotice(res.error ?? `Model "${clean}" unavailable.`);
      return false;
    } catch (err) {
      setStatusBadge('unavailable');
      setIsCloudError(true);
      setCloudNotice(err instanceof Error ? err.message : 'Connection test failed.');
      return false;
    }
  };

  const autoSelectAndTest = async (modelsList: string[], forceAuto = false) => {
    if (!window.companion || modelsList.length === 0) return;

    const effectiveUserPicked = forceAuto ? false : userPicked;
    if (effectiveUserPicked && cloudModel) {
      await testCandidateModel(cloudModel);
      return;
    }

    // Determine candidates in preferred order
    let candidates: string[] = [];
    if (cloudProvider === 'gemini') {
      const preferredFound = GEMINI_PREFERRED_MODELS.filter(m => modelsList.includes(m));
      const rest = modelsList.filter(m => !GEMINI_PREFERRED_MODELS.includes(m));
      candidates = [...preferredFound, ...rest];
    } else {
      const presets = CLOUD_PRESETS[cloudProvider]?.models ?? [];
      const presetsInList = presets.filter(m => modelsList.includes(m));
      const rest = modelsList.filter(m => !presets.includes(m));
      candidates = [...presetsInList, ...rest];
    }

    setStatusBadge('checking');
    let selectedCandidate: string | null = null;
    let lastError = '';

    for (const candidate of candidates) {
      try {
        const clean = candidate.trim().replace(/^models\//i, '');
        const res = await window.companion.testCloud({
          provider: cloudProvider,
          endpoint: cloudEndpoint,
          model: clean,
          apiKey: cloudApiKey.trim() || undefined,
        });
        if (res.ok) {
          selectedCandidate = clean;
          break;
        }
        lastError = res.error ?? '';
        // On 404, automatically try next candidate
        if (lastError.includes('404') || /not found/i.test(lastError)) {
          continue;
        } else {
          // If auth or network error, stop testing
          break;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (lastError.includes('404') || /not found/i.test(lastError)) {
          continue;
        }
        break;
      }
    }

    if (selectedCandidate) {
      setCloudModel(selectedCandidate);
      setStatusBadge('connected');
      setIsCloudError(false);
      setCloudNotice(`✓ Auto-selected and verified: ${selectedCandidate}`);
      void window.companion.saveCloudConfig({
        provider: cloudProvider,
        endpoint: cloudEndpoint,
        model: selectedCandidate,
        apiKey: cloudApiKey.trim() || undefined,
      });
    } else {
      const fallback = candidates[0] || modelsList[0];
      setCloudModel(fallback);
      setStatusBadge('unavailable');
      setIsCloudError(true);
      setCloudNotice(lastError || `Model "${fallback}" unavailable.`);
    }
  };

  const handleFetchModels = async (
    overrideProvider?: CloudProviderId,
    overrideEndpoint?: string,
    overrideKey?: string,
  ) => {
    if (!window.companion) return;
    const p = overrideProvider ?? cloudProvider;
    const ep = overrideEndpoint ?? cloudEndpoint;
    const key = overrideKey ?? (cloudApiKey.trim() || undefined);

    setFetchingModels(true);
    setStatusBadge('checking');
    setCloudNotice('');
    setIsCloudError(false);

    try {
      const result = await window.companion.fetchCloudModels({
        provider: p,
        endpoint: ep,
        apiKey: key,
      });
      if (result.ok && result.models && result.models.length > 0) {
        setDetectedModels(result.models);
        await autoSelectAndTest(result.models);
      } else {
        setStatusBadge('unavailable');
        setIsCloudError(true);
        setCloudNotice(result.error ?? 'Could not detect models. Check your API key.');
      }
    } catch (err) {
      setStatusBadge('unavailable');
      setIsCloudError(true);
      setCloudNotice(err instanceof Error ? err.message : 'Failed to reach models API.');
    } finally {
      setFetchingModels(false);
    }
  };

  const handleApiKeyChange = async (val: string) => {
    setCloudApiKey(val);
    const cleanKey = val.trim();
    if (cleanKey.length >= 8) {
      try {
        const detected = await window.companion?.detectProvider(cleanKey);
        if (detected?.ok && detected.provider) {
          const newProvider = detected.provider;
          const newEndpoint = CLOUD_PRESETS[newProvider].endpoint;
          setCloudProvider(newProvider);
          setCloudEndpoint(newEndpoint);
          setCloudNotice(`Detected provider: ${CLOUD_PRESETS[newProvider].label}`);
          setIsCloudError(false);
          // Run auto-detect automatically right after valid API key is detected
          void handleFetchModels(newProvider, newEndpoint, cleanKey);
        }
      } catch {
        // ignore
      }
    }
  };

  const handleSaveCloud = async () => {
    if (!window.companion) return;
    setSavingCloud(true);
    setStatusBadge('checking');
    setCloudNotice('');
    setIsCloudError(false);
    const cleanModel = cloudProvider === 'gemini' ? cloudModel.trim().replace(/^models\//i, '') : cloudModel.trim();
    setCloudModel(cleanModel);
    try {
      const result = await window.companion.saveCloudConfig({
        provider: cloudProvider,
        endpoint: cloudEndpoint,
        model: cleanModel,
        apiKey: cloudApiKey.trim() || undefined,
      });
      if (result.ok) {
        setStatusBadge('connected');
        setCloudNotice(result.notice ?? 'Connected successfully! Cloud provider is ready.');
        setIsCloudError(false);
        const savedKey = cloudApiKey.trim();
        setCloudApiKey('');
        // Run auto-detect automatically right after valid API key is saved
        void handleFetchModels(cloudProvider, cloudEndpoint, savedKey || undefined);
      } else {
        setStatusBadge('unavailable');
        setIsCloudError(true);
        setCloudNotice(result.error ?? 'Failed to connect to Cloud API.');
      }
    } catch {
      setStatusBadge('unavailable');
      setIsCloudError(true);
      setCloudNotice('Could not save cloud configuration. Check endpoint and connection.');
    } finally {
      setSavingCloud(false);
    }
  };

  const handleSelectModel = (model: string) => {
    setCloudModel(model);
    setUserPicked(true);
    setIsDropdownOpen(false);
    setSearchQuery('');
    void testCandidateModel(model);
  };

  const handleAutoSelectAgain = () => {
    setUserPicked(false);
    const list = detectedModels.length > 0
      ? detectedModels
      : (CLOUD_PRESETS[cloudProvider]?.models ?? []);
    void autoSelectAndTest(list, true);
  };

  const handleTryAnotherModel = async () => {
    const list = detectedModels.length > 0
      ? detectedModels
      : (CLOUD_PRESETS[cloudProvider]?.models ?? []);
    if (list.length === 0) return;
    const currentIndex = list.indexOf(cloudModel);
    const nextIndex = (currentIndex + 1) % list.length;
    const nextModel = list[nextIndex];
    setCloudModel(nextModel);
    setUserPicked(true);
    await testCandidateModel(nextModel);
  };

  // Group models into Recommended and Other
  const allAvailableModels = detectedModels.length > 0
    ? detectedModels
    : (CLOUD_PRESETS[cloudProvider]?.models ?? []);

  let recommendedList: string[] = [];
  let otherList: string[] = [];

  if (cloudProvider === 'gemini') {
    recommendedList = allAvailableModels.filter(m => GEMINI_PREFERRED_MODELS.includes(m)).slice(0, 4);
    if (recommendedList.length === 0) {
      recommendedList = allAvailableModels.slice(0, 3);
      otherList = allAvailableModels.slice(3);
    } else {
      otherList = allAvailableModels.filter(m => !recommendedList.includes(m));
    }
  } else {
    const topCount = Math.min(3, allAvailableModels.length);
    recommendedList = allAvailableModels.slice(0, topCount);
    otherList = allAvailableModels.slice(topCount);
  }

  const cleanFilter = searchQuery.trim().toLowerCase();
  const filteredRecommended = cleanFilter
    ? recommendedList.filter(m => m.toLowerCase().includes(cleanFilter))
    : recommendedList;
  const filteredOther = cleanFilter
    ? otherList.filter(m => m.toLowerCase().includes(cleanFilter))
    : otherList;
  const isOtherOpen = otherExpanded || cleanFilter.length > 0;

  return (
    <section id="ai" className="settings-card ai-card scroll-reveal">
      <div className="card-heading">
        <span className="section-icon mint" aria-hidden="true">✧</span>
        <div>
          <span className="eyebrow">03 / A MIND OF HER OWN</span>
          <h2>AI Brain & Voice</h2>
        </div>
      </div>

      <div className="mode-toggle-group" role="group" aria-label="AI Mode">
        <button
          type="button"
          className={`mode-toggle-btn ${ai.mode === 'local' ? 'active' : ''}`}
          onClick={() => void handleModeChange('local')}
        >
          <span className="mode-name">Local Ollama</span>
          <span className="mode-desc">Offline · Private on your device</span>
        </button>
        <button
          type="button"
          className={`mode-toggle-btn ${ai.mode === 'cloud' ? 'active' : ''}`}
          onClick={() => void handleModeChange('cloud')}
        >
          <span className="mode-name">Cloud API</span>
          <span className="mode-badge">Fast & Natural Roman Urdu</span>
          <span className="mode-desc">Gemini, Groq, OpenAI · Zero laptop RAM</span>
        </button>
      </div>

      {ai.mode === 'local' ? (
        <div className="local-ai-section">
          <p className="ai-description">
            Replies run through a downloaded Ollama model on this computer. No internet or API keys required.
          </p>

          <div className="ai-connection">
            <span className={`presence-dot ${ai.connected ? '' : 'is-paused'}`} />
            <span role="status">{checking ? 'Checking…' : ai.connected ? 'Ollama connected' : 'Ollama is not connected'}</span>
            <button type="button" className="soft-button" disabled={checking} onClick={() => void check()}>
              Check connection
            </button>
          </div>

          <label className="ai-model-label" htmlFor="ai-model">
            Chat model <span>Saved immediately</span>
          </label>
          <select
            id="ai-model"
            value={ai.models.includes(ai.model) ? ai.model : ''}
            disabled={checking || !ai.connected || !ai.models.length}
            onChange={event => onModelDropdownChange(event.target.value)}
          >
            {!ai.models.includes(ai.model) && <option value="">Choose an installed model</option>}
            {ai.models.map(m => {
              const meta = ai.modelSizes[m];
              const badge = meta ? ` (${meta.heavy ? 'Heavy · ' : ''}${meta.sizeLabel})` : '';
              return (
                <option key={m} value={m}>
                  {m}{badge}
                </option>
              );
            })}
          </select>

          {pendingHeavyModel && (
            <div className="heavy-warning-card" role="alert">
              <div className="heavy-warning-header">
                <span className="heavy-warning-icon">⚠️</span>
                <strong>Heavy Model Warning</strong>
              </div>
              <p>
                {ai.modelSizes[pendingHeavyModel]?.warning ||
                  `⚠️ ${pendingHeavyModel} bohot heavy hai, laptop hang ho sakta hai. Fast chalane ke liye qwen2.5:0.5b ya Cloud API use karein.`}
              </p>
              <div className="heavy-warning-actions">
                <button
                  type="button"
                  className="soft-button danger"
                  onClick={() => void executeSelectModel(pendingHeavyModel)}
                >
                  Switch anyway
                </button>
                <button
                  type="button"
                  className="soft-button"
                  onClick={() => setPendingHeavyModel(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <p className="ai-description">
            Smaller models like <b>qwen2.5:0.5b</b> use very little memory and reply quickly. Models &gt; 2.2 GB (like llama3:latest) may strain laptop RAM.
          </p>
          {ai.error && <p role="alert" className="inline-error">{ai.error}</p>}
          {localNotice && <p role="status" className={isLocalError ? 'inline-error' : 'ai-notice'}>{localNotice}</p>}
        </div>
      ) : (
        <div className="cloud-ai-section">
          <p className="ai-description">
            Connect to high-speed cloud models for instant, expressive Roman Urdu and English replies with zero laptop RAM usage.
          </p>

          <label className="ai-field-label">Provider preset</label>
          <div className="provider-grid">
            {(['gemini', 'groq', 'openai', 'openrouter', 'custom'] as CloudProviderId[]).map(p => (
              <button
                key={p}
                type="button"
                className={`provider-card ${cloudProvider === p ? 'selected' : ''}`}
                onClick={() => handleProviderSelect(p)}
              >
                <span className="provider-name">{CLOUD_PRESETS[p].label}</span>
                <span className="provider-model">{CLOUD_PRESETS[p].defaultModel}</span>
              </button>
            ))}
          </div>

          <div className="cloud-fields">
            <label className="ai-field-label" htmlFor="cloud-endpoint">API Endpoint URL</label>
            <input
              id="cloud-endpoint"
              type="url"
              className="cloud-input"
              value={cloudEndpoint}
              onChange={e => setCloudEndpoint(e.target.value)}
              placeholder="https://..."
              spellCheck={false}
            />

            <div className="model-row-header">
              <label className="ai-field-label" htmlFor="cloud-model">Model name</label>
              <div className="model-row-header-actions">
                {userPicked && (
                  <button
                    type="button"
                    className="auto-select-reset-btn"
                    onClick={handleAutoSelectAgain}
                    title="Reset manual selection and auto-select recommended model"
                  >
                    🔄 Auto-select again
                  </button>
                )}
                {statusBadge !== 'idle' && (
                  <div className="status-indicator-badge">
                    {statusBadge === 'connected' && (
                      <span className="status-badge connected">
                        <span className="status-dot green" /> Connected
                      </span>
                    )}
                    {statusBadge === 'checking' && (
                      <span className="status-badge checking">
                        <span className="status-dot yellow" /> Checking...
                      </span>
                    )}
                    {statusBadge === 'unavailable' && (
                      <span className="status-badge unavailable">
                        <span className="status-dot red" /> Model unavailable
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="model-inline-row">
              <div className="searchable-dropdown-wrap" ref={dropdownRef}>
                <div className="dropdown-trigger-row">
                  <input
                    id="cloud-model"
                    type="text"
                    className="cloud-input model-input-field"
                    value={cloudModel}
                    onChange={e => {
                      setCloudModel(e.target.value);
                      setUserPicked(true);
                    }}
                    onClick={() => setIsDropdownOpen(true)}
                    placeholder="Select or enter model"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="dropdown-toggle-arrow"
                    onClick={() => setIsDropdownOpen(prev => !prev)}
                    aria-label="Toggle models menu"
                  >
                    {isDropdownOpen ? '▲' : '▼'}
                  </button>
                </div>

                {isDropdownOpen && (
                  <div className="searchable-dropdown-menu">
                    <div className="dropdown-search-box">
                      <input
                        type="text"
                        className="dropdown-search-input"
                        placeholder="Search models..."
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        autoFocus
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          className="dropdown-search-clear"
                          onClick={() => setSearchQuery('')}
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    <div className="dropdown-menu-scrollable">
                      {filteredRecommended.length > 0 && (
                        <div className="dropdown-group recommended-group">
                          <div className="dropdown-group-title">⭐ Recommended</div>
                          {filteredRecommended.map(m => (
                            <button
                              key={m}
                              type="button"
                              className={`dropdown-item ${cloudModel === m ? 'selected' : ''}`}
                              onClick={() => handleSelectModel(m)}
                            >
                              <span className="model-name">{m}</span>
                              {cloudModel === m && <span className="item-check">✓</span>}
                            </button>
                          ))}
                        </div>
                      )}

                      {otherList.length > 0 && (
                        <div className="dropdown-group other-group">
                          <button
                            type="button"
                            className="collapsible-group-header"
                            onClick={() => setOtherExpanded(prev => !prev)}
                            aria-expanded={isOtherOpen}
                          >
                            <span>Other Models ({otherList.length})</span>
                            <span className="collapsible-arrow">{isOtherOpen ? '▲' : '▼'}</span>
                          </button>
                          {isOtherOpen && (
                            <div className="collapsible-items">
                              {filteredOther.length > 0 ? (
                                filteredOther.map(m => (
                                  <button
                                    key={m}
                                    type="button"
                                    className={`dropdown-item ${cloudModel === m ? 'selected' : ''}`}
                                    onClick={() => handleSelectModel(m)}
                                  >
                                    <span className="model-name">{m}</span>
                                    {cloudModel === m && <span className="item-check">✓</span>}
                                  </button>
                                ))
                              ) : (
                                <div className="dropdown-empty-msg">No other models match "{searchQuery}"</div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {filteredRecommended.length === 0 && (!otherList.length || filteredOther.length === 0) && (
                        <div className="dropdown-empty-msg">No models match "{searchQuery}"</div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                className="detect-models-btn inline-detect-btn"
                disabled={fetchingModels || (!cloudApiKey.trim() && !ai.cloud.apiKeySet)}
                onClick={() => void handleFetchModels()}
                title="Fetch available models for this provider"
              >
                {fetchingModels ? 'Detecting…' : '🔍 Auto-Detect Models'}
              </button>
            </div>

            <label className="ai-field-label" htmlFor="cloud-key">
              API key {ai.cloud.apiKeySet && <span className="key-badge">✓ Configured ({ai.cloud.maskedKey})</span>}
            </label>
            <input
              id="cloud-key"
              type="password"
              className="cloud-input"
              value={cloudApiKey}
              onChange={e => void handleApiKeyChange(e.target.value)}
              placeholder={ai.cloud.apiKeySet ? 'Key saved — enter a new key to update' : 'Paste your API key here'}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="field-hint">
              Saved encrypted on this computer via safeStorage. Never sent to Sudo-chan servers.
            </p>
          </div>

          <div className="cloud-actions">
            <button
              type="button"
              className="primary-button"
              disabled={savingCloud || (!cloudApiKey.trim() && !ai.cloud.apiKeySet)}
              onClick={() => void handleSaveCloud()}
            >
              {savingCloud ? 'Testing connection…' : 'Save & Test connection'}
            </button>
          </div>

          {isCloudError && cloudNotice ? (
            <div className="cloud-error-card" role="alert">
              <div className="error-card-header">
                <span className="error-card-icon">⚠️</span>
                <strong className="error-card-title">Cloud Connection Error</strong>
              </div>
              <p className="error-card-message">{cloudNotice}</p>
              {(detectedModels.length > 1 || CLOUD_PRESETS[cloudProvider].models.length > 1) && (
                <div className="error-card-actions">
                  <button
                    type="button"
                    className="soft-button error-retry-btn"
                    onClick={() => void handleTryAnotherModel()}
                  >
                    Try another model
                  </button>
                </div>
              )}
            </div>
          ) : (
            cloudNotice && (
              <p role="status" className="ai-notice">
                {cloudNotice}
              </p>
            )
          )}
        </div>
      )}
    </section>
  );
}
