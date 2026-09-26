// src/modules/tools/ai.js
// Pay-per-use AI credits system (images, thinking/code, video v2)
// + Code AI (IDE) with CodeMirror 6
// Modernized UI — v2

// CodeMirror (~300 KB gzip with all languages) is loaded on demand when the
// Code tab is first opened, so chat users on slow/expensive mobile data never
// download it. Each language grammar is fetched separately when selected.
let cm = null;
let cmLoading = null;
function loadCodeMirror() {
    if (cm) return Promise.resolve(cm);
    if (!cmLoading) {
        cmLoading = Promise.all([
            import('codemirror'),
            import('@codemirror/state'),
            import('@codemirror/view'),
            import('@codemirror/commands'),
            import('@codemirror/theme-one-dark'),
        ]).then(([core, state, view, commands, theme]) => {
            cm = {
                EditorView: core.EditorView,
                basicSetup: core.basicSetup,
                EditorState: state.EditorState,
                keymap: view.keymap,
                indentWithTab: commands.indentWithTab,
                oneDark: theme.oneDark,
            };
            languageCompartment = new state.Compartment();
            languageCompartmentResult = new state.Compartment();
            return cm;
        }).catch((err) => {
            cmLoading = null; // allow retry once the connection is back
            throw err;
        });
    }
    return cmLoading;
}

const AI_STORAGE_KEY = 'kivu_doc_';
const AI_DOCS_INDEX = 'kivu_docs_index';
const CODE_HISTORY_KEY = 'kivu_code_ai_history';
const DAILY_LIMIT = 10;
const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_URL) || (typeof window !== 'undefined' && window.__SUPABASE_URL) || 'https://reuilvjrgempobqygdpl.supabase.co';

let currentDocId = null;
let containerEl = null;
let userCredits = { image: 0, video: 0, thinking: 0 };

// Code AI state
let codeEditorView = null;
let codeResultView = null;
let activeTab = 'chat';
let isProMode = false;

let languageCompartment = null;
let languageCompartmentResult = null;
let codeEditorLoading = null;

const CODE_LANGUAGES = {
    javascript: { name: 'JavaScript', ext: 'js',   lang: () => import('@codemirror/lang-javascript').then(m => m.javascript()) },
    python:     { name: 'Python',     ext: 'py',   lang: () => import('@codemirror/lang-python').then(m => m.python()) },
    html:       { name: 'HTML',       ext: 'html', lang: () => import('@codemirror/lang-html').then(m => m.html()) },
    css:        { name: 'CSS',        ext: 'css',  lang: () => import('@codemirror/lang-css').then(m => m.css()) },
    php:        { name: 'PHP',        ext: 'php',  lang: () => import('@codemirror/lang-php').then(m => m.php()) },
    cpp:        { name: 'C/C++',      ext: 'cpp',  lang: () => import('@codemirror/lang-cpp').then(m => m.cpp()) },
    java:       { name: 'Java',       ext: 'java', lang: () => import('@codemirror/lang-java').then(m => m.java()) },
    sql:        { name: 'SQL',        ext: 'sql',  lang: () => import('@codemirror/lang-sql').then(m => m.sql()) },
};

// ============================================================
// Storage helpers (unchanged)
// ============================================================

function getDocsIndex() {
    try {
        const idx = localStorage.getItem(AI_DOCS_INDEX);
        return idx ? JSON.parse(idx) : [];
    } catch (e) {
        return [];
    }
}

