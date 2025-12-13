// AiAssistant.js - Global AI Chat Assistant with sleek UI
import { API_BASE_URL } from '../config.js';
import { state } from '../state.js';

let isOpen = false;
let messages = [];
let isLoading = false;
let automationState = null; // State for multi-step automation flows

const AI_SUGGESTIONS = [
    "Create an employee record",
    "Edit employee record",
    "Delete employee record",
    "How many employees are active?",
    "Show my attendance summary",
];

export function createAiAssistant() {
    // Create floating button
    const fab = document.createElement('button');
    fab.id = 'ai-fab';
    fab.className = 'ai-fab';
    fab.innerHTML = `
        <div class="ai-fab-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                <circle cx="8.5" cy="14.5" r="1.5"/>
                <circle cx="15.5" cy="14.5" r="1.5"/>
                <path d="M9 18h6"/>
            </svg>
        </div>
        <span class="ai-fab-pulse"></span>
    `;
    fab.title = 'AI Assistant';
    fab.onclick = toggleAiPanel;
    document.body.appendChild(fab);

    // Create chat panel
    const panel = document.createElement('div');
    panel.id = 'ai-panel';
    panel.className = 'ai-panel';
    panel.innerHTML = getAiPanelHTML();
    document.body.appendChild(panel);

    // Add styles
    addAiStyles();

    // Setup event listeners
    setTimeout(setupAiEvents, 100);
}

function getAiPanelHTML() {
    const suggestionsHTML = AI_SUGGESTIONS.map(s => 
        `<button class="ai-suggestion" data-question="${s}">${s}</button>`
    ).join('');

    return `
        <div class="ai-panel-header">
            <div class="ai-header-left">
                <div class="ai-avatar">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                        <circle cx="8.5" cy="14.5" r="1.5"/>
                        <circle cx="15.5" cy="14.5" r="1.5"/>
                    </svg>
                </div>
                <div class="ai-header-info">
                    <h3>HR Assistant</h3>
                    <span class="ai-status"><span class="ai-status-dot"></span>Online</span>
                </div>
            </div>
            <button class="ai-close-btn" id="ai-close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
            </button>
        </div>
        
        <div class="ai-messages" id="ai-messages">
            <div class="ai-welcome">
                <div class="ai-welcome-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                        <circle cx="8.5" cy="14.5" r="1.5"/>
                        <circle cx="15.5" cy="14.5" r="1.5"/>
                        <path d="M9 18h6"/>
                    </svg>
                </div>
                <h4>Hi! I'm your HR Assistant</h4>
                <p>Ask me anything about attendance, leaves, employees, or HR data.</p>
                <div class="ai-suggestions">
                    ${suggestionsHTML}
                </div>
            </div>
        </div>
        
        <div class="ai-input-container">
            <div class="ai-input-wrapper">
                <button id="ai-voice" class="ai-voice-btn" title="Voice input">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="23"/>
                        <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                </button>
                <input type="text" id="ai-input" placeholder="Ask me anything..." autocomplete="off">
                <button id="ai-send" class="ai-send-btn" disabled>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
                    </svg>
                </button>
            </div>
            <p class="ai-powered">Powered by Gemini AI</p>
        </div>
    `;
}

function toggleAiPanel() {
    isOpen = !isOpen;
    const panel = document.getElementById('ai-panel');
    const fab = document.getElementById('ai-fab');
    
    if (isOpen) {
        panel.classList.add('open');
        fab.classList.add('active');
        document.getElementById('ai-input')?.focus();
    } else {
        panel.classList.remove('open');
        fab.classList.remove('active');
    }
}

// Voice recognition state
let isListening = false;
let recognition = null;

