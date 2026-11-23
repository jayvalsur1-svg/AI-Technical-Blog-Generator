/**
 * BLOG STUDIO — Application Client
 * Strictly preserves backend API contracts, request payloads, and job polling.
 */

(() => {
  'use strict';

  // --- State Management ---
  let activeJobId = null;
  let activeJobTopic = "";
  let currentMarkdown = "";
  let pollTimer = null;
  let generationTimer = null;
  let generationStartTime = 0;
  let isGenerating = false;

  const STORAGE_KEY = 'blog_studio_recent_articles_v1';
  const MAX_HISTORY_ITEMS = 12;

  // --- DOM References ---
  const $ = (id) => document.getElementById(id);

  const els = {
    // Shell & Sidebar
    appShell: $('appShell'),
    sidebar: $('sidebar'),
    sidebarBackdrop: $('sidebarBackdrop'),
    sidebarCollapseBtn: $('sidebarCollapseBtn'),
    mobileMenuBtn: $('mobileMenuBtn'),
    newArticleBtn: $('newArticleBtn'),
    recentArticlesList: $('recentArticlesList'),
    clearHistoryBtn: $('clearHistoryBtn'),

    // System Status
    connectionText: $('connectionText'),
    statusPulseDot: $('statusPulseDot'),
    providerLabel: $('providerLabel'),
    researchBadge: $('researchBadge'),
    topPulseDot: $('topPulseDot'),
    topStatusText: $('topStatusText'),
    serverPill: $('serverPill'),
    workersInfo: $('workersInfo'),
    researchProviderTag: $('researchProviderTag'),

    // Input & Configuration
    topic: $('topic'),
    charCount: $('charCount'),
    clearTopicBtn: $('clearTopicBtn'),
    research: $('research'),
    researchDesc: $('researchDesc'),
    generateBtn: $('generateBtn'),
    generateBtnText: $('generateBtnText'),
    btnIcon: $('btnIcon'),
    btnSpinner: $('btnSpinner'),
    errorBanner: $('errorBanner'),
    errorBannerText: $('errorBannerText'),
    dismissErrorBtn: $('dismissErrorBtn'),

    // Pipeline
    pipelineCard: $('pipelineCard'),
    pipelineTimerWrap: $('pipelineTimerWrap'),
    elapsedTime: $('elapsedTime'),
    progressBar: $('progressBar'),
    progressPct: $('progressPct'),
    progressText: $('progressText'),

    // Document & Output
    documentCard: $('documentCard'),
    tabPreview: $('tabPreview'),
    tabSource: $('tabSource'),
    readingStatsPill: $('readingStatsPill'),
    readingTime: $('readingTime'),
    wordCount: $('wordCount'),
    copyBtn: $('copyBtn'),
    copyBtnText: $('copyBtnText'),
    downloadBtn: $('downloadBtn'),
    fullscreenBtn: $('fullscreenBtn'),
    emptyState: $('emptyState'),
    renderedOutput: $('renderedOutput'),
    sourceOutput: $('sourceOutput'),
    sourceTextarea: $('sourceTextarea'),
    selectAllSourceBtn: $('selectAllSourceBtn'),

    // Fullscreen Overlay
    fullscreenOverlay: $('fullscreenOverlay'),
    fsArticleTitle: $('fsArticleTitle'),
    fsStats: $('fsStats'),
    fsCopyBtn: $('fsCopyBtn'),
    fsDownloadBtn: $('fsDownloadBtn'),
    exitFullscreenBtn: $('exitFullscreenBtn'),
    fsRenderedContent: $('fsRenderedContent'),

    // Toasts
    toastContainer: $('toastContainer'),
  };

  // --- Toast Notifications System ---
  function showToast(message, type = 'info') {
    if (!els.toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;

    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>`;
    } else {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="16" y2="12"/><line x1="12" x2="12.01" y1="8" y2="8"/></svg>`;
    }

    toast.innerHTML = `
      <span class="toast-icon">${iconSvg}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
    `;

    els.toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 3200);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- Reading Statistics Helper ---
  function computeStats(markdown) {
    if (!markdown) return { words: 0, readTime: 0, chars: 0 };
    const plainText = markdown
      .replace(/```[\s\S]*?```/g, '') // remove code blocks for cleaner count
      .replace(/[#*`_~\[\]()>-]/g, ' ')
      .trim();
    const words = plainText ? plainText.split(/\s+/).filter(Boolean).length : 0;
    const chars = markdown.length;
    const readTime = Math.max(1, Math.ceil(words / 220));
    return { words, readTime, chars };
  }

  function updateReadingStatsUI(markdown) {
    const { words, readTime } = computeStats(markdown);
    if (words > 0) {
      els.readingTime.textContent = `${readTime} min read`;
      els.wordCount.textContent = `${words.toLocaleString()} words`;
      els.readingStatsPill.style.display = 'flex';
      els.fsStats.textContent = `${words.toLocaleString()} words · ${readTime} min read`;
    } else {
      els.readingStatsPill.style.display = 'none';
    }
  }

  // --- Markdown Parser, Sanitizer & DOM Enhancer ---
  function enhanceContainerDOM(container) {
    if (!container) return;

    // 1. External Links security
    container.querySelectorAll('a').forEach(link => {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    });

    // 2. Wrap tables in responsive horizontal scroll containers
    container.querySelectorAll('table').forEach(table => {
      if (table.parentElement && table.parentElement.classList.contains('table-scroll-container')) {
        return; // already wrapped
      }
      const scrollWrapper = document.createElement('div');
      scrollWrapper.className = 'table-scroll-container';
      table.parentNode.insertBefore(scrollWrapper, table);
      scrollWrapper.appendChild(table);
    });

    // 3. Enhance Code Blocks with Language Badges, Highlighting & Copy Button
    container.querySelectorAll('pre').forEach(pre => {
      if (pre.parentElement && pre.parentElement.classList.contains('code-block-wrapper')) {
        return; // already wrapped
      }

      const code = pre.querySelector('code');
      const langClass = code ? Array.from(code.classList).find(c => c.startsWith('language-')) : '';
      const lang = langClass ? langClass.replace('language-', '') : 'text';

      // Apply highlight.js if available
      if (code && typeof window.hljs !== 'undefined') {
        try {
          hljs.highlightElement(code);
        } catch (e) {
          // ignore highlight error and leave text intact
        }
      }

      // Create code block wrapper
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      const header = document.createElement('div');
      header.className = 'code-block-header';
      header.innerHTML = `
        <span class="code-lang-label">${escapeHtml(lang)}</span>
        <button type="button" class="btn-code-copy" title="Copy code snippet">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          <span>Copy</span>
        </button>
      `;

      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
    });
  }

  function renderMarkdownHtml(markdown) {
    if (!markdown) return '';

    // If marked or DOMPurify are unavailable, safe escape fallback
    if (typeof window.marked === 'undefined' || typeof window.DOMPurify === 'undefined') {
      return `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(markdown)}</pre>`;
    }

    // Configure marked options
    try {
      if (typeof marked.use === 'function') {
        marked.use({ gfm: true, breaks: false });
      } else if (typeof marked.setOptions === 'function') {
        marked.setOptions({ gfm: true, breaks: false });
      }
    } catch {}

    const rawHtml = marked.parse(markdown);

    // Strict DOMPurify Sanitization with attribute allowances
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel', 'class', 'type', 'checked', 'disabled'],
      ADD_TAGS: ['input'],
    });
  }

  function displayMarkdown(markdown) {
    currentMarkdown = markdown || "";

    if (!currentMarkdown.trim()) {
      els.emptyState.style.display = 'flex';
      els.renderedOutput.style.display = 'none';
      els.sourceOutput.style.display = 'none';
      els.copyBtn.disabled = true;
      els.downloadBtn.disabled = true;
      els.fullscreenBtn.disabled = true;
      updateReadingStatsUI("");
      return;
    }

    // Hide empty state
    els.emptyState.style.display = 'none';

    // Parse sanitized HTML
    const cleanHtml = renderMarkdownHtml(currentMarkdown);

    // Render Preview
    els.renderedOutput.innerHTML = cleanHtml;
    enhanceContainerDOM(els.renderedOutput);

    // Render Fullscreen Preview
    els.fsRenderedContent.innerHTML = cleanHtml;
    enhanceContainerDOM(els.fsRenderedContent);

    // Fill raw source
    els.sourceTextarea.value = currentMarkdown;

    // Determine active tab
    const isSourceActive = els.tabSource.classList.contains('active');
    els.renderedOutput.style.display = isSourceActive ? 'none' : 'block';
    els.sourceOutput.style.display = isSourceActive ? 'flex' : 'none';

    // Enable toolbar buttons
    els.copyBtn.disabled = false;
    els.downloadBtn.disabled = false;
    els.fullscreenBtn.disabled = false;

    // Extract title for fullscreen display
    const firstH1 = currentMarkdown.match(/^#\s+(.+)$/m);
    const titleText = firstH1 ? firstH1[1] : (activeJobTopic || "Generated Technical Article");
    els.fsArticleTitle.textContent = titleText;

    // Update word count & stats
    updateReadingStatsUI(currentMarkdown);
  }

  // --- Pipeline UI Controls ---
  const STAGES = ['router', 'research', 'planner', 'worker', 'reducer'];

  const STAGE_LABELS = {
    router: 'Routing request & analyzing topic',
    research: 'Researching live sources & citations',
    planner: 'Creating comprehensive article outline',
    worker: 'Writing deep-dive technical sections',
    reducer: 'Assembling and formatting final Markdown',
  };

  function resetPipeline() {
    STAGES.forEach((stage, idx) => {
      const stageEl = $(`stage-${stage}`);
      const badgeEl = $(`badge-${stage}`);
      if (stageEl) {
        stageEl.classList.remove('running', 'completed', 'failed');
        const iconWrap = stageEl.querySelector('.stage-state-icon');
        if (iconWrap) {
          iconWrap.className = 'stage-state-icon state-waiting';
          iconWrap.innerHTML = `<span class="stage-num-label">${idx + 1}</span>`;
        }
      }
      if (badgeEl) {
        badgeEl.textContent = 'WAITING';
      }
    });
    setProgress(0, 'Ready when you are');
  }

  function activateStage(activeStageName) {
    const activeIdx = STAGES.indexOf(activeStageName);
    if (activeIdx < 0) return;

    STAGES.forEach((stage, idx) => {
      const stageEl = $(`stage-${stage}`);
      const badgeEl = $(`badge-${stage}`);
      if (!stageEl) return;

      const iconWrap = stageEl.querySelector('.stage-state-icon');

      if (idx < activeIdx) {
        // Completed previous stages
        stageEl.classList.remove('running', 'failed');
        stageEl.classList.add('completed');
        if (badgeEl) badgeEl.textContent = 'DONE';
        if (iconWrap) {
          iconWrap.className = 'stage-state-icon';
          iconWrap.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        }
      } else if (idx === activeIdx) {
        // Active stage
        stageEl.classList.remove('completed', 'failed');
        stageEl.classList.add('running');
        if (badgeEl) badgeEl.textContent = 'RUNNING';
        if (iconWrap) {
          iconWrap.className = 'stage-state-icon';
          iconWrap.innerHTML = `<span class="btn-spinner" style="width:11px;height:11px;border-width:2px;"></span>`;
        }
      } else {
        // Waiting stage
        stageEl.classList.remove('running', 'completed', 'failed');
        if (badgeEl) badgeEl.textContent = 'WAITING';
        if (iconWrap) {
          iconWrap.className = 'stage-state-icon state-waiting';
          iconWrap.innerHTML = `<span class="stage-num-label">${idx + 1}</span>`;
        }
      }
    });

    const progressValue = Math.min(92, Math.round(((activeIdx + 0.6) / STAGES.length) * 100));
    setProgress(progressValue, STAGE_LABELS[activeStageName] || 'Executing workflow stage');
  }

  function markAllStagesCompleted() {
    STAGES.forEach((stage) => {
      const stageEl = $(`stage-${stage}`);
      const badgeEl = $(`badge-${stage}`);
      if (!stageEl) return;

      stageEl.classList.remove('running', 'failed');
      stageEl.classList.add('completed');
      if (badgeEl) badgeEl.textContent = 'DONE';

      const iconWrap = stageEl.querySelector('.stage-state-icon');
      if (iconWrap) {
        iconWrap.className = 'stage-state-icon';
        iconWrap.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      }
    });
    setProgress(100, 'Generation completed');
  }

  function markPipelineFailed(errorMessage) {
    let markedFailure = false;
    STAGES.forEach((stage) => {
      const stageEl = $(`stage-${stage}`);
      const badgeEl = $(`badge-${stage}`);
      if (!stageEl) return;

      if (stageEl.classList.contains('running')) {
        stageEl.classList.remove('running');
        stageEl.classList.add('failed');
        if (badgeEl) badgeEl.textContent = 'FAILED';
        const iconWrap = stageEl.querySelector('.stage-state-icon');
        if (iconWrap) {
          iconWrap.className = 'stage-state-icon';
          iconWrap.innerHTML = `!`;
        }
        markedFailure = true;
      }
    });

    if (!markedFailure) {
      const firstStageEl = $(`stage-router`);
      if (firstStageEl) {
        firstStageEl.classList.add('failed');
        const badgeEl = $(`badge-router`);
        if (badgeEl) badgeEl.textContent = 'FAILED';
      }
    }

    setProgress(0, 'Generation failed');
    showErrorBanner(errorMessage || 'Generation failed. Check topic or backend configuration.');
  }

  function setProgress(percent, text) {
    els.progressBar.style.width = `${percent}%`;
    els.progressPct.textContent = `${percent}%`;
    els.progressText.textContent = text;
  }

  // --- Generation Elapsed Timer ---
  function startGenerationTimer() {
    stopGenerationTimer();
    generationStartTime = Date.now();
    els.pipelineTimerWrap.style.display = 'flex';
    els.elapsedTime.textContent = '00:00';

    generationTimer = setInterval(() => {
      const diffSecs = Math.floor((Date.now() - generationStartTime) / 1000);
      const mins = String(Math.floor(diffSecs / 60)).padStart(2, '0');
      const secs = String(diffSecs % 60).padStart(2, '0');
      els.elapsedTime.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  function stopGenerationTimer() {
    if (generationTimer) {
      clearInterval(generationTimer);
      generationTimer = null;
    }
  }

  // --- Error Banner Helper ---
  function showErrorBanner(message) {
    els.errorBannerText.textContent = message;
    els.errorBanner.style.display = 'flex';
  }

  function hideErrorBanner() {
    els.errorBanner.style.display = 'none';
  }

  // --- Backend Health Check ---
  async function checkHealth() {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error('API server returned non-OK status');
      const data = await response.json();

      // Sidebar connection card
      els.statusPulseDot.className = 'status-pulse-dot online';
      els.connectionText.textContent = 'FastAPI Backend Online';
      els.providerLabel.textContent = `${(data.provider || 'AI').toUpperCase()} · ${data.max_workers || 2} WORKERS`;

      if (data.research_configured) {
        els.researchBadge.textContent = 'Tavily Search Ready';
        els.researchBadge.className = 'status-badge status-badge-alt';
        els.researchProviderTag.textContent = 'Tavily Engine';
      } else {
        els.researchBadge.textContent = 'Research Not Configured';
        els.researchBadge.className = 'status-badge';
        els.researchProviderTag.textContent = 'Offline';
      }

      // Topbar status pill
      els.topPulseDot.style.backgroundColor = 'var(--success)';
      els.topStatusText.textContent = `${(data.provider || 'FastAPI').toUpperCase()} Ready`;
      els.workersInfo.textContent = `${data.max_workers || 2} workers · ${data.provider} model`;

    } catch (err) {
      els.statusPulseDot.className = 'status-pulse-dot offline';
      els.connectionText.textContent = 'Backend Disconnected';
      els.providerLabel.textContent = 'OFFLINE';
      els.researchBadge.textContent = 'Service Unavailable';

      els.topPulseDot.style.backgroundColor = 'var(--danger)';
      els.topStatusText.textContent = 'Disconnected';
      els.workersInfo.textContent = 'Check main.py process';
    }
  }

  // --- Generation Workflow (Preserves API Contract) ---
  async function startGeneration() {
    if (isGenerating) return;

    const topic = els.topic.value.trim();
    if (topic.length < 5) {
      showToast('Please enter a topic with at least 5 characters.', 'error');
      els.topic.focus();
      return;
    }

    hideErrorBanner();
    isGenerating = true;
    activeJobTopic = topic;

    // UI State: Generating
    els.generateBtn.disabled = true;
    els.btnSpinner.style.display = 'inline-block';
    els.btnIcon.style.display = 'none';
    els.generateBtnText.textContent = 'Orchestrating agents…';

    // Reset pipeline & output view
    resetPipeline();
    startGenerationTimer();
    setProgress(5, 'Preparing request…');
    showToast('Article generation started.', 'info');

    try {
      // POST to existing /api/generate endpoint with unchanged payload contract
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic,
          research: Boolean(els.research.checked),
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || 'Could not start generation job.');
      }

      activeJobId = data.job_id;
      pollJobStatus();

    } catch (err) {
      handleGenerationFailure(err.message);
    }
  }

  async function pollJobStatus() {
    if (!activeJobId) return;

    try {
      const response = await fetch(`/api/jobs/${activeJobId}`);
      const job = await response.json();

      if (!response.ok) {
        throw new Error(job.detail || 'Could not fetch job status.');
      }

      if (job.status === 'queued') {
        setProgress(10, 'Queued in workflow engine…');
        pollTimer = setTimeout(pollJobStatus, 1200);
        return;
      }

      if (job.status === 'running') {
        const elapsed = Date.now() - generationStartTime;
        const researchEnabled = els.research.checked;

        // Dynamic stage schedule based on research flag
        let stagesToUse = researchEnabled 
          ? ['router', 'research', 'planner', 'worker', 'reducer']
          : ['router', 'planner', 'worker', 'reducer'];

        const stageInterval = 5500; // milliseconds per stage indicator
        const stageIndex = Math.min(stagesToUse.length - 1, Math.floor(elapsed / stageInterval));
        const currentStageName = stagesToUse[stageIndex];

        activateStage(currentStageName);
        pollTimer = setTimeout(pollJobStatus, 1300);
        return;
      }

      if (job.status === 'completed') {
        finishGenerationSuccess(job);
        return;
      }

      if (job.status === 'failed') {
        throw new Error(job.error || 'Generation failed on backend.');
      }

    } catch (err) {
      handleGenerationFailure(err.message);
    }
  }

  function finishGenerationSuccess(job) {
    isGenerating = false;
    stopGenerationTimer();
    clearTimeout(pollTimer);
    pollTimer = null;

    markAllStagesCompleted();
    restoreGenerateButton();

    currentMarkdown = job.markdown || '';
    displayMarkdown(currentMarkdown);

    // Save to LocalStorage History
    saveArticleToHistory({
      id: activeJobId,
      title: extractTitle(currentMarkdown, activeJobTopic),
      topic: activeJobTopic,
      timestamp: Date.now(),
      markdown: currentMarkdown,
      filename: job.filename,
    });

    renderRecentArticles();
    showToast('Article generation completed!', 'success');

    // Scroll to document preview smoothly
    els.documentCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleGenerationFailure(errorMessage) {
    isGenerating = false;
    stopGenerationTimer();
    clearTimeout(pollTimer);
    pollTimer = null;

    restoreGenerateButton();
    markPipelineFailed(errorMessage);
    showToast(errorMessage || 'Generation failed', 'error');

    // STRICT: Preserve user's input topic so nothing is lost!
  }

  function restoreGenerateButton() {
    els.generateBtn.disabled = false;
    els.btnSpinner.style.display = 'none';
    els.btnIcon.style.display = 'inline-block';
    els.generateBtnText.textContent = 'Generate Article';
  }

  function extractTitle(markdown, fallback) {
    if (markdown) {
      const match = markdown.match(/^#\s+(.+)$/m);
      if (match && match[1]) return match[1].trim();
    }
    return fallback || 'Technical Article';
  }

  // --- Article History System (Client-Side Persistence) ---
  function getHistory() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  function saveArticleToHistory(article) {
    try {
      let history = getHistory();
      // Remove existing item with same id if any
      history = history.filter(item => item.id !== article.id);
      // Prepend newest
      history.unshift(article);
      // Limit size
      if (history.length > MAX_HISTORY_ITEMS) {
        history = history.slice(0, MAX_HISTORY_ITEMS);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
      // storage quota or disabled
    }
  }

  function deleteHistoryItem(id, e) {
    if (e) e.stopPropagation();
    try {
      let history = getHistory();
      history = history.filter(item => item.id !== id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
      renderRecentArticles();
      showToast('Article removed from recents', 'info');
    } catch {}
  }

  function clearAllHistory() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      renderRecentArticles();
      showToast('Recent articles cleared', 'info');
    } catch {}
  }

  function formatRelativeTime(timestamp) {
    const elapsedSecs = Math.floor((Date.now() - timestamp) / 1000);
    if (elapsedSecs < 60) return 'Just now';
    const mins = Math.floor(elapsedSecs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function renderRecentArticles() {
    const history = getHistory();
    if (!els.recentArticlesList) return;

    if (history.length === 0) {
      els.recentArticlesList.innerHTML = `
        <div class="recent-empty-state">
          <span class="empty-bullet">•</span>
          <span>No articles generated yet</span>
        </div>
      `;
      return;
    }

    els.recentArticlesList.innerHTML = '';
    history.forEach(item => {
      const div = document.createElement('div');
      div.className = `recent-item ${activeJobId === item.id ? 'active' : ''}`;
      div.title = item.title;
      div.innerHTML = `
        <span class="recent-title">${escapeHtml(item.title)}</span>
        <div class="recent-meta-actions">
          <span class="recent-time">${formatRelativeTime(item.timestamp)}</span>
          <button type="button" class="btn-delete-recent" title="Remove" aria-label="Remove">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
          </button>
        </div>
      `;

      // Load article on click
      div.addEventListener('click', () => {
        loadHistoryItem(item);
      });

      // Delete listener
      const delBtn = div.querySelector('.btn-delete-recent');
      delBtn.addEventListener('click', (e) => {
        deleteHistoryItem(item.id, e);
      });

      els.recentArticlesList.appendChild(div);
    });
  }

  function loadHistoryItem(item) {
    activeJobId = item.id;
    activeJobTopic = item.topic || item.title;
    displayMarkdown(item.markdown);
    renderRecentArticles();

    // Close mobile drawer if open
    closeMobileSidebar();

    // Scroll to preview
    els.documentCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    showToast(`Loaded "${item.title.slice(0, 30)}…"`, 'info');
  }

  // --- New Article / Reset Workspace ---
  function startNewArticle() {
    activeJobId = null;
    activeJobTopic = "";
    currentMarkdown = "";
    displayMarkdown("");
    resetPipeline();
    els.topic.value = "";
    updateCharCount();
    hideErrorBanner();
    renderRecentArticles();
    closeMobileSidebar();
    els.topic.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- Copy & Download Actions ---
  async function copyCurrentMarkdown(buttonEl, textSpanEl) {
    if (!currentMarkdown) return;

    try {
      await navigator.clipboard.writeText(currentMarkdown);
      showToast('Markdown copied to clipboard.', 'success');

      if (buttonEl) {
        buttonEl.classList.add('copied');
        const defaultIcon = buttonEl.querySelector('.default-icon');
        const successIcon = buttonEl.querySelector('.success-icon');
        if (defaultIcon) defaultIcon.style.display = 'none';
        if (successIcon) successIcon.style.display = 'inline-block';
        if (textSpanEl) textSpanEl.textContent = 'Copied!';

        setTimeout(() => {
          buttonEl.classList.remove('copied');
          if (defaultIcon) defaultIcon.style.display = 'inline-block';
          if (successIcon) successIcon.style.display = 'none';
          if (textSpanEl) textSpanEl.textContent = 'Copy';
        }, 2200);
      }
    } catch {
      showToast('Clipboard access was blocked by your browser.', 'error');
    }
  }

  function downloadCurrentMarkdown() {
    if (!currentMarkdown) return;

    showToast('Download initiated.', 'info');

    // If active job has a backend download URL, use existing endpoint
    if (activeJobId) {
      window.location.href = `/api/jobs/${activeJobId}/download`;
      return;
    }

    // Fallback: client-side blob download
    const blob = new Blob([currentMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeTitle = (activeJobTopic || 'technical-article')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40);
    link.href = url;
    link.download = `${safeTitle}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // --- Fullscreen Mode ---
  function openFullscreen() {
    if (!currentMarkdown) return;
    els.fullscreenOverlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closeFullscreen() {
    els.fullscreenOverlay.style.display = 'none';
    document.body.style.overflow = '';
  }

  // --- Mobile Drawer Controls ---
  function openMobileSidebar() {
    els.sidebar.classList.add('open');
    els.sidebarBackdrop.classList.add('active');
  }

  function closeMobileSidebar() {
    els.sidebar.classList.remove('open');
    els.sidebarBackdrop.classList.remove('active');
  }

  // --- Character Counter Helper ---
  function updateCharCount() {
    const len = els.topic.value.length;
    els.charCount.textContent = len;
    els.clearTopicBtn.style.display = len > 0 ? 'inline-block' : 'none';

    if (len >= 470) {
      els.charCount.className = 'char-count over-limit';
    } else if (len >= 400) {
      els.charCount.className = 'char-count near-limit';
    } else {
      els.charCount.className = 'char-count';
    }
  }

  // --- Global Event Delegation for Code Block Copy Buttons ---
  document.addEventListener('click', async (e) => {
    const copyCodeBtn = e.target.closest('.btn-code-copy');
    if (!copyCodeBtn) return;

    e.preventDefault();
    const wrapper = copyCodeBtn.closest('.code-block-wrapper');
    if (!wrapper) return;

    const pre = wrapper.querySelector('pre');
    if (!pre) return;

    const code = pre.querySelector('code');
    const codeText = code ? code.innerText : pre.innerText;

    try {
      await navigator.clipboard.writeText(codeText);
      copyCodeBtn.classList.add('copied');
      const span = copyCodeBtn.querySelector('span');
      if (span) span.textContent = 'Copied!';

      setTimeout(() => {
        copyCodeBtn.classList.remove('copied');
        if (span) span.textContent = 'Copy';
      }, 2000);
    } catch {
      showToast('Could not access clipboard', 'error');
    }
  });

  // --- Event Listeners Registration ---
  function initEventListeners() {
    // Generate Button
    els.generateBtn.addEventListener('click', startGeneration);

    // Topic Textarea interactions
    els.topic.addEventListener('input', updateCharCount);
    els.topic.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        startGeneration();
      }
    });

    els.clearTopicBtn.addEventListener('click', () => {
      els.topic.value = '';
      updateCharCount();
      els.topic.focus();
    });

    // Research Toggle
    els.research.addEventListener('change', () => {
      if (els.research.checked) {
        els.researchDesc.textContent = 'Live search for fresh technical evidence, benchmarks & verified citations.';
      } else {
        els.researchDesc.textContent = 'Closed-book generation relying solely on LLM pre-trained knowledge.';
      }
    });

    // Suggestion Chips
    document.querySelectorAll('.suggestion-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const topic = chip.getAttribute('data-topic');
        if (topic) {
          els.topic.value = topic;
          updateCharCount();
          els.topic.focus();
        }
      });
    });

    // New Article Button
    els.newArticleBtn.addEventListener('click', startNewArticle);

    // Clear History Button
    els.clearHistoryBtn.addEventListener('click', clearAllHistory);

    // Error banner dismiss
    els.dismissErrorBtn.addEventListener('click', hideErrorBanner);

    // Tabs: Preview vs Source
    els.tabPreview.addEventListener('click', () => {
      els.tabPreview.classList.add('active');
      els.tabPreview.setAttribute('aria-selected', 'true');
      els.tabSource.classList.remove('active');
      els.tabSource.setAttribute('aria-selected', 'false');
      els.renderedOutput.style.display = 'block';
      els.sourceOutput.style.display = 'none';
    });

    els.tabSource.addEventListener('click', () => {
      els.tabSource.classList.add('active');
      els.tabSource.setAttribute('aria-selected', 'true');
      els.tabPreview.classList.remove('active');
      els.tabPreview.setAttribute('aria-selected', 'false');
      els.renderedOutput.style.display = 'none';
      els.sourceOutput.style.display = 'flex';
    });

    // Source view select-all
    els.selectAllSourceBtn.addEventListener('click', () => {
      els.sourceTextarea.select();
      showToast('Raw Markdown selected', 'info');
    });

    // Copy & Download
    els.copyBtn.addEventListener('click', () => {
      copyCurrentMarkdown(els.copyBtn, els.copyBtnText);
    });

    els.downloadBtn.addEventListener('click', downloadCurrentMarkdown);

    // Fullscreen Controls
    els.fullscreenBtn.addEventListener('click', openFullscreen);
    els.exitFullscreenBtn.addEventListener('click', closeFullscreen);
    els.fsCopyBtn.addEventListener('click', () => {
      copyCurrentMarkdown(els.fsCopyBtn, null);
    });
    els.fsDownloadBtn.addEventListener('click', downloadCurrentMarkdown);

    // Global keyboard listener for ESC and shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.fullscreenOverlay.style.display === 'flex') {
        closeFullscreen();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        if (document.activeElement !== els.topic) {
          e.preventDefault();
          startNewArticle();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        els.appShell.classList.toggle('sidebar-collapsed');
      }
    });

    // Desktop Sidebar Collapse toggle
    els.sidebarCollapseBtn.addEventListener('click', () => {
      els.appShell.classList.toggle('sidebar-collapsed');
    });

    // Mobile Drawer
    els.mobileMenuBtn.addEventListener('click', openMobileSidebar);
    els.sidebarBackdrop.addEventListener('click', closeMobileSidebar);
  }

  // --- Application Initialization ---
  function init() {
    initEventListeners();
    updateCharCount();
    renderRecentArticles();
    checkHealth();

    // Periodic health poll every 25 seconds
    setInterval(checkHealth, 25000);
  }

  // Boot on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