function updateDocsIndex(id, title) {
    const idx = getDocsIndex();
    const existing = idx.find(d => d.id === id);
    if (existing) {
        existing.title = title;
        existing.updatedAt = new Date().toISOString();
    } else {
        idx.push({ id, title, type: 'ai', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    localStorage.setItem(AI_DOCS_INDEX, JSON.stringify(idx));
}

// ============================================================
// Language detection (unchanged)
// ============================================================

function detectLanguage(text) {
    const swahiliWords = ['jambo', 'asante', 'sana', 'nzuri', 'habari', 'kwa', 'heri'];
    const rwandaWords = ['muraho', 'amamakuru', 'yego', 'oya', 'neza', 'cyane', 'rwanda'];
    
    const lowerText = text.toLowerCase();
    
    let isSwahili = swahiliWords.some(w => lowerText.includes(w));
    let isRwanda = rwandaWords.some(w => lowerText.includes(w));
    
    if (isSwahili) return 'swahili';
    if (isRwanda) return 'kinyarwanda';
    return 'english';
}

// ============================================================
// Credits system
// ============================================================

async function loadUserCredits() {
    try {
        if (window.sb && typeof window.sb.rpc === 'function') {
            const { data, error } = await window.sb.rpc('get_ai_credits');
            if (!error && data) {
                userCredits = { image: 0, video: 0, thinking: 0 };
                data.forEach(row => {
                    if (userCredits.hasOwnProperty(row.credit_type)) {
                        userCredits[row.credit_type] = row.balance;
                    }
                });
            }
        }
    } catch (e) {
        console.error('Failed to load credits:', e);
    }
    updateCreditsUI();
}

function updateCreditsUI() {
    // Header credits badge
    const el = containerEl?.querySelector('#ai-credits-display');
    if (el) {
        el.innerHTML = `<span>🖼️ ${userCredits.image}</span><span>🧠 ${userCredits.thinking}</span>`;
    }
    // Code tab credits indicator
    const codeCreditsEl = containerEl?.querySelector('#code-credits-count');
    if (codeCreditsEl) codeCreditsEl.textContent = String(userCredits.thinking);
    // Status bar credits
    const statusCredits = containerEl?.querySelector('#ide-status-credits');
    if (statusCredits) statusCredits.textContent = `🧠 ${userCredits.thinking}`;
}

// ============================================================
// Credit Shop — purchase packages via MTN MoMo
// ============================================================

function showCreditShop() {
    const PACKAGES = {
        image:    { icon: '🖼️', name: 'Images',   price: 100, unit: 'RWF/img' },
        video:    { icon: '🎥', name: 'Video',    price: 500, unit: 'RWF/vid', disabled: true },
        thinking: { icon: '🧠', name: 'Thinking', price: 50,  unit: 'RWF/msg' },
    };
    const QUANTITIES = [1, 5, 10, 50];

    // Remove existing shop modal if any
    document.getElementById('ai-credit-shop')?.remove();

    const shopHtml = `
    <div id="ai-credit-shop" class="kv-modal-overlay">
        <div class="kv-shop-card">
            <!-- Header -->
            <div class="kv-shop-header">
                <h2>🤖 AI Credits Shop</h2>
                <button id="btn-close-shop" class="kv-shop-close">✕</button>
            </div>

            <!-- Current balance -->
            <div class="kv-shop-balance">
                <div class="kv-shop-balance-label">Your Balance</div>
                <div class="kv-shop-balance-amounts">
                    <span>🖼️ ${userCredits.image}</span>
                    <span>🧠 ${userCredits.thinking}</span>
                </div>
            </div>

            <!-- Type selector -->
            <div class="kv-shop-section">
                <div class="kv-shop-section-title">Select type:</div>
                <div class="kv-shop-type-grid" id="shop-type-selector">
                    ${Object.entries(PACKAGES).map(([key, pkg]) => `
                        <button class="shop-type-btn kv-shop-type-btn" data-type="${key}" 
                            ${pkg.disabled ? 'disabled' : ''}>
                            <div class="kv-shop-type-icon">${pkg.icon}</div>
                            <div class="kv-shop-type-name">${pkg.name}</div>
                            <div class="kv-shop-type-unit">${pkg.disabled ? 'Coming soon' : pkg.unit}</div>
                        </button>
                    `).join('')}
                </div>
            </div>

            <!-- Quantity panel -->
            <div id="shop-qty-panel" class="kv-shop-section" style="display:none;">
                <div class="kv-shop-section-title">Select quantity:</div>
                <div id="shop-qty-selector" class="kv-shop-qty-grid"></div>
            </div>

            <!-- Checkout -->
            <div id="shop-checkout" class="kv-shop-checkout" style="display:none;">
                <div class="kv-shop-total-row">
                    <span>Total:</span>
                    <span id="shop-total-price" class="kv-shop-total-price">0 RWF</span>
                </div>
                <div class="kv-shop-phone-group">
                    <label class="kv-shop-phone-label">MTN MoMo Phone Number</label>
                    <input id="shop-phone" type="tel" placeholder="07X XXX XXXX" class="kv-shop-phone-input">
                </div>
                <button id="btn-shop-pay" class="kv-shop-pay-btn">
                    💳 Pay with MTN MoMo
                </button>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', shopHtml);

    let selectedType = null;
    let selectedQty = null;

    // --- Type selection ---
    document.querySelectorAll('.shop-type-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.shop-type-btn').forEach(b => {
                b.classList.remove('kv-selected');
            });
            btn.classList.add('kv-selected');
            selectedType = btn.dataset.type;
            selectedQty = null;
            _showQtyPanel(selectedType);
        });
    });

    function _showQtyPanel(type) {
        const panel = document.getElementById('shop-qty-panel');
        const selector = document.getElementById('shop-qty-selector');
        const pkg = PACKAGES[type];
        
        selector.innerHTML = QUANTITIES.map(q => `
            <button class="shop-qty-btn kv-shop-qty-btn" data-qty="${q}">
                <div class="kv-shop-qty-num">${q}</div>
                <div class="kv-shop-qty-price">${(pkg.price * q).toLocaleString()} RWF</div>
            </button>
        `).join('');

        panel.style.display = 'block';
        document.getElementById('shop-checkout').style.display = 'none';

        selector.querySelectorAll('.shop-qty-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                selector.querySelectorAll('.shop-qty-btn').forEach(b => {
                    b.classList.remove('kv-selected');
                });
                btn.classList.add('kv-selected');
                selectedQty = parseInt(btn.dataset.qty);
                _showCheckout(type, selectedQty);
            });
        });
    }

    function _showCheckout(type, qty) {
        const pkg = PACKAGES[type];
        const total = pkg.price * qty;
        document.getElementById('shop-total-price').textContent = total.toLocaleString() + ' RWF';
        document.getElementById('shop-checkout').style.display = 'block';
    }

    // --- Close ---
    document.getElementById('btn-close-shop').addEventListener('click', () => {
        document.getElementById('ai-credit-shop')?.remove();
    });
    document.getElementById('ai-credit-shop').addEventListener('click', (e) => {
        if (e.target.id === 'ai-credit-shop') {
            document.getElementById('ai-credit-shop')?.remove();
        }
    });

    // --- Pay ---
    document.getElementById('btn-shop-pay').addEventListener('click', async () => {
        if (!selectedType || !selectedQty) return;
        const phone = document.getElementById('shop-phone').value.trim();
        if (!phone || phone.replace(/\D/g, '').length < 9) {
            if (window.showToast) window.showToast('Please enter a valid phone number', true);
            return;
        }

        const pkg = PACKAGES[selectedType];
        const amount = pkg.price * selectedQty;
        const payBtn = document.getElementById('btn-shop-pay');
        payBtn.disabled = true;
        payBtn.textContent = '⏳ Processing...';

        try {
            // 1. Create purchase record in DB
            const { data: { user } } = await window.sb.auth.getUser();
            if (!user) throw new Error('Not authenticated');

            const { data: purchase, error: insertErr } = await window.sb
                .from('ai_credit_purchases')
                .insert({
                    user_id: user.id,
                    credit_type: selectedType,
                    quantity: selectedQty,
                    amount_rwf: amount,
                    phone: phone,
                })
                .select()
                .single();

            if (insertErr) throw new Error(insertErr.message);

            // 2. Call edge function to initiate MTN MoMo payment
            const { data: { session } } = await window.sb.auth.getSession();
            const token = session.access_token;

            const res = await fetch(
                `${SUPABASE_URL}/functions/v1/ai-purchase`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                        purchaseId: purchase.id,
                        phone: phone,
                    }),
                }
            );

            const result = await res.json();

            if (!res.ok || !result.success) {
                throw new Error(result.error || 'Payment initiation failed');
            }

            // 3. Success — MTN will send USSD prompt to phone
            payBtn.textContent = '✅ Check your phone!';
            payBtn.classList.add('kv-pay-success');

            if (window.showToast) {
                window.showToast('Payment request sent! Check your phone to confirm.', false);
            }

            // 4. Poll for credit balance update (every 5s, max 2 min)
            let pollCount = 0;
            const prevBalance = userCredits[selectedType] || 0;
            const pollInterval = setInterval(async () => {
                pollCount++;
                if (pollCount > 24) {
                    clearInterval(pollInterval);
                    return;
                }
                await loadUserCredits();
                if (userCredits[selectedType] > prevBalance) {
                    clearInterval(pollInterval);
                    document.getElementById('ai-credit-shop')?.remove();
                    if (window.showToast) {
                        window.showToast(`${selectedQty} ${selectedType} credits added! ✨`, false);
                    }
                }
            }, 5000);

        } catch (err) {
            console.error('Purchase error:', err);
            payBtn.textContent = '❌ Error. Try again.';
            payBtn.disabled = false;
            if (window.showToast) window.showToast(err.message, true);
            setTimeout(() => {
                payBtn.textContent = '💳 Pay with MTN MoMo';
                payBtn.classList.remove('kv-pay-success');
            }, 3000);
        }
    });
}

// ============================================================
// Image generation via edge function (unchanged)
// ============================================================

async function handleImageGeneration() {
    // Check balance
    await loadUserCredits();
    if (userCredits.image <= 0) {
        showCreditShop();
        return;
    }

    // Ask for prompt
    const prompt = window.prompt('Describe the image you want to generate:');
    if (!prompt || !prompt.trim()) return;

    appendMessage('user', `🖼️ Generate Image: ${prompt}`);
    showTypingIndicator();

    try {
        const { data: { session } } = await window.sb.auth.getSession();
        if (!session) throw new Error('Not authenticated');

        const res = await fetch(
            `${SUPABASE_URL}/functions/v1/ai-generate`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({ type: 'image', prompt: prompt.trim() }),
            }
        );

        const result = await res.json();

        removeTypingIndicator();

        if (result.error === 'no_credits') {
            appendMessage('assistant', '❌ No image credits remaining. Buy more credits to continue.');
            showCreditShop();
            return;
        }

        if (!res.ok || !result.success) {
            throw new Error(result.message || result.error || 'Generation failed');
        }

        // Show generated image
        const chatMsgs = containerEl.querySelector('#ai-chat-messages');
        const imgMsg = document.createElement('div');
        imgMsg.className = 'kv-msg kv-msg-ai';
        imgMsg.innerHTML = `
            <div class="kv-msg-avatar kv-avatar-ai"><i class="fas fa-robot"></i></div>
            <div class="kv-msg-bubble kv-msg-bubble-ai">
                <div class="kv-msg-label">Kivu AI</div>
                <div class="kv-msg-text">✅ Image generated!</div>
                <img src="${result.url}" class="kv-msg-image" alt="AI Generated Image" loading="lazy">
                <div class="kv-msg-meta">Credits remaining: ${result.remaining}</div>
            </div>
        `;
        chatMsgs.appendChild(imgMsg);
        chatMsgs.scrollTo({ top: chatMsgs.scrollHeight, behavior: 'smooth' });

        // Update credits UI
        userCredits.image = result.remaining;
        updateCreditsUI();
        saveChatHistory();

    } catch (err) {
        console.error('Image generation error:', err);
        removeTypingIndicator();
        appendMessage('assistant', `❌ Error generating image: ${err.message}`);
    }
}

// ============================================================
// CodeMirror helpers
// ============================================================

async function createCodeEditor(parentEl, initialCode = '', langKey = 'javascript', readOnly = false, result = false) {
    const { EditorView, EditorState, basicSetup, oneDark, keymap, indentWithTab } = await loadCodeMirror();
    const compartment = result ? languageCompartmentResult : languageCompartment;
    const langConfig = CODE_LANGUAGES[langKey] || CODE_LANGUAGES.javascript;
    const extensions = [
        basicSetup,
        oneDark,
        compartment.of(await langConfig.lang()),
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        EditorView.theme({
            '&': { height: '100%', fontSize: '13px' },
            '.cm-scroller': { overflow: 'auto' },
            '.cm-content': { fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", monospace' },
            '.cm-gutters': { fontFamily: '"JetBrains Mono", monospace', fontSize: '12px' },
        }),
    ];
    if (readOnly) {
        extensions.push(EditorState.readOnly.of(true));
        extensions.push(EditorView.editable.of(false));
    }

    // Add cursor position tracking for status bar
    if (!readOnly) {
        extensions.push(EditorView.updateListener.of(update => {
            if (update.selectionSet) {
                const pos = update.state.selection.main.head;
                const line = update.state.doc.lineAt(pos);
                const col = pos - line.from + 1;
                const statusLine = containerEl?.querySelector('#ide-status-line');
                if (statusLine) statusLine.textContent = `Ln ${line.number}, Col ${col}`;
            }
        }));
    }
    
    const state = EditorState.create({ doc: initialCode, extensions });
    return new EditorView({ state, parent: parentEl });
}

async function switchLanguage(view, langKey) {
    if (!view) return;
    const langConfig = CODE_LANGUAGES[langKey] || CODE_LANGUAGES.javascript;
    const support = await langConfig.lang();
    if (view !== codeEditorView) return; // editor was closed while loading
    view.dispatch({
        effects: languageCompartment.reconfigure(support)
    });
}

// ============================================================
// Typing indicator
// ============================================================

function showTypingIndicator() {
    if (!containerEl) return;
    removeTypingIndicator(); // Prevent duplicates
    const chatContainer = containerEl.querySelector('#ai-chat-messages');
    if (!chatContainer) return;

    const typing = document.createElement('div');
    typing.id = 'kv-typing-indicator';
    typing.className = 'kv-msg kv-msg-ai';
    typing.innerHTML = `
        <div class="kv-msg-avatar kv-avatar-ai"><i class="fas fa-robot"></i></div>
        <div class="kv-msg-bubble kv-msg-bubble-ai">
            <div class="kv-typing-dots">
                <span></span><span></span><span></span>
            </div>
        </div>
    `;
    chatContainer.appendChild(typing);
    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
}

function removeTypingIndicator() {
    containerEl?.querySelector('#kv-typing-indicator')?.remove();
}

// ============================================================
// Chat message display — modern with avatars
// ============================================================

function formatMessageContent(content) {
    // Escape HTML
    let escaped = content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    // Replace fenced code blocks with styled versions + copy button
    let blockId = 0;
    escaped = escaped.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        const id = 'kv-code-' + Date.now() + '-' + (blockId++);
        return `<div class="kv-codeblock">
            <div class="kv-codeblock-header">
                <span class="kv-codeblock-lang">${lang || 'code'}</span>
                <button class="kv-codeblock-copy" data-code-id="${id}" onclick="(function(btn){const code=document.getElementById('${id}');if(code){navigator.clipboard.writeText(code.textContent);btn.textContent='✓ Copied';setTimeout(()=>btn.textContent='📋 Copy',1500)}})( this)">📋 Copy</button>
            </div>
            <pre class="kv-codeblock-pre"><code id="${id}">${code}</code></pre>
        </div>`;
    });
    
    // Replace inline code
    escaped = escaped.replace(/`([^`]+)`/g, '<code class="kv-inline-code">$1</code>');
    
    // Bold
    escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    
    // Line breaks
    escaped = escaped.replace(/\n/g, '<br>');
    
    return escaped;
}

function appendMessage(role, content) {
    if (!containerEl) return;
    const chatContainer = containerEl.querySelector('#ai-chat-messages');
    if (!chatContainer) return;
    
    // Remove welcome screen on first message
    const welcome = chatContainer.querySelector('.kv-welcome');
    if (welcome) welcome.remove();

    const isUser = role === 'user';
    const msg = document.createElement('div');
    msg.className = `kv-msg ${isUser ? 'kv-msg-user' : 'kv-msg-ai'}`;
    
    if (isUser) {
        msg.innerHTML = `
            <div class="kv-msg-bubble kv-msg-bubble-user">
                <div class="kv-msg-text">${content.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
            </div>
            <div class="kv-msg-avatar kv-avatar-user">
                <i class="fas fa-user"></i>
            </div>
        `;
    } else {
        const label = isProMode ? '⚡ Kivu AI Pro' : 'Kivu AI';
        msg.innerHTML = `
            <div class="kv-msg-avatar kv-avatar-ai"><i class="fas fa-robot"></i></div>
            <div class="kv-msg-bubble kv-msg-bubble-ai">
                <div class="kv-msg-label">${label}</div>
                <div class="kv-msg-text">${formatMessageContent(content)}</div>
            </div>
        `;
    }
    
    chatContainer.appendChild(msg);
    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
}

// ============================================================
// Send message — server-side daily limit via RPC (updated: Pro Mode)
// ============================================================

async function handleSend() {
    const inputEl = containerEl.querySelector('#ai-chat-input');
    const prompt = inputEl.value.trim();
    if (!prompt) return;

    const isPro = isProMode;

    // Pro Mode: check thinking credits instead of daily limit
    if (isPro) {
        await loadUserCredits();
        if (userCredits.thinking <= 0) {
            if (window.showToast) window.showToast('No thinking credits. Buy more to use Pro Mode!', true);
            showCreditShop();
            return;
        }
    } else {
        // Server-side daily limit check via increment_ai_usage() RPC
        const { data: allowed, error: limitErr } = await window.sb.rpc('increment_ai_usage');
        if (limitErr || allowed === false) {
            if (window.showToast) window.showToast('Daily limit of free messages reached. Buy Thinking credits for more!', true);
            showCreditShop();
            return;
        }
    }

    inputEl.value = '';
    inputEl.style.height = 'auto';
    appendMessage('user', prompt);
    showTypingIndicator();
    
    // Save to local chat history for the doc
    saveChatHistory();

    const isCodeMode = containerEl.querySelector('#ai-code-mode')?.checked || false;
    const lang = detectLanguage(prompt);
    
    const sendBtn = containerEl.querySelector('#btn-ai-send');
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    // Update usage counter from server response (only for free mode)
    if (!isPro) {
        try {
            const { data: limitsData } = await window.sb
                .from('user_ai_limits')
                .select('message_count')
                .eq('user_id', (await window.sb.auth.getUser()).data.user.id)
                .single();
            if (limitsData) {
                const counter = containerEl.querySelector('#ai-usage-counter');
                if (counter) counter.textContent = `${limitsData.message_count}/${DAILY_LIMIT} msg used`;
            }
        } catch (e) { /* ignore */ }
    }

    try {
        let responseText = "";
        
        // Call AI via edge function (server-side, API keys are secure)
        const { data: { session } } = await window.sb.auth.getSession();
        
        if (session) {
            try {
                const res = await fetch(
                    `${SUPABASE_URL}/functions/v1/ai-generate`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`,
                        },
                        body: JSON.stringify({
                            type: isPro ? 'thinking' : 'free_chat',
                            mode: isPro ? 'pro_chat' : undefined,
                            prompt: prompt,
                            language: lang,
                            isCodeMode: isCodeMode,
                        }),
                    }
                );

                const result = await res.json();

                if (result.error === 'no_credits') {
                    showCreditShop();
                    throw new Error('No credits');
                }

                if (res.ok && result.success) {
                    responseText = result.text || 'No response received.';
                    // Update credits if Pro Mode
                    if (isPro && result.remaining !== null && result.remaining !== undefined) {
                        userCredits.thinking = result.remaining;
                        updateCreditsUI();
                    }
                } else {
                    // Edge function not deployed yet? Fall back to client-side
                    throw new Error(result.error || 'Edge function error');
                }
            } catch (edgeErr) {
                if (edgeErr.message === 'No credits') throw edgeErr;
                console.warn('Edge function not available, using client fallback:', edgeErr.message);
                // Fallback: client-side API call (for backward compatibility until edge functions deployed)
                responseText = await _clientFallbackChat(prompt, isCodeMode, lang);
            }
        } else {
            responseText = await _clientFallbackChat(prompt, isCodeMode, lang);
        }

        removeTypingIndicator();
        appendMessage('assistant', responseText);
        saveChatHistory();
        
    } catch (err) {
        removeTypingIndicator();
        if (err.message !== 'No credits') {
            console.error(err);
            appendMessage('assistant', `Error: ${err.message}`);
        }
    } finally {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
    }
}

// Client-side fallback for chat (works until edge functions are deployed)
// WARNING: API keys in client-side env vars can be extracted via DevTools
async function _clientFallbackChat(prompt, isCodeMode, lang) {
    const deepseekKey = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_DEEPSEEK_API_KEY) || '';
    const geminiKey = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_GEMINI_API_KEY) || '';

    // Mock mode if API keys are missing
    if (!deepseekKey && !geminiKey) {
        await new Promise(r => setTimeout(r, 1000));
        if (isCodeMode) {
            return `Here is the code you requested:\n\`\`\`\nconsole.log("Hello from Kivu AI Code Mode!");\n\`\`\``;
        } else if (lang === 'english') {
            return `This is a mock response from Kivu AI for English text.`;
        } else {
            return `This is a mock response from Kivu AI for ${lang} text.`;
        }
    }

    if ((isCodeMode || lang === 'english') && deepseekKey) {
        const model = isCodeMode ? "deepseek-coder" : "deepseek-chat";
        const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${deepseekKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: [{ role: "user", content: prompt }],
                max_tokens: 1024
            })
        });
        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        const data = await response.json();
        return data.choices[0].message.content;
    } else if (geminiKey) {
        const model = "gemini-1.5-flash";
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: `Respond in ${lang}:\n${prompt}` }] }]
            })
        });
        if (!response.ok) throw new Error(`API Error: ${response.status}`);
        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    }

    return 'No AI provider configured. Please contact support.';
}