function setupVoiceRecognition() {
    // Check for browser support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn('[AI] Speech recognition not supported in this browser');
        return null;
    }
    
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    
    recognition.onstart = () => {
        isListening = true;
        const voiceBtn = document.getElementById('ai-voice');
        if (voiceBtn) {
            voiceBtn.classList.add('listening');
            voiceBtn.title = 'Listening... Click to stop';
        }
        console.log('[AI] Voice recognition started');
    };
    
    recognition.onend = () => {
        isListening = false;
        const voiceBtn = document.getElementById('ai-voice');
        if (voiceBtn) {
            voiceBtn.classList.remove('listening');
            voiceBtn.title = 'Voice input';
        }
        console.log('[AI] Voice recognition ended');
    };
    
    recognition.onresult = (event) => {
        const input = document.getElementById('ai-input');
        const sendBtn = document.getElementById('ai-send');
        
        let finalTranscript = '';
        let interimTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }
        
        // Update input with transcript
        if (input) {
            if (finalTranscript) {
                input.value = finalTranscript;
                if (sendBtn) sendBtn.disabled = false;
                // Auto-send after final result
                setTimeout(() => {
                    if (input.value.trim()) {
                        sendMessage(input.value.trim());
                    }
                }, 500);
            } else if (interimTranscript) {
                input.value = interimTranscript;
                input.placeholder = 'Listening...';
            }
        }
    };
    
    recognition.onerror = (event) => {
        console.error('[AI] Voice recognition error:', event.error);
        isListening = false;
        const voiceBtn = document.getElementById('ai-voice');
        if (voiceBtn) {
            voiceBtn.classList.remove('listening');
            voiceBtn.title = 'Voice input';
        }
        
        // Show error message for permission denied
        if (event.error === 'not-allowed') {
            alert('Microphone access denied. Please allow microphone access to use voice input.');
        }
    };
    
    return recognition;
}

function toggleVoiceInput() {
    if (!recognition) {
        recognition = setupVoiceRecognition();
    }
    
    if (!recognition) {
        alert('Voice input is not supported in your browser. Please use Chrome or Edge.');
        return;
    }
    
    if (isListening) {
        recognition.stop();
    } else {
        const input = document.getElementById('ai-input');
        if (input) {
            input.value = '';
            input.placeholder = 'Listening...';
        }
        try {
            recognition.start();
        } catch (e) {
            console.error('[AI] Failed to start voice recognition:', e);
        }
    }
}

function setupAiEvents() {
    const closeBtn = document.getElementById('ai-close');
    const input = document.getElementById('ai-input');
    const sendBtn = document.getElementById('ai-send');
    const voiceBtn = document.getElementById('ai-voice');
    
    if (closeBtn) closeBtn.addEventListener('click', toggleAiPanel);
    
    if (input) {
        input.addEventListener('input', () => {
            if (sendBtn) sendBtn.disabled = !input.value.trim();
        });
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && input.value.trim()) {
                e.preventDefault();
                sendMessage(input.value.trim());
            }
        });
    }
    
    if (sendBtn) {
        sendBtn.addEventListener('click', () => {
            if (input && input.value.trim()) {
                sendMessage(input.value.trim());
            }
        });
    }
    
    // Voice input button
    if (voiceBtn) {
        voiceBtn.addEventListener('click', toggleVoiceInput);
    }
    
    // Suggestion clicks
    document.querySelectorAll('.ai-suggestion').forEach(btn => {
        btn.addEventListener('click', () => {
            sendMessage(btn.dataset.question || '');
        });
    });
}

async function sendMessage(question) {
    if (isLoading) return;
    
    const input = document.getElementById('ai-input');
    const messagesContainer = document.getElementById('ai-messages');
    
    // Clear welcome if first message
    const welcome = messagesContainer?.querySelector('.ai-welcome');
    if (welcome) welcome.remove();
    
    // Add user message
    messages.push({ role: 'user', text: question });
    appendMessage('user', question);
    
    // Clear input
    if (input) {
        input.value = '';
        const sendBtn = document.getElementById('ai-send');
        if (sendBtn) sendBtn.disabled = true;
    }
    
    // Show loading
    isLoading = true;
    const loadingId = appendLoading();
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/ai/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question,
                currentUser: state.user || {},
                history: messages.slice(-10),
                automationState: automationState // Pass automation state for multi-step flows
            })
        });
        
        const data = await response.json();
        
        // Remove loading
        removeLoading(loadingId);
        
        if (data.success && data.answer) {
            messages.push({ role: 'assistant', text: data.answer });
            appendMessage('assistant', data.answer);
            
            // Update automation state for multi-step flows
            if (data.automationState) {
                automationState = data.automationState;
            }
            
            // If an action was executed (e.g., employee created), show success indicator
            if (data.actionResult) {
                console.log('[AI] Action result received:', data.actionResult);
                await showActionSuccess(data.actionResult);
            }
        } else {
            appendMessage('assistant', data.error || 'Sorry, I encountered an error. Please try again.');
        }
    } catch (error) {
        removeLoading(loadingId);
        appendMessage('assistant', 'Unable to connect to AI service. Please check your connection.');
        console.error('AI Error:', error);
    } finally {
        isLoading = false;
    }
}

async function showActionSuccess(actionResult) {
    // Show a brief toast/notification for successful actions
    if (actionResult.employee_id) {
        console.log(`[AI] Employee action completed: ${actionResult.employee_id}`);
        
        // Trigger a page refresh to show updated data
        // Works for both create and update actions
        setTimeout(() => {
            // If on employees page, refresh it
            if (window.location.hash === '#/employees' || window.location.hash.startsWith('#/employees')) {
                window.dispatchEvent(new HashChangeEvent('hashchange'));
            }
            
            // Dispatch a custom event that other components can listen to
            window.dispatchEvent(new CustomEvent('employeeDataChanged', {
                detail: { employee_id: actionResult.employee_id, action: actionResult.message }
            }));
        }, 500);
    }
    
    // Handle check-in action - update the timer button UI
    if (actionResult.checkin_time) {
        console.log(`[AI] Check-in completed at: ${actionResult.checkin_time}`);
        
        try {
            // Import timer functions and state
            const { updateTimerButton, updateTimerDisplay } = await import('../features/timer.js');
            
            // Update state to reflect check-in
            state.timer.isRunning = true;
            state.timer.startTime = Date.now();
            
            // If there's existing time from today, adjust the start time
            if (actionResult.total_seconds_today) {
                state.timer.startTime = Date.now() - (actionResult.total_seconds_today * 1000);
            }
            
            // Start the timer interval
            if (state.timer.intervalId) {
                clearInterval(state.timer.intervalId);
            }
            state.timer.intervalId = setInterval(updateTimerDisplay, 1000);
            
            // Save to localStorage
            localStorage.setItem('timerState', JSON.stringify({ 
                isRunning: true, 
                startTime: state.timer.startTime 
            }));
            
            // Update the button UI
            updateTimerButton();
            updateTimerDisplay();
            
            console.log('[AI] Timer button updated to CHECK OUT state');
        } catch (err) {
            console.error('[AI] Failed to update timer button:', err);
        }
    }
    
    // Handle check-out action - update the timer button UI
    if (actionResult.checkout_time) {
        console.log(`[AI] Check-out completed at: ${actionResult.checkout_time}`);
        
        try {
            // Import timer functions
            const { updateTimerButton, updateTimerDisplay } = await import('../features/timer.js');
            
            // Stop the timer
            if (state.timer.intervalId) {
                clearInterval(state.timer.intervalId);
            }
            state.timer.isRunning = false;
            state.timer.intervalId = null;
            state.timer.startTime = null;
            
            // Clear localStorage
            localStorage.removeItem('timerState');
            
            // Update the button UI
            updateTimerButton();
            updateTimerDisplay();
            
            console.log('[AI] Timer button updated to CHECK IN state');
            
            // Refresh attendance page if on it
            if (window.location.hash.includes('attendance')) {
                window.dispatchEvent(new HashChangeEvent('hashchange'));
            }
        } catch (err) {
            console.error('[AI] Failed to update timer button:', err);
        }
    }
    
    // Handle asset creation
    if (actionResult.asset_id) {
        console.log(`[AI] Asset created: ${actionResult.asset_id}`);
        
        // Refresh assets page if on it
        setTimeout(() => {
            if (window.location.hash.includes('assets')) {
                window.dispatchEvent(new HashChangeEvent('hashchange'));
            }
        }, 500);
    }
}

function appendMessage(role, text) {
    const container = document.getElementById('ai-messages');
    if (!container) return;
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `ai-message ai-message-${role}`;
    
    // Format text with markdown-like styling
    const formattedText = formatAiText(text);
    
    msgDiv.innerHTML = `
        <div class="ai-message-content">
            ${role === 'assistant' ? '<div class="ai-message-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/><circle cx="8.5" cy="14.5" r="1.5"/><circle cx="15.5" cy="14.5" r="1.5"/></svg></div>' : ''}
            <div class="ai-message-text">${formattedText}</div>
        </div>
    `;
    
    container.appendChild(msgDiv);
    container.scrollTop = container.scrollHeight;
}

function formatAiText(text) {
    // Convert markdown-like formatting
    return text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
}

function appendLoading() {
    const container = document.getElementById('ai-messages');
    if (!container) return '';
    
    const id = 'loading-' + Date.now();
    const loadingDiv = document.createElement('div');
    loadingDiv.id = id;
    loadingDiv.className = 'ai-message ai-message-assistant ai-loading';
    loadingDiv.innerHTML = `
        <div class="ai-message-content">
            <div class="ai-message-avatar">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                    <circle cx="8.5" cy="14.5" r="1.5"/>
                    <circle cx="15.5" cy="14.5" r="1.5"/>
                </svg>
            </div>
            <div class="ai-typing">
                <span></span><span></span><span></span>
            </div>
        </div>
    `;
    container.appendChild(loadingDiv);
    container.scrollTop = container.scrollHeight;
    return id;
}