// ============================================================
// Code AI — action handler
// ============================================================

async function handleCodeAction(action) {
    // action: 'generate' | 'explain' | 'fix' | 'convert' | 'review'
    
    // Check thinking credits
    await loadUserCredits();
    if (userCredits.thinking <= 0) {
        showCreditShop();
        return;
    }
    
    const langSelect = containerEl.querySelector('#code-lang-select');
    const currentLangKey = langSelect?.value || 'javascript';
    const code = codeEditorView?.state?.doc?.toString() || '';
    
    if (!code.trim() && action !== 'generate') {
        if (window.showToast) window.showToast('Please enter some code first', true);
        return;
    }
    
    // For 'generate' action, use the prompt input
    let prompt = '';
    if (action === 'generate') {
        const promptInput = containerEl.querySelector('#code-prompt-input');
        prompt = promptInput?.value?.trim() || '';
        if (!prompt) {
            if (window.showToast) window.showToast('Please describe what code to generate', true);
            return;
        }
    }
    
    // For 'convert', get target language
    let targetLang = '';
    if (action === 'convert') {
        const targetSelect = containerEl.querySelector('#code-target-lang');
        targetLang = targetSelect?.value || '';
        if (!targetLang || targetLang === currentLangKey) {
            if (window.showToast) window.showToast('Please select a different target language', true);
            return;
        }
    }
    
    // Build full prompt for the AI
    const langName = CODE_LANGUAGES[currentLangKey]?.name || currentLangKey;
    let fullPrompt = '';
    switch (action) {
        case 'generate':
            fullPrompt = `Generate ${langName} code for the following task:\n\n${prompt}`;
            break;
        case 'explain':
            fullPrompt = `Explain the following ${langName} code in detail:\n\n\`\`\`${currentLangKey}\n${code}\n\`\`\``;
            break;
        case 'fix':
            fullPrompt = `Find and fix bugs in the following ${langName} code. Return the corrected code with comments explaining what was wrong:\n\n\`\`\`${currentLangKey}\n${code}\n\`\`\``;
            break;
        case 'convert': {
            const targetName = CODE_LANGUAGES[targetLang]?.name || targetLang;
            fullPrompt = `Convert the following ${langName} code to ${targetName}:\n\n\`\`\`${currentLangKey}\n${code}\n\`\`\``;
            break;
        }
        case 'review':
            fullPrompt = `Review the following ${langName} code. Provide feedback on code quality, potential issues, performance, and best practices:\n\n\`\`\`${currentLangKey}\n${code}\n\`\`\``;
            break;
    }
    
    // Show loading state
    const resultText = containerEl.querySelector('#code-result-text');
    const resultEditorEl = containerEl.querySelector('#code-result-editor');
    const resultActions = containerEl.querySelector('#code-result-actions');
    
    resultText.innerHTML = '<div class="kv-ide-loading"><i class="fas fa-spinner fa-spin"></i> Processing your request...</div>';
    resultEditorEl.style.display = 'none';
    resultActions.style.display = 'none';
    
    // Disable action buttons
    containerEl.querySelectorAll('.code-action-btn').forEach(b => b.disabled = true);
    
    try {
        const { data: { session } } = await window.sb.auth.getSession();
        
        let responseText = '';
        
        if (session) {
            try {
                const res = await fetch(
                    `${SUPABASE_URL}/functions/v1/ai-generate`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`,
                        },
                        body: JSON.stringify({
                            type: 'thinking',
                            mode: `code_${action}`,
                            prompt: fullPrompt,
                            language: currentLangKey,
                            targetLanguage: targetLang || undefined,
                        }),
                    }
                );
                
                const result = await res.json();
                
                if (result.error === 'no_credits') {
                    showCreditShop();
                    return;
                }
                
                if (res.ok && result.success) {
                    responseText = result.text || 'No response received.';
                    if (result.remaining !== null && result.remaining !== undefined) {
                        userCredits.thinking = result.remaining;
                        updateCreditsUI();
                    }
                } else {
                    throw new Error(result.error || 'Edge function error');
                }
            } catch (edgeErr) {
                console.warn('Edge function not available, using client fallback:', edgeErr.message);
                responseText = await _clientFallbackChat(fullPrompt, true, 'english');
            }
        } else {
            responseText = await _clientFallbackChat(fullPrompt, true, 'english');
        }
        
        // Parse response — extract code blocks if any
        const codeBlockRegex = /```(?:\w+)?\n([\s\S]*?)```/;
        const codeMatch = responseText.match(codeBlockRegex);
        
        let explanationText = responseText;
        let resultCode = '';
        
        if (codeMatch) {
            resultCode = codeMatch[1].trim();
            // Remove ALL code blocks from explanation
            explanationText = responseText.replace(/```(?:\w+)?\n[\s\S]*?```/g, '').trim();
        }
        
        // Show results
        if (resultCode) {
            resultEditorEl.style.display = 'block';
            resultEditorEl.innerHTML = '';
            
            const resultLang = (action === 'convert' && targetLang) ? targetLang : currentLangKey;
            
            if (codeResultView) { codeResultView.destroy(); codeResultView = null; }
            codeResultView = await createCodeEditor(resultEditorEl, resultCode, resultLang, true, true);
            
            resultActions.style.display = 'flex';
        }
        
        if (explanationText) {
            resultText.innerHTML = `<div class="kv-ide-explanation">${explanationText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
        } else if (!resultCode) {
            resultText.innerHTML = '<div class="kv-ide-explanation" style="opacity:0.5;">No response received.</div>';
        } else {
            resultText.innerHTML = '';
        }
        
        // Save to code history
        saveCodeHistory(action, currentLangKey, code, prompt, responseText, resultCode);
        
    } catch (err) {
        console.error('Code action error:', err);
        resultText.innerHTML = `<div class="kv-ide-explanation" style="color:#f38ba8;">❌ Error: ${err.message}</div>`;
    } finally {
        containerEl.querySelectorAll('.code-action-btn').forEach(b => b.disabled = false);
    }
}

// ============================================================
// Code AI history (localStorage)
// ============================================================

function saveCodeHistory(action, lang, inputCode, prompt, response, resultCode) {
    try {
        const history = JSON.parse(localStorage.getItem(CODE_HISTORY_KEY) || '[]');
        history.unshift({
            action, lang, inputCode, prompt, response, resultCode,
            timestamp: new Date().toISOString(),
        });
        // Keep last 50 entries
        if (history.length > 50) history.length = 50;
        localStorage.setItem(CODE_HISTORY_KEY, JSON.stringify(history));
    } catch (e) { console.error('Code history save error:', e); }
}

// ============================================================
// Chat history persistence (unchanged)
// ============================================================

function saveChatHistory() {
    if (!containerEl) return;
    const title = containerEl.querySelector('#ai-doc-title')?.value || 'AI Chat';
    const docId = currentDocId || ('ai_' + Date.now());
    currentDocId = docId;

    const messages = [];
    containerEl.querySelectorAll('#ai-chat-messages > .kv-msg').forEach(div => {
        const isUser = div.classList.contains('kv-msg-user');
        const contentEl = div.querySelector('.kv-msg-text');
        if (contentEl) {
            messages.push({ role: isUser ? 'user' : 'assistant', content: contentEl.innerHTML });
        }
    });

    localStorage.setItem(AI_STORAGE_KEY + docId, JSON.stringify({
        id: docId,
        title: title,
        type: 'ai',
        messages: messages
    }));

    updateDocsIndex(docId, title);
}

// ============================================================
// Main init
// ============================================================

export async function init(docId = null) {
    const existingModal = document.getElementById('ai-editor-modal');
    if (existingModal) {
        existingModal.remove();
    }

    currentDocId = docId || null;
    activeTab = 'chat';
    isProMode = false;

    // Cleanup any previous CodeMirror instances
    if (codeEditorView) { codeEditorView.destroy(); codeEditorView = null; }
    if (codeResultView) { codeResultView.destroy(); codeResultView = null; }
    codeEditorLoading = null;

    let usageCount = 0;
    const modalHtml = `
        <div id="ai-editor-modal" class="kv-ai-root">

            <!-- ========== TOP BAR ========== -->
            <div class="kv-topbar">
                <div class="kv-topbar-left">
                    <button id="btn-back" class="kv-topbar-btn"><i class="fas fa-arrow-left"></i></button>
                    <input type="text" id="ai-doc-title" value="Kivu AI Chat" class="kv-topbar-title">
                </div>
                <div class="kv-topbar-right">
                    <div id="ai-credits-display" class="kv-badge kv-badge-credits" title="Buy AI Credits">
                        🖼️ 0 🧠 0
                    </div>
                    <div class="kv-badge kv-badge-usage">
                        <span id="ai-usage-counter">0/${DAILY_LIMIT} msg used</span>
                    </div>
                </div>
            </div>

            <!-- ========== TABS ========== -->
            <div class="kv-tabs-bar">
                <button id="tab-chat" class="ai-tab kv-tab kv-tab-active" data-tab="chat">
                    <i class="fas fa-comments"></i> Chat
                </button>
                <button id="tab-code" class="ai-tab kv-tab" data-tab="code">
                    <i class="fas fa-terminal"></i> Code AI
                </button>
            </div>

            <!-- ========== CHAT TAB ========== -->
            <div id="panel-chat" class="kv-panel kv-panel-chat">
                <!-- Chat messages -->
                <div id="ai-chat-messages" class="kv-chat-messages">
                    <!-- Welcome screen -->
                    <div class="kv-welcome">
                        <div class="kv-welcome-glow"></div>
                        <div class="kv-welcome-avatar">
                            <i class="fas fa-robot"></i>
                        </div>
                        <h2 class="kv-welcome-title">Kivu AI</h2>
                        <p class="kv-welcome-subtitle">Your smart and powerful assistant</p>
                        <div class="kv-suggestions">
                            <button class="kv-suggestion-chip" data-prompt="Write a Python function to sort a list">
                                <span class="kv-chip-icon">💻</span>
                                <span>Write Python code</span>
                            </button>
                            <button class="kv-suggestion-chip" data-prompt="Generate an image of a sunset over Lake Kivu">
                                <span class="kv-chip-icon">🖼️</span>
                                <span>Generate an image</span>
                            </button>
                            <button class="kv-suggestion-chip" data-prompt="Explain quantum computing in simple terms">
                                <span class="kv-chip-icon">🧠</span>
                                <span>Explain a concept</span>
                            </button>
                            <button class="kv-suggestion-chip" data-prompt="Translate 'Hello, how are you?' to Kinyarwanda">
                                <span class="kv-chip-icon">🌍</span>
                                <span>Translate text</span>
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Input Area -->
                <div class="kv-chat-input-area">
                    <div class="kv-chat-input-row">
                        <!-- Attachment buttons inside input -->
                        <div class="kv-input-actions-left">
                            <button id="btn-ai-image" class="kv-input-action-btn" title="Generate Image">
                                <i class="fas fa-image"></i>
                            </button>
                            <button id="btn-ai-video" class="kv-input-action-btn kv-disabled" title="Video (Coming Soon)" disabled>
                                <i class="fas fa-video"></i>
                            </button>
                        </div>
                        <textarea id="ai-chat-input" rows="1" placeholder="Type your message..." class="kv-chat-input"></textarea>
                        <button id="btn-ai-send" class="kv-send-btn">
                            <i class="fas fa-paper-plane"></i>
                        </button>
                    </div>
                    <div class="kv-chat-input-bottom">
                        <button id="btn-buy-credits" class="kv-pill-btn kv-pill-credits">
                            <i class="fas fa-coins"></i> Credits
                        </button>
                        <!-- Pro Mode Toggle -->
                        <label class="kv-toggle-label">
                            <input type="checkbox" id="ai-pro-mode" class="kv-toggle-input">
                            <div class="kv-toggle-track kv-toggle-pro">
                                <div class="kv-toggle-thumb"></div>
                            </div>
                            <span class="kv-toggle-text kv-text-pro">⚡ Pro</span>
                        </label>
                        <!-- Code Mode Toggle -->
                        <label class="kv-toggle-label">
                            <input type="checkbox" id="ai-code-mode" class="kv-toggle-input">
                            <div class="kv-toggle-track kv-toggle-code">
                                <div class="kv-toggle-thumb"></div>
                            </div>
                            <span class="kv-toggle-text"><i class="fas fa-code" style="color:var(--kv-accent);margin-right:2px;"></i>Code</span>
                        </label>
                    </div>
                    <!-- Pro Mode indicator -->
                    <div id="pro-mode-indicator" class="kv-pro-indicator" style="display:none;">
                        ⚡ Pro Mode: Using powerful AI model (1 thinking credit per message)
                    </div>
                </div>
            </div>

            <!-- ========== CODE AI TAB ========== -->
            <div id="panel-code" class="kv-panel kv-panel-code" style="display:none;">
                <!-- Action Bar -->
                <div class="kv-ide-actionbar">
                    <div class="kv-ide-actionbar-inner">
                        <!-- Language selector -->
                        <select id="code-lang-select" class="kv-ide-select">
                            <option value="javascript">JavaScript</option>
                            <option value="python">Python</option>
                            <option value="html">HTML</option>
                            <option value="css">CSS</option>
                            <option value="php">PHP</option>
                            <option value="cpp">C/C++</option>
                            <option value="java">Java</option>
                            <option value="sql">SQL</option>
                        </select>
                        
                        <!-- Action buttons -->
                        <div class="kv-ide-actions">
                            <button class="code-action-btn kv-ide-action" data-action="generate" title="Generate code from description">
                                <i class="fas fa-magic"></i> Generate
                            </button>
                            <button class="code-action-btn kv-ide-action" data-action="explain" title="Explain selected code">
                                <i class="fas fa-book-open"></i> Explain
                            </button>
                            <button class="code-action-btn kv-ide-action" data-action="fix" title="Fix bugs in code">
                                <i class="fas fa-wrench"></i> Fix
                            </button>
                            <button class="code-action-btn kv-ide-action" data-action="convert" title="Convert to another language">
                                <i class="fas fa-exchange-alt"></i> Convert
                            </button>
                            <button class="code-action-btn kv-ide-action" data-action="review" title="Code review">
                                <i class="fas fa-search"></i> Review
                            </button>
                        </div>
                        
                        <!-- Target language (for convert) -->
                        <select id="code-target-lang" class="kv-ide-select" style="display:none;">
                            <option value="" disabled selected>→ To:</option>
                            <option value="javascript">JavaScript</option>
                            <option value="python">Python</option>
                            <option value="html">HTML</option>
                            <option value="css">CSS</option>
                            <option value="php">PHP</option>
                            <option value="cpp">C/C++</option>
                            <option value="java">Java</option>
                            <option value="sql">SQL</option>
                        </select>
                        
                        <!-- Credits -->
                        <div class="kv-ide-credits-badge">
                            🧠 <span id="code-credits-count">0</span> credits
                        </div>
                    </div>
                </div>
                
                <!-- Prompt input bar (for Generate action) -->
                <div id="code-prompt-bar" class="kv-ide-prompt-bar" style="display:none;">
                    <div class="kv-ide-prompt-inner">
                        <input id="code-prompt-input" type="text" placeholder="Describe what code to generate..." class="kv-ide-prompt-input">
                        <button id="btn-code-generate-go" class="kv-ide-prompt-btn">
                            Generate <i class="fas fa-magic"></i>
                        </button>
                    </div>
                </div>
                
                <!-- Editor + Result Split View -->
                <div id="code-split-view" class="kv-ide-split">
                    <!-- Code Input Editor -->
                    <div class="kv-ide-panel-left">
                        <div class="kv-ide-panel-header">
                            <span><i class="fas fa-edit" style="margin-right:6px;opacity:0.7;"></i>Your Code</span>
                            <button id="btn-clear-editor" class="kv-ide-header-btn" title="Clear editor">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </div>
                        <div id="code-editor-mount" class="kv-ide-editor-mount"></div>
                    </div>
                    
                    <!-- Drag handle -->
                    <div class="kv-ide-resizer" id="ide-resizer"></div>
                    
                    <!-- Result Panel -->
                    <div class="kv-ide-panel-right">
                        <div class="kv-ide-panel-header">
                            <span><i class="fas fa-robot" style="margin-right:6px;opacity:0.7;"></i>AI Response</span>
                            <div id="code-result-actions" class="kv-ide-result-btns" style="display:none;">
                                <button id="btn-copy-code" class="kv-ide-header-btn" title="Copy code">
                                    <i class="fas fa-copy"></i> Copy
                                </button>
                                <button id="btn-download-code" class="kv-ide-header-btn" title="Download code">
                                    <i class="fas fa-download"></i> Save
                                </button>
                                <button id="btn-apply-code" class="kv-ide-header-btn" title="Apply to editor">
                                    <i class="fas fa-arrow-left"></i> Apply
                                </button>
                            </div>
                        </div>
                        <div class="kv-ide-result-scroll">
                            <div id="code-result-text">
                                <div class="kv-ide-empty-state">
                                    <div class="kv-ide-empty-icon">
                                        <i class="fas fa-terminal"></i>
                                    </div>
                                    <div class="kv-ide-empty-title">Select an action to get started</div>
                                    <div class="kv-ide-empty-sub">Each action costs 1 thinking credit (50 RWF)</div>
                                </div>
                            </div>
                            <div id="code-result-editor" style="min-height:0;display:none;"></div>
                        </div>
                    </div>
                </div>
                
                <!-- Status Bar -->
                <div class="kv-ide-statusbar">
                    <span id="ide-status-line">Ln 1, Col 1</span>
                    <span id="ide-status-lang">JavaScript</span>
                    <span>UTF-8</span>
                    <span id="ide-status-credits">🧠 0</span>
                </div>
            </div>
        </div>
        
        <style id="ai-editor-style">
            /* ============================================ */
            /* Kivu AI — Modern Dark Theme v2              */
            /* ============================================ */
            
            :root {
                --kv-bg-deepest: #0a0a1a;
                --kv-bg-deep: #0f0f23;
                --kv-bg-surface: #161628;
                --kv-bg-elevated: #1c1c35;
                --kv-bg-card: #222240;
                --kv-border: #2a2a50;
                --kv-border-light: #353560;
                --kv-text: #e4e4f0;
                --kv-text-secondary: #9d9db8;
                --kv-text-muted: #6b6b8a;
                --kv-accent: #6366f1;
                --kv-accent-light: #818cf8;
                --kv-accent-glow: rgba(99, 102, 241, 0.25);
                --kv-purple: #8b5cf6;
                --kv-cyan: #06b6d4;
                --kv-green: #22c55e;
                --kv-red: #ef4444;
                --kv-amber: #f59e0b;
                --kv-user-gradient: linear-gradient(135deg, #6366f1, #8b5cf6);
                --kv-ai-gradient: linear-gradient(135deg, #06b6d4, #6366f1);
                --kv-radius: 14px;
                --kv-radius-sm: 10px;
                --kv-radius-lg: 20px;
                --kv-font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                --kv-font-mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', monospace;
                --kv-glass: rgba(255, 255, 255, 0.04);
                --kv-glass-border: rgba(255, 255, 255, 0.08);
                --kv-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
            }
            
            /* ---- Root container ---- */
            .kv-ai-root {
                position: fixed; inset: 0;
                background: var(--kv-bg-deepest);
                z-index: 100000;
                display: flex; flex-direction: column;
                overflow: hidden;
                font-family: var(--kv-font);
                color: var(--kv-text);
            }
            
            /* ---- Top bar ---- */
            .kv-topbar {
                background: var(--kv-bg-surface);
                border-bottom: 1px solid var(--kv-border);
                padding: 10px 16px;
                display: flex; align-items: center; justify-content: space-between;
                flex-shrink: 0;
                backdrop-filter: blur(12px);
            }
            .kv-topbar-left { display: flex; align-items: center; gap: 10px; }
            .kv-topbar-right { display: flex; align-items: center; gap: 10px; }
            .kv-topbar-btn {
                width: 36px; height: 36px; border-radius: 10px;
                border: 1px solid var(--kv-border);
                background: var(--kv-glass);
                color: var(--kv-text-secondary);
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; transition: all 0.2s;
                font-size: 14px;
            }
            .kv-topbar-btn:hover { background: var(--kv-bg-card); color: var(--kv-text); }
            .kv-topbar-title {
                border: none; background: transparent;
                color: var(--kv-text); font-weight: 600; font-size: 16px;
                outline: none; width: 140px; font-family: var(--kv-font);
            }
            .kv-topbar-title::placeholder { color: var(--kv-text-muted); }
            
            /* ---- Badges ---- */
            .kv-badge {
                display: flex; align-items: center; gap: 6px;
                font-size: 12px; font-weight: 600;
                padding: 6px 12px; border-radius: 20px;
                cursor: pointer; transition: all 0.2s;
            }
            .kv-badge-credits {
                background: linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.15));
                color: var(--kv-accent-light);
                border: 1px solid rgba(99,102,241,0.3);
            }
            .kv-badge-credits:hover { background: linear-gradient(135deg, rgba(99,102,241,0.25), rgba(139,92,246,0.25)); }
            .kv-badge-usage {
                background: var(--kv-glass);
                color: var(--kv-text-secondary);
                border: 1px solid var(--kv-glass-border);
            }
            
            /* ---- Tabs ---- */
            .kv-tabs-bar {
                background: var(--kv-bg-surface);
                border-bottom: 1px solid var(--kv-border);
                display: flex; flex-shrink: 0;
            }
            .kv-tab {
                flex: 1; padding: 12px 16px;
                font-size: 13px; font-weight: 700;
                text-align: center;
                border: none; background: transparent;
                color: var(--kv-text-muted);
                cursor: pointer; transition: all 0.25s;
                border-bottom: 2px solid transparent;
                font-family: var(--kv-font);
                display: flex; align-items: center; justify-content: center; gap: 8px;
            }
            .kv-tab:hover { color: var(--kv-text-secondary); background: var(--kv-glass); }
            .kv-tab-active {
                color: var(--kv-accent-light) !important;
                border-bottom-color: var(--kv-accent) !important;
                background: rgba(99,102,241,0.05) !important;
            }
            
            /* ---- Panel ---- */
            .kv-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; }
            .kv-panel-chat { background: var(--kv-bg-deepest); }
            .kv-panel-code { background: var(--kv-bg-deep); }
            
            /* ---- Chat Messages ---- */
            .kv-chat-messages {
                flex: 1; padding: 20px 16px;
                overflow-y: auto;
                display: flex; flex-direction: column;
                gap: 4px;
                max-width: 900px; width: 100%; margin: 0 auto;
                box-sizing: border-box;
            }
            
            /* ---- Welcome Screen ---- */
            .kv-welcome {
                display: flex; flex-direction: column;
                align-items: center; justify-content: center;
                flex: 1; padding: 40px 20px;
                text-align: center; position: relative;
            }
            .kv-welcome-glow {
                position: absolute; top: 20%; left: 50%; transform: translateX(-50%);
                width: 200px; height: 200px;
                background: radial-gradient(circle, var(--kv-accent-glow) 0%, transparent 70%);
                border-radius: 50%; filter: blur(40px);
                pointer-events: none;
                animation: kv-pulse-glow 4s ease-in-out infinite;
            }
            .kv-welcome-avatar {
                width: 72px; height: 72px;
                background: var(--kv-ai-gradient);
                border-radius: 22px; display: flex;
                align-items: center; justify-content: center;
                font-size: 32px; color: white;
                box-shadow: 0 8px 32px rgba(99,102,241,0.3);
                margin-bottom: 16px; position: relative;
                animation: kv-float 6s ease-in-out infinite;
            }
            .kv-welcome-title {
                font-size: 22px; font-weight: 800;
                background: var(--kv-user-gradient);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                background-clip: text; margin: 0 0 6px;
            }
            .kv-welcome-subtitle {
                color: var(--kv-text-muted); font-size: 14px; margin: 0 0 28px;
            }
            .kv-suggestions {
                display: grid; grid-template-columns: 1fr 1fr;
                gap: 10px; width: 100%; max-width: 420px;
            }
            .kv-suggestion-chip {
                display: flex; align-items: center; gap: 10px;
                padding: 14px 16px; border-radius: var(--kv-radius);
                border: 1px solid var(--kv-border);
                background: var(--kv-glass);
                color: var(--kv-text-secondary);
                cursor: pointer; transition: all 0.25s;
                font-size: 13px; font-weight: 500;
                text-align: left; font-family: var(--kv-font);
                backdrop-filter: blur(8px);
            }
            .kv-suggestion-chip:hover {
                background: var(--kv-bg-card);
                border-color: var(--kv-accent);
                color: var(--kv-text);
                transform: translateY(-2px);
                box-shadow: 0 4px 16px rgba(99,102,241,0.15);
            }
            .kv-chip-icon { font-size: 18px; }
            
            /* ---- Messages ---- */
            .kv-msg {
                display: flex; gap: 10px;
                max-width: 85%; margin-bottom: 6px;
                animation: kv-fadeSlideUp 0.3s ease;
            }
            .kv-msg-user {
                align-self: flex-end; flex-direction: row-reverse;
            }
            .kv-msg-ai { align-self: flex-start; }
            
            .kv-msg-avatar {
                width: 32px; height: 32px; border-radius: 10px;
                display: flex; align-items: center; justify-content: center;
                flex-shrink: 0; font-size: 14px; font-weight: 700;
            }
            .kv-avatar-user {
                background: var(--kv-user-gradient);
                color: white; font-size: 12px;
            }
            .kv-avatar-ai {
                background: var(--kv-ai-gradient);
                color: white;
            }
            
            .kv-msg-bubble {
                padding: 12px 16px; border-radius: var(--kv-radius);
                line-height: 1.6; font-size: 14px;
                position: relative;
            }
            .kv-msg-bubble-user {
                background: var(--kv-user-gradient);
                color: white;
                border-bottom-right-radius: 4px;
            }
            .kv-msg-bubble-ai {
                background: var(--kv-bg-elevated);
                border: 1px solid var(--kv-border);
                color: var(--kv-text);
                border-bottom-left-radius: 4px;
                backdrop-filter: blur(8px);
            }
            .kv-msg-label {
                font-size: 11px; font-weight: 700;
                color: var(--kv-accent-light);
                margin-bottom: 4px; opacity: 0.8;
            }
            .kv-msg-text { word-break: break-word; white-space: pre-wrap; }
            .kv-msg-text br { line-height: 1.2; }
            .kv-msg-meta {
                font-size: 11px; color: var(--kv-text-muted);
                margin-top: 6px;
            }
            .kv-msg-image {
                max-width: 100%; border-radius: var(--kv-radius-sm);
                margin-top: 8px;
            }
            
            /* ---- Typing indicator ---- */
            .kv-typing-dots {
                display: flex; gap: 5px; padding: 4px 0;
            }
            .kv-typing-dots span {
                width: 8px; height: 8px;
                background: var(--kv-accent-light);
                border-radius: 50%;
                animation: kv-bounce 1.4s ease-in-out infinite;
            }
            .kv-typing-dots span:nth-child(2) { animation-delay: 0.2s; }
            .kv-typing-dots span:nth-child(3) { animation-delay: 0.4s; }
            
            /* ---- Code blocks in chat ---- */
            .kv-codeblock {
                margin: 10px 0; border-radius: var(--kv-radius-sm);
                overflow: hidden; border: 1px solid var(--kv-border);
            }
            .kv-codeblock-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 6px 12px;
                background: var(--kv-bg-card);
                border-bottom: 1px solid var(--kv-border);
            }
            .kv-codeblock-lang {
                font-size: 11px; font-weight: 700;
                color: var(--kv-text-muted);
                text-transform: uppercase; letter-spacing: 0.5px;
            }
            .kv-codeblock-copy {
                font-size: 11px; font-weight: 600;
                color: var(--kv-text-muted);
                background: transparent; border: none;
                cursor: pointer; padding: 2px 8px;
                border-radius: 6px; transition: all 0.2s;
                font-family: var(--kv-font);
            }
            .kv-codeblock-copy:hover { background: var(--kv-glass); color: var(--kv-text); }
            .kv-codeblock-pre {
                margin: 0; padding: 14px 16px;
                background: var(--kv-bg-deepest);
                overflow-x: auto; font-size: 13px;
                font-family: var(--kv-font-mono);
                line-height: 1.6; color: #cdd6f4;
            }
            .kv-inline-code {
                background: var(--kv-bg-card);
                padding: 2px 7px; border-radius: 5px;
                font-size: 12px; font-family: var(--kv-font-mono);
                color: var(--kv-accent-light);
                border: 1px solid var(--kv-border);
            }
            
            /* ---- Chat Input Area ---- */
            .kv-chat-input-area {
                background: var(--kv-bg-surface);
                border-top: 1px solid var(--kv-border);
                padding: 12px 16px 10px;
                flex-shrink: 0;
            }
            .kv-chat-input-row {
                display: flex; align-items: flex-end; gap: 8px;
                max-width: 900px; margin: 0 auto;
            }
            .kv-input-actions-left {
                display: flex; gap: 4px; padding-bottom: 6px;
            }
            .kv-input-action-btn {
                width: 36px; height: 36px; border-radius: 10px;
                border: 1px solid var(--kv-border);
                background: var(--kv-glass);
                color: var(--kv-text-muted);
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; transition: all 0.2s; font-size: 14px;
            }
            .kv-input-action-btn:hover:not(:disabled) { 
                background: var(--kv-bg-card); color: var(--kv-accent-light);
                border-color: var(--kv-accent);
            }
            .kv-input-action-btn.kv-disabled { opacity: 0.35; cursor: not-allowed; }
            .kv-chat-input {
                flex: 1; background: var(--kv-bg-elevated);
                border: 1px solid var(--kv-border);
                border-radius: var(--kv-radius);
                padding: 12px 16px; font-size: 14px;
                color: var(--kv-text); resize: none;
                outline: none; max-height: 120px;
                min-height: 44px; line-height: 1.5;
                font-family: var(--kv-font);
                transition: border-color 0.2s;
            }
            .kv-chat-input::placeholder { color: var(--kv-text-muted); }
            .kv-chat-input:focus { border-color: var(--kv-accent); }
            .kv-send-btn {
                width: 44px; height: 44px; border-radius: 12px;
                border: none;
                background: var(--kv-user-gradient);
                color: white; font-size: 16px;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; transition: all 0.2s;
                flex-shrink: 0;
                box-shadow: 0 4px 12px rgba(99,102,241,0.3);
            }
            .kv-send-btn:hover { transform: scale(1.05); box-shadow: 0 6px 20px rgba(99,102,241,0.4); }
            .kv-send-btn:active { transform: scale(0.95); }
            .kv-send-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
            
            .kv-chat-input-bottom {
                display: flex; align-items: center; gap: 10px;
                max-width: 900px; margin: 8px auto 0;
                justify-content: center; flex-wrap: wrap;
            }
            .kv-pill-btn {
                font-size: 12px; font-weight: 600;
                padding: 6px 14px; border-radius: 20px;
                border: 1px solid var(--kv-border);
                background: var(--kv-glass);
                color: var(--kv-text-secondary);
                cursor: pointer; transition: all 0.2s;
                display: flex; align-items: center; gap: 5px;
                font-family: var(--kv-font);
            }
            .kv-pill-credits:hover { 
                background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(239,68,68,0.15));
                border-color: var(--kv-amber); color: var(--kv-amber);
            }
            .kv-pro-indicator {
                text-align: center; margin-top: 6px;
                font-size: 12px; font-weight: 600;
                color: var(--kv-amber);
                max-width: 900px; margin-left: auto; margin-right: auto;
            }
            
            /* ---- Toggle ---- */
            .kv-toggle-label { display: flex; align-items: center; cursor: pointer; gap: 6px; }
            .kv-toggle-input { position: absolute; opacity: 0; width: 0; height: 0; }
            .kv-toggle-track {
                width: 36px; height: 20px;
                background: var(--kv-bg-card);
                border-radius: 10px; position: relative;
                transition: background 0.3s;
                border: 1px solid var(--kv-border);
            }
            .kv-toggle-thumb {
                width: 16px; height: 16px;
                background: var(--kv-text-muted);
                border-radius: 50%;
                position: absolute; left: 2px; top: 1px;
                transition: all 0.3s;
            }
            .kv-toggle-input:checked + .kv-toggle-pro {
                background: rgba(245,158,11,0.2);
                border-color: var(--kv-amber);
            }
            .kv-toggle-input:checked + .kv-toggle-pro .kv-toggle-thumb {
                transform: translateX(15px);
                background: var(--kv-amber);
            }
            .kv-toggle-input:checked + .kv-toggle-code {
                background: rgba(99,102,241,0.2);
                border-color: var(--kv-accent);
            }
            .kv-toggle-input:checked + .kv-toggle-code .kv-toggle-thumb {
                transform: translateX(15px);
                background: var(--kv-accent);
            }
            .kv-toggle-text {
                font-size: 12px; font-weight: 700;
                color: var(--kv-text-secondary);
            }
            .kv-text-pro { color: var(--kv-amber); }
            
            /* ============================================ */
            /* IDE / Code AI Tab                           */
            /* ============================================ */
            
            .kv-ide-actionbar {
                flex-shrink: 0;
                background: var(--kv-bg-surface);
                border-bottom: 1px solid var(--kv-border);
                padding: 10px 14px;
            }
            .kv-ide-actionbar-inner {
                max-width: 80rem; margin: 0 auto;
                display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            }
            .kv-ide-select {
                background: var(--kv-bg-card);
                color: var(--kv-text);
                font-size: 12px; font-weight: 600;
                padding: 8px 12px; border-radius: var(--kv-radius-sm);
                border: 1px solid var(--kv-border);
                outline: none; cursor: pointer;
                font-family: var(--kv-font);
                transition: border-color 0.2s;
            }
            .kv-ide-select:hover { border-color: var(--kv-accent); }
            
            .kv-ide-actions { display: flex; flex-wrap: wrap; gap: 6px; }
            .kv-ide-action {
                font-size: 12px; font-weight: 600;
                padding: 8px 14px; border-radius: var(--kv-radius-sm);
                border: 1px solid var(--kv-border);
                background: var(--kv-glass);
                color: var(--kv-text-secondary);
                cursor: pointer; transition: all 0.2s;
                display: flex; align-items: center; gap: 5px;
                font-family: var(--kv-font);
            }
            .kv-ide-action:hover:not(:disabled) {
                background: var(--kv-accent-glow);
                border-color: var(--kv-accent);
                color: var(--kv-accent-light);
                box-shadow: 0 0 12px var(--kv-accent-glow);
            }
            .kv-ide-action:active:not(:disabled) { transform: scale(0.96); }
            .kv-ide-action:disabled { opacity: 0.4; cursor: not-allowed; }
            .kv-ide-action i { font-size: 11px; }
            
            .kv-ide-credits-badge {
                margin-left: auto;
                font-size: 12px; color: var(--kv-text-muted);
                font-weight: 600;
            }
            
            .kv-ide-prompt-bar {
                flex-shrink: 0;
                background: var(--kv-bg-elevated);
                border-bottom: 1px solid var(--kv-border);
                padding: 10px 14px;
            }
            .kv-ide-prompt-inner {
                max-width: 80rem; margin: 0 auto;
                display: flex; gap: 8px;
            }
            .kv-ide-prompt-input {
                flex: 1; background: var(--kv-bg-card);
                color: var(--kv-text); font-size: 13px;
                padding: 10px 14px; border-radius: var(--kv-radius-sm);
                border: 1px solid var(--kv-border);
                outline: none; font-family: var(--kv-font);
                transition: border-color 0.2s;
            }
            .kv-ide-prompt-input:focus { border-color: var(--kv-accent); }
            .kv-ide-prompt-input::placeholder { color: var(--kv-text-muted); }
            .kv-ide-prompt-btn {
                background: var(--kv-accent);
                color: white; font-size: 13px; font-weight: 700;
                padding: 10px 18px; border-radius: var(--kv-radius-sm);
                border: none; cursor: pointer; white-space: nowrap;
                transition: all 0.2s; font-family: var(--kv-font);
                display: flex; align-items: center; gap: 6px;
            }
            .kv-ide-prompt-btn:hover {
                background: var(--kv-accent-light);
                box-shadow: 0 4px 16px var(--kv-accent-glow);
            }
            
            /* ---- Split view ---- */
            .kv-ide-split {
                flex: 1; display: flex; min-height: 0; overflow: hidden;
            }
            .kv-ide-panel-left, .kv-ide-panel-right {
                flex: 1; display: flex; flex-direction: column;
                min-height: 0; min-width: 0;
            }
            .kv-ide-panel-header {
                background: var(--kv-bg-surface);
                padding: 8px 14px;
                font-size: 12px; font-weight: 600;
                color: var(--kv-text-muted);
                border-bottom: 1px solid var(--kv-border);
                display: flex; align-items: center; justify-content: space-between;
                flex-shrink: 0;
            }
            .kv-ide-header-btn {
                background: transparent; border: none;
                color: var(--kv-text-muted); cursor: pointer;
                font-size: 11px; font-weight: 600;
                padding: 4px 8px; border-radius: 6px;
                transition: all 0.2s;
                display: flex; align-items: center; gap: 4px;
                font-family: var(--kv-font);
            }
            .kv-ide-header-btn:hover { background: var(--kv-glass); color: var(--kv-text); }
            .kv-ide-result-btns { display: flex; gap: 4px; align-items: center; }
            
            .kv-ide-editor-mount {
                flex: 1; min-height: 0; overflow: hidden;
                background: var(--kv-bg-deep);
            }
            .kv-ide-result-scroll {
                flex: 1; min-height: 0; overflow-y: auto;
                background: var(--kv-bg-deep);
            }
            
            .kv-ide-resizer {
                width: 4px; background: var(--kv-border);
                cursor: col-resize; transition: background 0.2s;
                flex-shrink: 0; position: relative;
            }
            .kv-ide-resizer:hover, .kv-ide-resizer.kv-dragging {
                background: var(--kv-accent);
            }
            .kv-ide-resizer::after {
                content: ''; position: absolute;
                top: 50%; left: 50%; transform: translate(-50%, -50%);
                width: 2px; height: 30px;
                background: var(--kv-text-muted);
                border-radius: 2px; opacity: 0;
                transition: opacity 0.2s;
            }
            .kv-ide-resizer:hover::after { opacity: 0.5; }
            
            .kv-ide-empty-state {
                display: flex; flex-direction: column;
                align-items: center; justify-content: center;
                padding: 60px 20px; text-align: center;
            }
            .kv-ide-empty-icon {
                width: 64px; height: 64px;
                background: var(--kv-bg-card);
                border-radius: 18px; border: 1px solid var(--kv-border);
                display: flex; align-items: center; justify-content: center;
                font-size: 28px; color: var(--kv-text-muted);
                margin-bottom: 16px;
                animation: kv-float 6s ease-in-out infinite;
            }
            .kv-ide-empty-title {
                font-size: 14px; font-weight: 600;
                color: var(--kv-text-muted); margin-bottom: 6px;
            }
            .kv-ide-empty-sub {
                font-size: 12px; color: var(--kv-text-muted); opacity: 0.7;
            }
            .kv-ide-loading {
                display: flex; align-items: center; gap: 8px;
                color: var(--kv-text-muted); padding: 20px;
                font-size: 13px;
            }
            .kv-ide-explanation {
                padding: 16px; color: var(--kv-text);
                font-size: 13px; white-space: pre-wrap;
                line-height: 1.7;
            }
            
            /* ---- Status Bar ---- */
            .kv-ide-statusbar {
                flex-shrink: 0;
                background: var(--kv-bg-surface);
                border-top: 1px solid var(--kv-border);
                padding: 4px 16px;
                display: flex; align-items: center; gap: 16px;
                font-size: 11px; font-weight: 500;
                color: var(--kv-text-muted);
            }
            .kv-ide-statusbar span:last-child { margin-left: auto; }
            
            /* ---- CodeMirror overrides ---- */
            .kv-ide-editor-mount .cm-editor { height: 100%; }
            #code-result-editor .cm-editor { min-height: 150px; }
            
            /* ============================================ */
            /* Credit Shop (modal)                         */
            /* ============================================ */
            
            .kv-modal-overlay {
                position: fixed; inset: 0; z-index: 200000;
                background: rgba(0,0,0,0.6);
                backdrop-filter: blur(4px);
                display: flex; align-items: center; justify-content: center;
                padding: 16px;
                animation: kv-fadeIn 0.2s ease;
            }
            .kv-shop-card {
                background: var(--kv-bg-elevated);
                border-radius: var(--kv-radius-lg);
                max-width: 420px; width: 100%;
                max-height: 90vh; overflow-y: auto;
                box-shadow: 0 25px 60px rgba(0,0,0,0.5);
                border: 1px solid var(--kv-border);
                animation: kv-slideUp 0.3s ease;
            }
            .kv-shop-header {
                padding: 20px 20px 14px;
                border-bottom: 1px solid var(--kv-border);
                display: flex; align-items: center; justify-content: space-between;
            }
            .kv-shop-header h2 {
                font-size: 18px; font-weight: 700; margin: 0;
                color: var(--kv-text);
            }
            .kv-shop-close {
                width: 32px; height: 32px; border-radius: 10px;
                border: 1px solid var(--kv-border);
                background: var(--kv-glass); font-size: 16px;
                color: var(--kv-text-muted);
                cursor: pointer; display: flex;
                align-items: center; justify-content: center;
                transition: all 0.2s;
            }
            .kv-shop-close:hover { background: var(--kv-bg-card); color: var(--kv-text); }
            
            .kv-shop-balance {
                margin: 14px 16px;
                background: var(--kv-user-gradient);
                border-radius: var(--kv-radius);
                padding: 14px 18px; color: white;
            }
            .kv-shop-balance-label {
                font-size: 12px; opacity: 0.8; margin-bottom: 6px;
            }
            .kv-shop-balance-amounts {
                display: flex; gap: 16px; font-size: 16px; font-weight: 700;
            }
            
            .kv-shop-section { padding: 10px 16px; }
            .kv-shop-section-title {
                font-size: 13px; font-weight: 600;
                color: var(--kv-text-muted); margin-bottom: 10px;
            }
            .kv-shop-type-grid {
                display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;
            }
            .kv-shop-type-btn {
                padding: 14px 10px; border-radius: var(--kv-radius);
                border: 2px solid var(--kv-border);
                background: var(--kv-glass);
                cursor: pointer; text-align: center;
                transition: all 0.2s; color: var(--kv-text);
                font-family: var(--kv-font);
            }
            .kv-shop-type-btn:disabled { opacity: 0.35; cursor: not-allowed; }
            .kv-shop-type-btn.kv-selected {
                border-color: var(--kv-accent);
                background: var(--kv-accent-glow);
            }
            .kv-shop-type-icon { font-size: 26px; margin-bottom: 6px; }
            .kv-shop-type-name { font-size: 13px; font-weight: 700; }
            .kv-shop-type-unit { font-size: 10px; color: var(--kv-text-muted); }
            
            .kv-shop-qty-grid {
                display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px;
            }
            .kv-shop-qty-btn {
                padding: 12px 8px; border-radius: var(--kv-radius-sm);
                border: 2px solid var(--kv-border);
                background: var(--kv-glass);
                cursor: pointer; text-align: center;
                transition: all 0.2s; color: var(--kv-text);
                font-family: var(--kv-font);
            }
            .kv-shop-qty-btn.kv-selected {
                border-color: var(--kv-accent);
                background: var(--kv-accent-glow);
            }
            .kv-shop-qty-num { font-size: 18px; font-weight: 800; }
            .kv-shop-qty-price { font-size: 10px; color: var(--kv-text-muted); }
            
            .kv-shop-checkout { padding: 16px; }
            .kv-shop-total-row {
                background: var(--kv-bg-card);
                border-radius: var(--kv-radius-sm);
                padding: 12px 16px; margin-bottom: 14px;
                display: flex; justify-content: space-between; align-items: center;
            }
            .kv-shop-total-row span:first-child { font-size: 14px; color: var(--kv-text-muted); }
            .kv-shop-total-price { font-size: 20px; font-weight: 800; color: var(--kv-text); }
            
            .kv-shop-phone-group { margin-bottom: 14px; }
            .kv-shop-phone-label {
                font-size: 12px; font-weight: 600;
                color: var(--kv-text-muted);
                display: block; margin-bottom: 6px;
            }
            .kv-shop-phone-input {
                width: 100%; padding: 12px 14px;
                background: var(--kv-bg-card);
                border: 1px solid var(--kv-border);
                border-radius: var(--kv-radius-sm);
                color: var(--kv-text); font-size: 15px;
                outline: none; box-sizing: border-box;
                font-family: var(--kv-font);
                transition: border-color 0.2s;
            }
            .kv-shop-phone-input:focus { border-color: var(--kv-accent); }
            .kv-shop-phone-input::placeholder { color: var(--kv-text-muted); }
            
            .kv-shop-pay-btn {
                width: 100%; padding: 14px;
                background: var(--kv-user-gradient);
                color: white; border: none;
                border-radius: var(--kv-radius);
                font-size: 15px; font-weight: 700;
                cursor: pointer; transition: all 0.2s;
                font-family: var(--kv-font);
                box-shadow: 0 4px 16px rgba(99,102,241,0.3);
            }
            .kv-shop-pay-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 24px rgba(99,102,241,0.4);
            }
            .kv-shop-pay-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
            .kv-shop-pay-btn.kv-pay-success {
                background: var(--kv-green);
                box-shadow: 0 4px 16px rgba(34,197,94,0.3);
            }
            
            /* ============================================ */
            /* Animations                                  */
            /* ============================================ */
            
            @keyframes kv-fadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes kv-slideUp { 
                from { transform: translateY(20px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            @keyframes kv-fadeSlideUp {
                from { opacity: 0; transform: translateY(8px); }
                to { opacity: 1; transform: translateY(0); }
            }
            @keyframes kv-bounce {
                0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
                40% { transform: translateY(-6px); opacity: 1; }
            }
            @keyframes kv-float {
                0%, 100% { transform: translateY(0); }
                50% { transform: translateY(-6px); }
            }
            @keyframes kv-pulse-glow {
                0%, 100% { opacity: 0.5; transform: translateX(-50%) scale(1); }
                50% { opacity: 0.8; transform: translateX(-50%) scale(1.1); }
            }
            
            /* ============================================ */
            /* Responsive                                  */
            /* ============================================ */
            
            @media (max-width: 768px) {
                .kv-ide-split { flex-direction: column !important; }
                .kv-ide-panel-left, .kv-ide-panel-right {
                    min-height: 200px !important;
                }
                .kv-ide-resizer {
                    width: auto !important; height: 4px !important;
                    cursor: row-resize !important;
                }
                .kv-suggestions { grid-template-columns: 1fr; }
                .kv-topbar-title { width: 100px; font-size: 14px; }
                .kv-ide-actionbar-inner { gap: 6px; }
                .kv-ide-action { padding: 6px 10px; font-size: 11px; }
                .kv-ide-statusbar { gap: 10px; font-size: 10px; }
            }
            
            /* Scrollbar styling */
            .kv-chat-messages::-webkit-scrollbar,
            .kv-ide-result-scroll::-webkit-scrollbar {
                width: 6px;
            }
            .kv-chat-messages::-webkit-scrollbar-track,
            .kv-ide-result-scroll::-webkit-scrollbar-track {
                background: transparent;
            }
            .kv-chat-messages::-webkit-scrollbar-thumb,
            .kv-ide-result-scroll::-webkit-scrollbar-thumb {
                background: var(--kv-border);
                border-radius: 3px;
            }
            .kv-chat-messages::-webkit-scrollbar-thumb:hover,
            .kv-ide-result-scroll::-webkit-scrollbar-thumb:hover {
                background: var(--kv-border-light);
            }
        </style>
    `;

    document.getElementById('ai-editor-style')?.remove();
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    containerEl = document.getElementById('ai-editor-modal');

    // ============================================================
    // Event Listeners — Chat Tab
    // ============================================================

    // Auto-resize textarea
    const inputEl = containerEl.querySelector('#ai-chat-input');
    inputEl.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });
    
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    containerEl.querySelector('#btn-back').addEventListener('click', () => {
        // Cleanup CodeMirror instances
        if (codeEditorView) { codeEditorView.destroy(); codeEditorView = null; }
        if (codeResultView) { codeResultView.destroy(); codeResultView = null; }
        activeTab = 'chat';
        isProMode = false;

        containerEl.remove();
        document.getElementById('ai-editor-style')?.remove();
        if (window.renderMyDocuments) window.renderMyDocuments();
    });

    containerEl.querySelector('#btn-ai-send').addEventListener('click', handleSend);
    
    // Image generation (pay-per-use)
    containerEl.querySelector('#btn-ai-image').addEventListener('click', handleImageGeneration);
    
    // Video — coming soon
    containerEl.querySelector('#btn-ai-video')?.addEventListener('click', () => {
        if (window.showToast) window.showToast('Video generation is coming soon! Stay tuned. 🎥', false);
    });

    // Buy credits button
    containerEl.querySelector('#btn-buy-credits').addEventListener('click', showCreditShop);

    // Credits display → open shop on click
    containerEl.querySelector('#ai-credits-display').addEventListener('click', showCreditShop);

    // Pro Mode toggle
    containerEl.querySelector('#ai-pro-mode')?.addEventListener('change', (e) => {
        isProMode = e.target.checked;
        const indicator = containerEl.querySelector('#pro-mode-indicator');
        if (indicator) {
            indicator.style.display = isProMode ? 'block' : 'none';
        }
    });

    // Welcome suggestion chips
    containerEl.querySelectorAll('.kv-suggestion-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const prompt = chip.dataset.prompt;
            if (prompt) {
                const inputEl = containerEl.querySelector('#ai-chat-input');
                if (inputEl) {
                    inputEl.value = prompt;
                    inputEl.focus();
                    // Auto-send
                    handleSend();
                }
            }
        });
    });

    // ============================================================
    // Event Listeners — Tab Switching
    // ============================================================

    containerEl.querySelectorAll('.ai-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab; // 'chat' or 'code'
            activeTab = tabName;
            
            // Update tab styles
            containerEl.querySelectorAll('.ai-tab').forEach(t => {
                t.classList.remove('kv-tab-active');
            });
            tab.classList.add('kv-tab-active');
            
            // Show/hide panels
            containerEl.querySelector('#panel-chat').style.display = tabName === 'chat' ? 'flex' : 'none';
            containerEl.querySelector('#panel-code').style.display = tabName === 'code' ? 'flex' : 'none';
            
            // Initialize CodeMirror on first open
            if (tabName === 'code' && !codeEditorView && !codeEditorLoading) {
                const mountEl = containerEl.querySelector('#code-editor-mount');
                const langKey = containerEl.querySelector('#code-lang-select')?.value || 'javascript';
                codeEditorLoading = createCodeEditor(mountEl, '// Write your code here...\n', langKey, false)
                    .then((view) => {
                        // The tool may have been closed while CodeMirror was downloading.
                        if (!mountEl.isConnected) { view.destroy(); return; }
                        codeEditorView = view;
                    })
                    .catch((err) => {
                        console.error('Code editor load failed:', err);
                        if (window.showToast) window.showToast('Could not load the code editor. Check your connection and try again.', true);
                    })
                    .finally(() => { codeEditorLoading = null; });
            }
            
            // Update code credits display
            const codeCreditsEl = containerEl.querySelector('#code-credits-count');
            if (codeCreditsEl) codeCreditsEl.textContent = userCredits.thinking;
        });
    });

    // ============================================================
    // Event Listeners — Code AI Tab
    // ============================================================

    // Language selector change
    containerEl.querySelector('#code-lang-select')?.addEventListener('change', (e) => {
        const langKey = e.target.value;
        if (codeEditorView) {
            switchLanguage(codeEditorView, langKey).catch(err => console.warn('Language load failed:', err));
        }
        // Update status bar
        const statusLang = containerEl.querySelector('#ide-status-lang');
        if (statusLang) statusLang.textContent = CODE_LANGUAGES[langKey]?.name || langKey;
    });

    // Code action buttons
    containerEl.querySelectorAll('.code-action-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            
            // Show/hide convert target selector
            const targetSelect = containerEl.querySelector('#code-target-lang');
            if (action === 'convert') {
                targetSelect.style.display = 'block';
            } else {
                targetSelect.style.display = 'none';
            }
            
            // Show/hide prompt bar for generate
            const promptBar = containerEl.querySelector('#code-prompt-bar');
            if (action === 'generate') {
                promptBar.style.display = 'block';
                containerEl.querySelector('#code-prompt-input')?.focus();
                return; // Don't execute yet, wait for prompt submit
            } else {
                promptBar.style.display = 'none';
            }
            
            handleCodeAction(action);
        });
    });

    // Generate button in prompt bar
    containerEl.querySelector('#btn-code-generate-go')?.addEventListener('click', () => {
        handleCodeAction('generate');
    });

    // Enter in prompt input triggers generate
    containerEl.querySelector('#code-prompt-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleCodeAction('generate');
        }
    });

    // Clear editor
    containerEl.querySelector('#btn-clear-editor')?.addEventListener('click', () => {
        if (codeEditorView) {
            codeEditorView.dispatch({
                changes: { from: 0, to: codeEditorView.state.doc.length, insert: '' }
            });
        }
    });

    // Copy code result
    containerEl.querySelector('#btn-copy-code')?.addEventListener('click', () => {
        if (codeResultView) {
            const code = codeResultView.state.doc.toString();
            navigator.clipboard.writeText(code).then(() => {
                if (window.showToast) window.showToast('Code copied! 📋', false);
            });
        }
    });

    // Download code result
    containerEl.querySelector('#btn-download-code')?.addEventListener('click', () => {
        if (codeResultView) {
            const code = codeResultView.state.doc.toString();
            const langSelect = containerEl.querySelector('#code-lang-select');
            const langKey = langSelect?.value || 'javascript';
            const ext = CODE_LANGUAGES[langKey]?.ext || 'txt';
            
            const blob = new Blob([code], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `kivu-code.${ext}`;
            a.click();
            URL.revokeObjectURL(url);
        }
    });

    // Apply code to editor
    containerEl.querySelector('#btn-apply-code')?.addEventListener('click', () => {
        if (codeResultView && codeEditorView) {
            const code = codeResultView.state.doc.toString();
            codeEditorView.dispatch({
                changes: { from: 0, to: codeEditorView.state.doc.length, insert: code }
            });
            if (window.showToast) window.showToast('Code applied to editor! 📥', false);
        }
    });

    // ---- Resizable split pane ----
    const resizer = containerEl.querySelector('#ide-resizer');
    if (resizer) {
        let isResizing = false;
        const splitView = containerEl.querySelector('#code-split-view');
        const leftPanel = splitView?.querySelector('.kv-ide-panel-left');
        const rightPanel = splitView?.querySelector('.kv-ide-panel-right');

        // Pointer events cover touch and mouse; move/up listeners live only for
        // the duration of a drag so reopening the tool never stacks handlers.
        const onMove = (e) => {
            if (!isResizing || !splitView || !leftPanel || !rightPanel) return;
            const rect = splitView.getBoundingClientRect();
            const percent = ((e.clientX - rect.left) / rect.width) * 100;
            const clamped = Math.min(Math.max(percent, 20), 80);
            leftPanel.style.flex = 'none';
            leftPanel.style.width = clamped + '%';
            rightPanel.style.flex = '1';
        };
        const onUp = () => {
            isResizing = false;
            resizer.classList.remove('kv-dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
        };
        resizer.style.touchAction = 'none';
        resizer.addEventListener('pointerdown', (e) => {
            isResizing = true;
            resizer.classList.add('kv-dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    // ============================================================
    // Load data
    // ============================================================

    // Load credit balances & usage count in background
    loadUserCredits();
    loadUsageCount();

    // Load chat history
    if (docId) {
        try {
            const data = localStorage.getItem(AI_STORAGE_KEY + docId);
            if (data) {
                const parsed = JSON.parse(data);
                containerEl.querySelector('#ai-doc-title').value = parsed.title || 'Kivu AI Chat';
                if (parsed.messages && Array.isArray(parsed.messages)) {
                    // Remove welcome msg
                    containerEl.querySelector('#ai-chat-messages').innerHTML = '';
                    parsed.messages.forEach(msg => {
                        appendMessage(msg.role, msg.content);
                    });
                }
            }
        } catch (e) {
            console.error(e);
        }
    }
}

async function loadUsageCount() {
    try {
        if (window.sb && window.sb.auth && typeof window.sb.auth.getUser === 'function') {
            const userRes = await window.sb.auth.getUser();
            const user = userRes?.data?.user;
            if (user) {
                const { data: limitsData } = await window.sb
                    .from('user_ai_limits')
                    .select('message_count, last_message_date')
                    .eq('user_id', user.id)
                    .single();
                
                const today = new Date().toISOString().split('T')[0];
                if (limitsData && limitsData.last_message_date === today) {
                    const count = limitsData.message_count || 0;
                    const counterEl = containerEl?.querySelector('#ai-usage-counter');
                    if (counterEl) counterEl.textContent = `${count}/${DAILY_LIMIT} msg used`;
                }
            }
        }
    } catch (e) {}
}