function removeLoading(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function addAiStyles() {
    if (document.getElementById('ai-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'ai-styles';
    style.textContent = `
        /* AI Floating Action Button */
        .ai-fab {
            position: fixed;
            bottom: 24px;
            right: 24px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border: none;
            cursor: pointer;
            box-shadow: 0 4px 20px rgba(102, 126, 234, 0.4);
            z-index: 9998;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .ai-fab:hover {
            transform: scale(1.1);
            box-shadow: 0 6px 30px rgba(102, 126, 234, 0.6);
        }
        
        .ai-fab.active {
            transform: rotate(180deg);
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
        }
        
        .ai-fab-icon {
            width: 28px;
            height: 28px;
            color: white;
        }
        
        .ai-fab-icon svg {
            width: 100%;
            height: 100%;
        }
        
        .ai-fab-pulse {
            position: absolute;
            width: 100%;
            height: 100%;
            border-radius: 50%;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            animation: pulse 2s infinite;
            z-index: -1;
        }
        
        @keyframes pulse {
            0% { transform: scale(1); opacity: 0.5; }
            50% { transform: scale(1.3); opacity: 0; }
            100% { transform: scale(1); opacity: 0; }
        }
        
        /* AI Panel */
        .ai-panel {
            position: fixed;
            bottom: 100px;
            right: 24px;
            width: 400px;
            max-width: calc(100vw - 48px);
            height: 600px;
            max-height: calc(100vh - 150px);
            background: var(--card-bg, #ffffff);
            border-radius: 20px;
            box-shadow: 0 10px 60px rgba(0, 0, 0, 0.15);
            z-index: 9999;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            opacity: 0;
            visibility: hidden;
            transform: translateY(20px) scale(0.95);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .ai-panel.open {
            opacity: 1;
            visibility: visible;
            transform: translateY(0) scale(1);
        }
        
        /* Header */
        .ai-panel-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        
        .ai-header-left {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .ai-avatar {
            width: 40px;
            height: 40px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .ai-avatar svg {
            width: 24px;
            height: 24px;
        }
        
        .ai-header-info h3 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
        }
        
        .ai-status {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            opacity: 0.9;
        }
        
        .ai-status-dot {
            width: 8px;
            height: 8px;
            background: #4ade80;
            border-radius: 50%;
            animation: blink 2s infinite;
        }
        
        @keyframes blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .ai-close-btn {
            width: 32px;
            height: 32px;
            border: none;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            transition: background 0.2s;
        }
        
        .ai-close-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }
        
        .ai-close-btn svg {
            width: 18px;
            height: 18px;
        }
        
        /* Messages */
        .ai-messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 16px;
            background: var(--bg-secondary, #f8fafc);
        }
        
        .ai-welcome {
            text-align: center;
            padding: 30px 20px;
        }
        
        .ai-welcome-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        
        .ai-welcome-icon svg {
            width: 48px;
            height: 48px;
        }
        
        .ai-welcome h4 {
            margin: 0 0 8px;
            font-size: 18px;
            color: var(--text-primary, #1f2937);
        }
        
        .ai-welcome p {
            margin: 0 0 20px;
            color: var(--text-secondary, #6b7280);
            font-size: 14px;
        }
        
        .ai-suggestions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            justify-content: center;
        }
        
        .ai-suggestion {
            padding: 8px 14px;
            background: var(--card-bg, #ffffff);
            border: 1px solid var(--border-color, #e5e7eb);
            border-radius: 20px;
            font-size: 12px;
            color: var(--text-primary, #374151);
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .ai-suggestion:hover {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-color: transparent;
        }
        
        /* Message bubbles */
        .ai-message {
            display: flex;
            gap: 10px;
            animation: fadeIn 0.3s ease;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .ai-message-user {
            justify-content: flex-end;
        }
        
        .ai-message-content {
            display: flex;
            gap: 10px;
            max-width: 85%;
        }
        
        .ai-message-user .ai-message-content {
            flex-direction: row-reverse;
        }
        
        .ai-message-avatar {
            width: 32px;
            height: 32px;
            min-width: 32px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        
        .ai-message-avatar svg {
            width: 18px;
            height: 18px;
        }
        
        .ai-message-text {
            padding: 12px 16px;
            border-radius: 16px;
            font-size: 14px;
            line-height: 1.5;
        }
        
        .ai-message-user .ai-message-text {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-bottom-right-radius: 4px;
        }
        
        .ai-message-assistant .ai-message-text {
            background: var(--card-bg, #ffffff);
            color: var(--text-primary, #374151);
            border: 1px solid var(--border-color, #e5e7eb);
            border-bottom-left-radius: 4px;
        }
        
        .ai-message-text code {
            background: rgba(0, 0, 0, 0.1);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 13px;
        }
        
        .ai-message-text ul {
            margin: 8px 0;
            padding-left: 20px;
        }
        
        .ai-message-text li {
            margin: 4px 0;
        }
        
        /* Typing indicator */
        .ai-typing {
            display: flex;
            gap: 4px;
            padding: 16px;
        }
        
        .ai-typing span {
            width: 8px;
            height: 8px;
            background: #667eea;
            border-radius: 50%;
            animation: typing 1.4s infinite;
        }
        
        .ai-typing span:nth-child(2) { animation-delay: 0.2s; }
        .ai-typing span:nth-child(3) { animation-delay: 0.4s; }
        
        @keyframes typing {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
            30% { transform: translateY(-8px); opacity: 1; }
        }
        
        /* Input */
        .ai-input-container {
            padding: 16px 20px;
            background: var(--card-bg, #ffffff);
            border-top: 1px solid var(--border-color, #e5e7eb);
        }
        
        .ai-input-wrapper {
            display: flex;
            gap: 10px;
            background: var(--bg-secondary, #f3f4f6);
            border-radius: 12px;
            padding: 4px;
        }
        
        #ai-input {
            flex: 1;
            border: none;
            background: transparent;
            padding: 12px 16px;
            font-size: 14px;
            color: var(--text-primary, #374151);
            outline: none;
        }
        
        #ai-input::placeholder {
            color: var(--text-secondary, #9ca3af);
        }
        
        .ai-send-btn {
            width: 44px;
            height: 44px;
            border: none;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 10px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            transition: all 0.2s;
        }
        
        .ai-send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .ai-send-btn:not(:disabled):hover {
            transform: scale(1.05);
        }
        
        .ai-send-btn svg {
            width: 20px;
            height: 20px;
        }
        
        /* Voice button */
        .ai-voice-btn {
            width: 44px;
            height: 44px;
            border: none;
            background: transparent;
            border-radius: 10px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-secondary, #6b7280);
            transition: all 0.2s;
        }
        
        .ai-voice-btn:hover {
            background: rgba(102, 126, 234, 0.1);
            color: #667eea;
        }
        
        .ai-voice-btn.listening {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            color: white;
            animation: pulse-voice 1.5s infinite;
        }
        
        .ai-voice-btn svg {
            width: 20px;
            height: 20px;
        }
        
        @keyframes pulse-voice {
            0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
            50% { transform: scale(1.05); box-shadow: 0 0 0 8px rgba(239, 68, 68, 0); }
        }
        
        .ai-powered {
            text-align: center;
            font-size: 11px;
            color: var(--text-secondary, #9ca3af);
            margin: 10px 0 0;
        }
        
        /* Dark theme support */
        .dark-theme .ai-panel {
            background: #1f2937;
        }
        
        .dark-theme .ai-messages {
            background: #111827;
        }
        
        .dark-theme .ai-message-assistant .ai-message-text {
            background: #374151;
            border-color: #4b5563;
        }
        
        .dark-theme .ai-input-container {
            background: #1f2937;
            border-color: #374151;
        }
        
        .dark-theme .ai-input-wrapper {
            background: #374151;
        }
        
        .dark-theme #ai-input {
            color: #f3f4f6;
        }
        
        .dark-theme .ai-suggestion {
            background: #374151;
            border-color: #4b5563;
            color: #e5e7eb;
        }
        
        /* Mobile responsive */
        @media (max-width: 480px) {
            .ai-panel {
                right: 12px;
                left: 12px;
                bottom: 90px;
                width: auto;
                max-width: none;
                height: calc(100vh - 120px);
            }
            
            .ai-fab {
                right: 16px;
                bottom: 16px;
                width: 56px;
                height: 56px;
            }
        }
    `;
    document.head.appendChild(style);
}

export function initAiAssistant() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createAiAssistant);
    } else {
        createAiAssistant();
    }
}
