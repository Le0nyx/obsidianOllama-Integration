const { Plugin, Notice, ItemView, PluginSettingTab, Setting, TFolder, MarkdownRenderer } = require('obsidian');

// Constants
const VIEW_TYPE_OLLAMA = 'ollama-side-view';

const VAULT_BROWSE_MAX_FILES = 40;
const VAULT_BROWSE_MAX_LINKED_FILES = 5;
const VAULT_BROWSE_MAX_RELATED_FILES = 5;
const VAULT_BROWSE_MAX_RELATED_SCAN = 400;
const VAULT_BROWSE_MAX_FILE_CHARS = 2000;
const VAULT_BROWSE_MAX_CONTENT_SCAN = 80;
const VAULT_BROWSE_MAX_CONTENT_SCAN_CHARS = 20000;
const VAULT_BROWSE_MAX_DAILY_NOTES = 2;
const VAULT_BROWSE_MAX_TOTAL_CHARS = 8000;
const VAULT_BROWSE_MAX_TOKEN_SOURCE_CHARS = 4000;
const VAULT_BROWSE_MAX_TOKENS = 30;
const VAULT_BROWSE_RELATED_MIN_SCORE = 1;
const VAULT_BROWSE_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'your', 'you', 'are', 'was', 'were',
    'not', 'but', 'can', 'could', 'should', 'would', 'have', 'has', 'had', 'will', 'what', 'when', 'where', 'who',
    'how', 'why', 'its', 'our', 'their', 'them', 'they', 'then', 'than', 'too', 'also', 'just', 'like', 'some',
    'more', 'most', 'less', 'very', 'only', 'over', 'under', 'such', 'each', 'all', 'any'
]);

const CHAT_MEMORY_BLOCK_REGEX = /<!--\s*ollama-memory:start[\s\S]*?ollama-memory:end\s*-->/i;
const CHAT_MEMORY_MAX_MESSAGE_CHARS = 2000;

const DEFAULT_SETTINGS = {
    ollamaUrl: 'http://localhost:11434',
    defaultModel: '---',
    temperature: 0.7,
    maxTokens: -1,
    chatHistoryPath: 'Ollama Chats/',
    includeNoteContext: true,
    customInstructions: '',
    enableVaultBrowse: false,
    enableChatMemory: true,
    chatMemoryMaxChars: 3000,
    chatMemoryRecentTurns: 4,
    chatMemorySummaryTemperature: 0.2,
    vaultStructure: ''
};

// OllamaSideView class
class OllamaSideView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.messages = [];
        this.currentChatFile = null;
        this.contextNotePath = null;
        this.chatFiles = [];
        this.abortController = null;
        this.chatMemorySummary = '';
    }

    getViewType() {
        return VIEW_TYPE_OLLAMA;
    }

    getDisplayText() {
        return 'Ollama Chat';
    }

    getIcon() {
        return 'brain-circuit';
    }

    // SVG icon helpers
    _svgIcon(pathD, viewBox = '24') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `0 0 ${viewBox} ${viewBox}`);
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        // Support multiple path definitions
        const paths = Array.isArray(pathD) ? pathD : [pathD];
        for (const d of paths) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            svg.appendChild(path);
        }
        return svg;
    }

    _iconButton(container, cls, title, pathD) {
        const btn = container.createEl('button', {
            cls: `ollama-icon-btn ${cls}`,
            attr: { 'aria-label': title, 'title': title }
        });
        btn.appendChild(this._svgIcon(pathD));
        return btn;
    }

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.addClass('ollama-side-container');

        // ── Header ──────────────────────────────────────────
        const header = container.createDiv('ollama-header');
        const headerLeft = header.createDiv('ollama-header-left');
        headerLeft.createEl('h3', { text: 'Ollama Chat' });
        
        const headerRight = header.createDiv('ollama-header-right');
        
        // Chat selector dropdown
        const chatSelectorContainer = headerRight.createDiv('ollama-chat-selector-container');
        
        this.chatSearchInput = chatSelectorContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search chats…',
            cls: 'ollama-chat-search'
        });
        
        this.chatListContainer = chatSelectorContainer.createDiv('ollama-chat-list');
        this.chatListContainer.style.display = 'none';
        
        this.chatSearchInput.addEventListener('focus', () => {
            this.refreshChatList();
            this.chatListContainer.style.display = 'block';
        });
        
        this.chatSearchInput.addEventListener('blur', () => {
            setTimeout(() => {
                this.chatListContainer.style.display = 'none';
            }, 200);
        });
        
        this.chatSearchInput.addEventListener('input', () => {
            this.filterChatList(this.chatSearchInput.value);
        });
        
        // Open in new tab (icon: external-link)
        this.openInTabButton = this._iconButton(headerRight, '', 'Open in new tab',
            ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3']);
        this.openInTabButton.style.display = 'none';
        this.openInTabButton.addEventListener('click', async () => {
            if (this.currentChatFile) {
                const file = this.app.vault.getAbstractFileByPath(this.currentChatFile);
                if (file) {
                    const leaf = this.app.workspace.getLeaf('tab');
                    await leaf.openFile(file);
                } else {
                    new Notice('Chat file not found');
                }
            }
        });
        
        // New chat (icon: plus)
        const newChatButton = this._iconButton(headerRight, 'ollama-icon-btn--accent', 'New Chat',
            ['M12 5v14', 'M5 12h14']);
        newChatButton.addEventListener('click', () => {
            this.createNewChat();
        });

        // ── Controls (compact single row) ───────────────────
        const controlsSection = container.createDiv('ollama-controls-section');
        
        // Status dot
        const statusContainer = controlsSection.createDiv('ollama-status-container');
        this.statusDot = statusContainer.createDiv('ollama-status-dot');
        this.statusLabel = statusContainer.createSpan({ cls: 'ollama-status-label' });
        this.updateStatusIndicator();

        controlsSection.createDiv('ollama-controls-sep');

        // Model selector
        const modelContainer = controlsSection.createDiv('ollama-model-container');
        modelContainer.createSpan({ text: 'Model' });
        
        this.modelSelect = modelContainer.createEl('select', { cls: 'ollama-model-select' });
        this.populateModelDropdown();
        
        this.modelSelect.addEventListener('change', () => {
            this.userSelectedModel = this.modelSelect.value;
        });

        // Refresh models (icon: refresh-cw)
        const refreshButton = this._iconButton(modelContainer, '', 'Refresh models',
            ['M23 4v6h-6', 'M1 20v-6h6', 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10', 'M20.49 15a9 9 0 0 1-14.85 3.36L1 14']);
        refreshButton.addEventListener('click', async () => {
            await this.plugin.refreshAvailableModels();
            this.populateModelDropdown();
            new Notice('Models refreshed');
        });

        controlsSection.createDiv('ollama-controls-sep');

        // Vault browse toggle
        const vaultBrowseContainer = controlsSection.createDiv('ollama-vault-browse-container');
        vaultBrowseContainer.createSpan({ text: 'Vault' });

        this.vaultBrowseToggle = vaultBrowseContainer.createEl('button', {
            cls: 'ollama-vault-browse-toggle',
            attr: { 'aria-label': 'Toggle vault browsing', 'title': 'Include related vault files as context' }
        });

        this.vaultBrowseToggle.addEventListener('click', async () => {
            this.plugin.settings.enableVaultBrowse = !this.plugin.settings.enableVaultBrowse;
            await this.plugin.saveSettings();
            this.updateVaultBrowseToggle();
            this.updateContextIndicator();
        });

        // ── Context indicator ───────────────────────────────
        this.contextIndicator = container.createDiv('ollama-context-indicator');
        this.updateContextIndicator();

        // ── Messages area ───────────────────────────────────
        this.outputElement = container.createDiv('ollama-output');

        // ── Input area ──────────────────────────────────────
        const inputContainer = container.createDiv('ollama-input-container');
        
        const inputRow = inputContainer.createDiv('ollama-input-row');
        
        this.inputElement = inputRow.createEl('textarea', {
            placeholder: 'Message… (Shift+Enter for new line)',
            cls: 'ollama-textarea'
        });
        this.inputElement.rows = 2;
        this.inputElement.disabled = !this.plugin.isOllamaRunning;

        this.inputElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.sendMessage();
            }
        });

        // Auto-resize textarea
        this.inputElement.addEventListener('input', () => {
            this.inputElement.style.height = 'auto';
            this.inputElement.style.height = Math.min(this.inputElement.scrollHeight, 140) + 'px';
        });

        // Send button (icon: send/arrow-up)
        this.sendButton = inputRow.createEl('button', {
            cls: 'ollama-send-btn',
            attr: { 'aria-label': 'Send message', 'title': 'Send' }
        });
        this.sendButton.appendChild(this._svgIcon(['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z']));
        this.sendButton.disabled = !this.plugin.isOllamaRunning;
        this.sendButton.addEventListener('click', () => {
            this.sendMessage();
        });

        // Interrupt button (icon: square/stop)
        this.interruptButton = inputContainer.createEl('button', {
            cls: 'ollama-interrupt-button',
            attr: { 'aria-label': 'Stop generation', 'title': 'Stop generation' }
        });
        this.interruptButton.appendChild(this._svgIcon('M6 6h12v12H6z'));
        this.interruptButton.insertAdjacentText('beforeend', ' Stop');
        this.interruptButton.style.display = 'none';
        this.interruptButton.addEventListener('click', () => {
            this.interruptGeneration();
        });

        this.updateUI();
        await this.refreshChatList();
        
        // Start automatic status checking
        this.startStatusChecking();

        // Update context indicator when user switches notes
        this._leafChangeRef = this.app.workspace.on('active-leaf-change', () => {
            this.updateContextIndicator();
        });
    }

    updateContextIndicator() {
        this.contextIndicator.empty();

        // Note context
        const noteRow = this.contextIndicator.createDiv('ollama-context-row');
        if (this.plugin.settings.includeNoteContext) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile && activeFile.extension === 'md') {
                this.contextNotePath = activeFile.path;
                noteRow.createSpan({ 
                    text: `📝 ${activeFile.basename}`,
                    cls: 'ollama-context-text ollama-context-active'
                });
            } else {
                this.contextNotePath = null;
                noteRow.createSpan({ 
                    text: '📝 No note',
                    cls: 'ollama-context-text ollama-context-none'
                });
            }
        } else {
            noteRow.createSpan({
                text: '📝 Off',
                cls: 'ollama-context-text ollama-context-none'
            });
        }

        // Vault browse
        const browseRow = this.contextIndicator.createDiv('ollama-context-row');
        browseRow.createSpan({
            text: this.plugin.settings.enableVaultBrowse ? '🔍 Vault' : '🔍 Off',
            cls: this.plugin.settings.enableVaultBrowse ? 'ollama-context-text ollama-context-active' : 'ollama-context-text ollama-context-none'
        });

        // Memory
        const memoryRow = this.contextIndicator.createDiv('ollama-context-row');
        memoryRow.createSpan({
            text: this.plugin.settings.enableChatMemory ? '🧠 Memory' : '🧠 Off',
            cls: this.plugin.settings.enableChatMemory ? 'ollama-context-text ollama-context-active' : 'ollama-context-text ollama-context-none'
        });
    }

    startStatusChecking() {
        // Check immediately
        this.checkStatus();
        
        // Then check every 5 seconds
        this.statusCheckInterval = window.setInterval(() => {
            this.checkStatus();
        }, 5000);
    }

    stopStatusChecking() {
        if (this.statusCheckInterval) {
            window.clearInterval(this.statusCheckInterval);
            this.statusCheckInterval = null;
        }
    }

    async checkStatus() {
        const wasRunning = this.plugin.isOllamaRunning;
        await this.plugin.checkOllamaStatus();
        
        if (wasRunning !== this.plugin.isOllamaRunning) {
            // Status changed — full UI refresh
            if (this.plugin.isOllamaRunning) {
                await this.plugin.refreshAvailableModels();
            }
            this.updateUI();
        } else if (this.plugin.isOllamaRunning) {
            // Still running — refresh models silently
            await this.plugin.refreshAvailableModels();
            this.populateModelDropdown();
        }
    }

    async refreshChatList() {
        this.chatFiles = await this.listChatFiles();
        this.renderChatList(this.chatFiles);
    }

    async listChatFiles() {
        const files = [];
        // Normalize path - replace backslashes with forward slashes, trim trailing slash
        const basePath = this.plugin.settings.chatHistoryPath
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
        
        const folder = this.app.vault.getAbstractFileByPath(basePath);
        if (!folder || !(folder instanceof TFolder)) {
            return files;
        }
        
        const collectFiles = (folder) => {
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    collectFiles(child);
                } else if (child.extension === 'md') {
                    files.push({
                        path: child.path,
                        name: child.basename,
                        mtime: child.stat?.mtime || 0
                    });
                }
            }
        };
        
        collectFiles(folder);
        
        // Sort by modification time, newest first
        files.sort((a, b) => b.mtime - a.mtime);
        return files;
    }

    renderChatList(files) {
        this.chatListContainer.empty();
        
        if (files.length === 0) {
            this.chatListContainer.createDiv({
                text: 'No chat history',
                cls: 'ollama-chat-item ollama-chat-item-empty'
            });
            return;
        }
        
        for (const file of files.slice(0, 50)) { // Limit to 50 for performance
            const item = this.chatListContainer.createDiv({
                cls: 'ollama-chat-item'
            });
            item.createSpan({ text: file.name });
            item.addEventListener('click', () => {
                this.loadChat(file.path);
                this.chatSearchInput.value = file.name;
                this.chatListContainer.style.display = 'none';
            });
        }
    }

    filterChatList(query) {
        const lowerQuery = query.toLowerCase();
        const filtered = this.chatFiles.filter(f => 
            f.name.toLowerCase().includes(lowerQuery)
        );
        this.renderChatList(filtered);
    }

    async createNewChat() {
        // Auto-save current chat if it has messages
        if (this.messages.length > 0) {
            await this.saveCurrentChat();
        }
        
        // Clear state
        this.messages = [];
        this.currentChatFile = null;
        this.contextNotePath = null;
        this.chatMemorySummary = '';
        this.outputElement.empty();
        this.chatSearchInput.value = '';
        this.openInTabButton.style.display = 'none';
        this.updateContextIndicator();
        
        // Ensure scrolled to top for new chat
        this.outputElement.scrollTop = 0;
        
        new Notice('New chat started');
    }

    generateChatFilename() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');
        
        const timestamp = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
        const monthFolder = `${year}-${month}`;
        
        // Get first few words from first user message
        let slug = 'chat';
        const firstUserMsg = this.messages.find(m => m.role === 'user');
        if (firstUserMsg) {
            slug = firstUserMsg.content
                .substring(0, 40)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '') || 'chat';
        }
        
        // Normalize path - replace backslashes with forward slashes, trim trailing slash
        const basePath = this.plugin.settings.chatHistoryPath
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
        
        return `${basePath}/${monthFolder}/${timestamp}_${slug}.md`;
    }

    async saveCurrentChat() {
        if (this.messages.length === 0) return;
        
        const filePath = this.currentChatFile || this.generateChatFilename();
        
        // Ensure month folder exists
        const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            try {
                await this.app.vault.createFolder(folderPath);
            } catch (e) {
                // Folder might already exist
            }
        }
        
        // Build frontmatter with richer metadata
        const now = new Date().toISOString();
        const firstUserMsg = this.messages.find(m => m.role === 'user');
        const title = firstUserMsg 
            ? firstUserMsg.content.substring(0, 60).replace(/\n/g, ' ')
            : 'Ollama Chat';
        const modelName = this.modelSelect?.value || this.plugin.settings.defaultModel;
        const turnCount = this.messages.filter(m => m.role === 'user').length;
        
        let frontmatter = `---
title: "${title.replace(/"/g, '\\"')}"
createdAt: ${this.currentChatFile ? '' : now}
updatedAt: ${now}
model: "${modelName}"
turns: ${turnCount}
memory: ${this.plugin.settings.enableChatMemory ? 'true' : 'false'}
vaultBrowse: ${this.plugin.settings.enableVaultBrowse ? 'true' : 'false'}`;
        
        if (this.contextNotePath) {
            frontmatter += `\ncontextNote: "[[${this.contextNotePath}]]"`;
        }
        
        frontmatter += '\n---\n\n';
        
        // Build message content with model attribution
        let content = frontmatter;

        const memoryBlock = this.buildChatMemoryBlock(this.chatMemorySummary);
        if (memoryBlock) {
            content += memoryBlock + '\n\n';
        }

        for (const msg of this.messages) {
            if (msg.role === 'user') {
                content += `## You\n${msg.content}\n\n`;
            } else {
                content += `## Ollama (${modelName})\n${msg.content}\n\n`;
            }
        }
        
        // Save or update file
        const existingFile = this.app.vault.getAbstractFileByPath(filePath);
        if (existingFile) {
            await this.app.vault.modify(existingFile, content);
        } else {
            await this.app.vault.create(filePath, content);
            this.currentChatFile = filePath;
            if (this.openInTabButton) this.openInTabButton.style.display = 'inline-block';
            // Push new file to front of cached list instead of full rescan
            const basename = filePath.substring(filePath.lastIndexOf('/') + 1).replace('.md', '');
            this.chatFiles.unshift({ path: filePath, name: basename, mtime: Date.now() });
        }
    }

    async loadChat(filePath) {
        try {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!file) {
                new Notice('Chat file not found');
                return;
            }
            
            const content = await this.app.vault.read(file);
            
            // Parse frontmatter
            const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
            let bodyContent = content;
            if (frontmatterMatch) {
                bodyContent = content.substring(frontmatterMatch[0].length);
                
                // Extract context note if present
                const contextMatch = frontmatterMatch[1].match(/contextNote:\s*"\[\[(.*?)\]\]"/);
                if (contextMatch) {
                    this.contextNotePath = contextMatch[1];
                }
            }

            const memoryExtract = this.extractChatMemoryBlock(bodyContent);
            this.chatMemorySummary = memoryExtract.summary;
            bodyContent = memoryExtract.bodyContent;
            
            // Parse messages
            this.messages = [];
            const messageBlocks = bodyContent.split(/^## /m).filter(b => b.trim());
            
            for (const block of messageBlocks) {
                const lines = block.split('\n');
                const roleText = lines[0].trim().toLowerCase();
                const messageContent = lines.slice(1).join('\n').trim();
                
                if (roleText === 'you') {
                    this.messages.push({ role: 'user', content: messageContent });
                } else if (roleText === 'ollama' || roleText.startsWith('ollama')) {
                    this.messages.push({ role: 'assistant', content: messageContent });
                }
            }
            
            // Render messages
            this.outputElement.empty();
            for (const msg of this.messages) {
                await this.renderMessage(msg.role, msg.content);
            }
            
            // Scroll to bottom after loading all messages
            this.scrollToBottom();
            
            this.currentChatFile = filePath;
            this.openInTabButton.style.display = 'inline-block';
            this.updateContextIndicator();
            
            new Notice(`Loaded chat: ${file.basename}`);
        } catch (error) {
            new Notice(`Failed to load chat: ${error.message}`);
        }
    }

    updateUI() {
        const isRunning = this.plugin.isOllamaRunning;
        
        this.updateStatusIndicator();
        
        this.inputElement.disabled = !isRunning;
        if (this.sendButton) this.sendButton.disabled = !isRunning;
        
        if (isRunning) {
            this.populateModelDropdown();
        } else {
            this.modelSelect.empty();
            const option = this.modelSelect.createEl('option');
            option.value = '';
            option.text = 'No models available';
        }
        
        this.updateContextIndicator();
        this.updateVaultBrowseToggle();
    }

    updateVaultBrowseToggle() {
        if (!this.vaultBrowseToggle) return;

        const enabled = this.plugin.settings.enableVaultBrowse;
        this.vaultBrowseToggle.setText(enabled ? 'On' : 'Off');
        this.vaultBrowseToggle.removeClass('is-enabled', 'is-disabled');
        this.vaultBrowseToggle.addClass(enabled ? 'is-enabled' : 'is-disabled');
    }

    updateStatusIndicator() {
        if (!this.statusDot || !this.statusLabel) return;
        const running = this.plugin.isOllamaRunning;
        this.statusDot.className = 'ollama-status-dot ' + (running ? 'ollama-status-dot--running' : 'ollama-status-dot--stopped');
        this.statusLabel.setText(running ? 'Running' : 'Stopped');
    }

    populateModelDropdown() {
        // Remember current selection
        const currentSelection = this.modelSelect.value || this.userSelectedModel;
        
        this.modelSelect.empty();
        
        if (this.plugin.availableModels.length === 0) {
            const option = this.modelSelect.createEl('option');
            option.value = '';
            option.text = 'Loading models...';
            return;
        }

        this.plugin.availableModels.forEach(model => {
            const option = this.modelSelect.createEl('option');
            option.value = model;
            option.text = model;
        });

        // Priority: user's selected model > current selection > default model > first available
        const preferredModel = this.userSelectedModel || currentSelection || this.plugin.settings.defaultModel;
        
        if (preferredModel && this.plugin.availableModels.includes(preferredModel)) {
            this.modelSelect.value = preferredModel;
        } else if (this.plugin.availableModels.length > 0) {
            this.modelSelect.value = this.plugin.availableModels[0];
        }
    }

    async sendMessage() {
        if (!this.plugin.isOllamaRunning) {
            new Notice('Ollama service is not running');
            return;
        }

        const message = this.inputElement.value.trim();
        if (!message) return;

        // Update context before sending
        this.updateContextIndicator();

        this.messages.push({ role: 'user', content: message });
        await this.renderMessage('user', message);
        this.inputElement.value = '';
        this.inputElement.disabled = true;
        if (this.sendButton) this.sendButton.disabled = true;
        this.interruptButton.style.display = 'inline-block';

        // Create bubble for streaming response
        const responseDiv = this.outputElement.createDiv('ollama-message ollama-assistant');
        const bubble = responseDiv.createDiv('ollama-bubble');
        
        const headerDiv = bubble.createDiv('ollama-message-header');
        headerDiv.createSpan({ text: 'Ollama', cls: 'ollama-role' });
        
        const copyButton = this._createCopyButton(headerDiv);
        
        const contentDiv = bubble.createDiv('ollama-content');

        try {
            const selectedModel = this.modelSelect.value || this.plugin.settings.defaultModel;
            
            let aiSearchQueries = [];
            if (this.plugin.settings.enableVaultBrowse) {
                contentDiv.setText('Thinking & searching vault...');
                contentDiv.addClass('ollama-searching-state');
                aiSearchQueries = await this.generateSearchQueries(message, selectedModel, this.plugin.settings.vaultStructure);
                contentDiv.empty();
                contentDiv.removeClass('ollama-searching-state');
            }
            
            const response = await this.callOllamaStreaming(message, selectedModel, contentDiv, aiSearchQueries);
            this.messages.push({ role: 'assistant', content: response });

            // Fire-and-forget: update memory in background so input re-enables immediately
            if (this.plugin.settings.enableChatMemory) {
                this.updateChatMemorySummary(message, response, selectedModel).catch(e => {
                    console.warn('Background memory summary failed:', e);
                });
            }
            
            // Setup copy button handler after response is complete
            this.setupCopyButton(copyButton, response);
            
            // Auto-save after each exchange
            await this.saveCurrentChat();
        } catch (error) {
            if (error.name !== 'AbortError') {
                contentDiv.setText(`Error: ${error.message}`);
                this.messages.push({ role: 'assistant', content: `Error: ${error.message}` });
            } else {
                // Generation was interrupted
                const partialResponse = contentDiv.textContent || '';
                if (partialResponse) {
                    this.messages.push({ role: 'assistant', content: partialResponse + '\n\n[Generation interrupted]' });
                    contentDiv.empty();
                    await MarkdownRenderer.renderMarkdown(
                        partialResponse + '\n\n[Generation interrupted]',
                        contentDiv,
                        '',
                        this
                    );
                } else {
                    contentDiv.setText('[Generation interrupted]');
                }
                new Notice('Generation interrupted');
            }
        } finally {
            this.inputElement.disabled = false;
            this.interruptButton.style.display = 'none';
            if (this.sendButton) this.sendButton.disabled = false;
            this.inputElement.focus();
        }
    }

    async callOllamaStreaming(prompt, model, contentDiv, aiSearchQueries = []) {
        const ollamaUrl = this.plugin.settings.ollamaUrl;
        
        // Build prompt with context
        const fullPrompt = await this.buildPrompt(prompt, aiSearchQueries);
        
        // Build options - only include num_predict if it's a positive value
        const options = {
            temperature: this.plugin.settings.temperature
        };
        
        // Only set num_predict if user specified a positive limit
        // -1 or 0 means unlimited (let model decide)
        if (this.plugin.settings.maxTokens > 0) {
            options.num_predict = this.plugin.settings.maxTokens;
        }
        
        const systemPrompt = "You are a helpful AI assistant integrated directly into Obsidian. The user has provided context from their notes and chat history in the prompt. You MUST treat this provided text as their local files and screen. NEVER claim you cannot see their files or screen, because the file contents have been explicitly provided to you.";

        const requestBody = {
            model: model,
            prompt: fullPrompt,
            system: systemPrompt,
            stream: true,
            options: options
        };

        this.abortController = new AbortController();

        const response = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
            signal: this.abortController.signal
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status}`);
        }

        // Handle streaming response — plain text during stream for speed
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        contentDiv.addClass('ollama-streaming-cursor');

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim());

            for (const line of lines) {
                try {
                    const json = JSON.parse(line);
                    if (json.response) {
                        fullResponse += json.response;
                        // Plain text update — no DOM teardown/rebuild
                        contentDiv.textContent = fullResponse;
                        this.scrollToBottom();
                    }
                } catch (e) {
                    // Skip malformed JSON lines
                }
            }
        }

        // Final render: full markdown only once
        contentDiv.removeClass('ollama-streaming-cursor');
        contentDiv.empty();
        await MarkdownRenderer.renderMarkdown(
            fullResponse,
            contentDiv,
            '',
            this
        );
        this.scrollToBottom();

        this.abortController = null;
        return fullResponse;
    }

    async buildPrompt(userPrompt, aiSearchQueries = []) {
        let contextBlock = '';
        
        // Add current date and time so the AI knows what "today" is
        const now = new Date();
        contextBlock += `[SYSTEM INFO]\nCurrent Date and Time: ${now.toLocaleString()}\nToday's Date: ${now.toISOString().split('T')[0]}\nDay of Week: ${now.toLocaleDateString(undefined, {weekday: 'long'})}\n[END SYSTEM INFO]\n\n`;
        
        // Add custom instructions if provided
        if (this.plugin.settings.customInstructions && this.plugin.settings.customInstructions.trim()) {
            contextBlock += `[System Instructions]\n${this.plugin.settings.customInstructions.trim()}\n\n`;
        }

        if (this.plugin.settings.enableChatMemory) {
            if (this.chatMemorySummary && this.chatMemorySummary.trim()) {
                contextBlock += `[Memory Summary]\n${this.chatMemorySummary.trim()}\n\n`;
            }

            const recentTurnsContext = this.buildRecentTurnsContext(userPrompt);
            if (recentTurnsContext) {
                contextBlock += `[Recent Chat History]\n${recentTurnsContext}\n\n`;
            }
        }
        
        const activeFile = this.app.workspace.getActiveFile();
        let activeContent = null;

        if (activeFile && activeFile.extension === 'md' && (this.plugin.settings.includeNoteContext || this.plugin.settings.enableVaultBrowse)) {
            try {
                activeContent = await this.app.vault.read(activeFile);
            } catch (e) {
                activeContent = null;
            }
        }

        // Add note context if enabled
        if (this.plugin.settings.includeNoteContext && activeFile && activeFile.extension === 'md' && activeContent) {
            this.contextNotePath = activeFile.path;
            contextBlock += `[CURRENT ACTIVE FILE: ${activeFile.basename}]\n${activeContent}\n[END OF ACTIVE FILE]\n\n`;
        }

        // Add vault browsing context if enabled
        if (this.plugin.settings.enableVaultBrowse) {
            // Pass recentTurnsContext to vault browse to improve search tokens
            let recentTurnsContext = '';
            if (this.plugin.settings.enableChatMemory) {
                recentTurnsContext = this.buildRecentTurnsContext(userPrompt);
            }
            const vaultContext = await this.buildVaultBrowseContext(activeFile, activeContent, userPrompt, recentTurnsContext, aiSearchQueries);
            if (vaultContext) {
                contextBlock += `[VAULT CONTEXT (Related Files)]\n${vaultContext}\n[END OF VAULT CONTEXT]\n\n`;
            }
        }
        
        if (contextBlock.trim()) {
            return `Here is the provided context from my Obsidian vault:\n\n${contextBlock}\n\nMy Query: ${userPrompt}`;
        }
        
        return userPrompt;
    }

    async buildVaultBrowseContext(activeFile, activeContent, userPrompt, recentTurnsContext = '', aiSearchQueries = []) {
        const contextParts = [];
        const excludedPaths = new Set();

        if (activeFile?.path) {
            excludedPaths.add(activeFile.path);
        }

        const baseFolder = activeFile ? activeFile.parent : this.app.vault.getRoot();
        const basePath = baseFolder ? baseFolder.path : '';
        const prefix = basePath ? `${basePath}/` : '';

        const relativeFiles = this.app.vault.getMarkdownFiles()
            .filter(file => file.path !== activeFile?.path && file.path.startsWith(prefix))
            .slice(0, VAULT_BROWSE_MAX_FILES);

        if (relativeFiles.length > 0) {
            const rootLabel = basePath ? basePath : 'vault root';
            const fileList = relativeFiles.map(file => `- ${file.path}`).join('\n');
            contextParts.push(`Relative files in ${rootLabel}:\n${fileList}`);
        }

        if (this.plugin.settings.vaultStructure && this.plugin.settings.vaultStructure.trim()) {
            contextParts.push(`Vault Structure Overview:\n${this.plugin.settings.vaultStructure.trim()}`);
        }

        const searchTokens = this.buildSearchTokens({
            userPrompt,
            recentTurnsContext,
            activeContent,
            aiSearchQueries,
            activeFile,
            chatMemorySummary: this.chatMemorySummary
        });

        const linkedFiles = this.extractLinkedFiles(activeFile, activeContent)
            .slice(0, VAULT_BROWSE_MAX_LINKED_FILES);

        linkedFiles.forEach(file => excludedPaths.add(file.path));

        let totalChars = 0;

        if (linkedFiles.length > 0) {
            const linkedBlock = await this.buildFileExcerptsBlock(
                linkedFiles,
                'Linked file excerpts',
                searchTokens,
                totalChars
            );

            if (linkedBlock.block) {
                contextParts.push(linkedBlock.block);
            }

            totalChars = linkedBlock.totalChars;
        }

        const backlinkFiles = this.extractBacklinkedFiles(activeFile)
            .filter(file => !excludedPaths.has(file.path))
            .slice(0, VAULT_BROWSE_MAX_LINKED_FILES);

        backlinkFiles.forEach(file => excludedPaths.add(file.path));

        if (backlinkFiles.length > 0) {
            const backlinkBlock = await this.buildFileExcerptsBlock(
                backlinkFiles,
                'Backlinked note excerpts',
                searchTokens,
                totalChars
            );

            if (backlinkBlock.block) {
                contextParts.push(backlinkBlock.block);
            }

            totalChars = backlinkBlock.totalChars;
        }

        const wantsDailyNotes = this.shouldIncludeDailyNotes(userPrompt, recentTurnsContext, aiSearchQueries);
        if (wantsDailyNotes) {
            const dailyNoteFiles = this.findDailyNoteCandidates(searchTokens, activeFile, excludedPaths)
                .slice(0, VAULT_BROWSE_MAX_DAILY_NOTES);

            dailyNoteFiles.forEach(file => excludedPaths.add(file.path));

            if (dailyNoteFiles.length > 0) {
                const dailyBlock = await this.buildFileExcerptsBlock(
                    dailyNoteFiles,
                    'Daily note excerpts',
                    searchTokens,
                    totalChars
                );

                if (dailyBlock.block) {
                    contextParts.push(dailyBlock.block);
                }

                totalChars = dailyBlock.totalChars;
            }
        }

        const relatedFiles = await this.findRelatedFiles(activeFile, searchTokens, excludedPaths);

        if (relatedFiles.length > 0 && totalChars < VAULT_BROWSE_MAX_TOTAL_CHARS) {
            const relatedBlock = await this.buildFileExcerptsBlock(
                relatedFiles,
                'Related note excerpts',
                searchTokens,
                totalChars
            );

            if (relatedBlock.block) {
                contextParts.push(relatedBlock.block);
            }

            totalChars = relatedBlock.totalChars;
        }

        if (contextParts.length === 0) return '';

        return `Vault context:\n\n${contextParts.join('\n\n')}\n\n---\n\n`;
    }

    buildSearchTokens({ userPrompt, recentTurnsContext, activeContent, aiSearchQueries, activeFile, chatMemorySummary }) {
        const tokens = [];

        if (Array.isArray(aiSearchQueries) && aiSearchQueries.length > 0) {
            this.appendSearchTokens(tokens, aiSearchQueries.join(' '));
        }

        this.appendSearchTokens(tokens, userPrompt || '');
        this.appendSearchTokens(tokens, recentTurnsContext || '');
        this.appendSearchTokens(tokens, chatMemorySummary || '');

        if (activeFile?.basename) {
            this.appendSearchTokens(tokens, activeFile.basename);
        }

        if (activeContent) {
            this.appendSearchTokens(tokens, activeContent.substring(0, VAULT_BROWSE_MAX_TOKEN_SOURCE_CHARS));
        }

        return tokens;
    }

    shouldIncludeDailyNotes(userPrompt, recentTurnsContext, aiSearchQueries = []) {
        const combined = [userPrompt || '', recentTurnsContext || '', aiSearchQueries.join(' ')].join(' ').toLowerCase();
        return (
            combined.includes('daily note') ||
            combined.includes('daily recap') ||
            combined.includes('journal') ||
            combined.includes('today') ||
            combined.includes('yesterday')
        );
    }

    findDailyNoteCandidates(searchTokens, activeFile, excludedPaths) {
        const dateTokens = this.extractDateTokens(searchTokens);
        if (dateTokens.length === 0) return [];

        const files = this.app.vault.getMarkdownFiles();
        const candidates = [];

        for (const file of files) {
            if (excludedPaths?.has(file.path)) continue;
            if (activeFile && file.path === activeFile.path) continue;

            const lowerPath = file.path.toLowerCase();
            const lowerBase = file.basename.toLowerCase();
            let score = 0;

            for (const token of dateTokens) {
                const lowerToken = token.toLowerCase();
                if (lowerBase === lowerToken) score += 5;
                if (lowerPath.includes(lowerToken)) score += 2;
            }

            if (lowerPath.includes('/daily') || lowerPath.includes('daily ')) score += 1;
            if (lowerPath.includes('/journal') || lowerPath.includes('journal ')) score += 1;

            if (score > 0) {
                candidates.push({ file, score });
            }
        }

        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (b.file.stat?.mtime || 0) - (a.file.stat?.mtime || 0);
        });

        return candidates.map(item => item.file);
    }

    extractDateTokens(tokens) {
        if (!tokens || tokens.length === 0) return [];

        const dateMatches = [];
        const patterns = [
            /^\d{4}[-_.]\d{2}[-_.]\d{2}$/,
            /^\d{2}[-.]\d{2}[-.]\d{4}$/,
            /^\d{8}$/
        ];

        for (const token of tokens) {
            if (patterns.some(pattern => pattern.test(token))) {
                dateMatches.push(token);
            }
        }

        return dateMatches;
    }

    appendSearchTokens(targetTokens, sourceText) {
        if (!sourceText || !sourceText.trim()) return targetTokens;

        const extraTokens = this.extractSearchTokens(sourceText);
        if (extraTokens.length === 0) return targetTokens;

        const seen = new Set(targetTokens);
        for (const token of extraTokens) {
            if (targetTokens.length >= VAULT_BROWSE_MAX_TOKENS) break;
            if (!seen.has(token)) {
                seen.add(token);
                targetTokens.push(token);
            }
        }

        return targetTokens;
    }

    async readVaultFile(file) {
        if (this.app.vault.cachedRead) {
            return await this.app.vault.cachedRead(file);
        }
        return await this.app.vault.read(file);
    }

    async buildFileExcerptsBlock(files, heading, searchTokens, totalChars) {
        if (!files || files.length === 0 || totalChars >= VAULT_BROWSE_MAX_TOTAL_CHARS) {
            return { block: '', totalChars };
        }

        // Parallel reads for speed
        const readResults = await Promise.allSettled(
            files.map(file => this.readVaultFile(file).then(content => ({ file, content })))
        );

        let contentBlock = `${heading}:\n`;

        for (const result of readResults) {
            if (totalChars >= VAULT_BROWSE_MAX_TOTAL_CHARS) break;
            if (result.status !== 'fulfilled') continue;

            const { file, content } = result.value;
            let trimmed = this.getBestExcerpt(content, searchTokens);

            if (trimmed.length > VAULT_BROWSE_MAX_FILE_CHARS) {
                trimmed = trimmed.substring(0, VAULT_BROWSE_MAX_FILE_CHARS) + '\n...[truncated]';
            }

            if (totalChars + trimmed.length > VAULT_BROWSE_MAX_TOTAL_CHARS) {
                const remaining = Math.max(VAULT_BROWSE_MAX_TOTAL_CHARS - totalChars, 0);
                trimmed = trimmed.substring(0, remaining) + '\n...[truncated]';
            }

            totalChars += trimmed.length;
            contentBlock += `\n### ${file.path}\n${trimmed}\n`;
        }

        return { block: contentBlock.trim(), totalChars };
    }

    getBestExcerpt(content, searchTokens) {
        if (!content) return '';

        if (!searchTokens || searchTokens.length === 0) {
            return content;
        }

        const windowSize = VAULT_BROWSE_MAX_FILE_CHARS;
        if (content.length <= windowSize) {
            return content;
        }

        // Sliding window to find max density of search tokens
        let bestStart = 0;
        let maxScore = -1;
        
        // Convert tokens to regexes
        const regexes = searchTokens.map(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'));
        
        // Find all matches
        const matches = [];
        for (let i = 0; i < regexes.length; i++) {
            const regex = regexes[i];
            let match;
            while ((match = regex.exec(content)) !== null) {
                matches.push({ index: match.index, tokenIndex: i });
            }
        }
        
        if (matches.length === 0) {
            return content.substring(0, windowSize) + '\n...[truncated]';
        }
        
        // Sort matches by index
        matches.sort((a, b) => a.index - b.index);
        
        // Slide a window of `windowSize` over the matches
        for (let i = 0; i < matches.length; i++) {
            const windowStart = Math.max(0, matches[i].index - Math.floor(windowSize * 0.1));
            const windowEnd = windowStart + windowSize;
            
            const seenTokens = new Set();
            let totalHits = 0;
            
            for (let j = i; j < matches.length; j++) {
                if (matches[j].index > windowEnd) break;
                seenTokens.add(matches[j].tokenIndex);
                totalHits += 1;
            }
            
            const score = seenTokens.size * 10 + totalHits;
            
            if (score > maxScore) {
                maxScore = score;
                bestStart = windowStart;
            }
        }

        const start = bestStart;
        const end = Math.min(content.length, start + windowSize);
        let excerpt = content.substring(start, end);

        if (start > 0) {
            excerpt = '...\n' + excerpt;
        }

        if (end < content.length) {
            excerpt += '\n...[truncated]';
        }

        return excerpt;
    }

    extractSearchTokens(sourceText) {
        if (!sourceText) return [];

        const lowerSource = sourceText.toLowerCase();
        const matches = lowerSource.match(/[a-z0-9\-_]{3,}/g) || [];
        const tokens = [];
        const seen = new Set();
        
        // Smart Date Injection for daily notes
        const now = new Date();
        const injectDateFormats = (dateObj) => {
            const y = dateObj.getFullYear();
            const m = String(dateObj.getMonth() + 1).padStart(2, '0');
            const d = String(dateObj.getDate()).padStart(2, '0');
            const formats = [
                `${y}-${m}-${d}`, `${y}${m}${d}`, `${y}_${m}_${d}`,
                `${d}-${m}-${y}`, `${d}.${m}.${y}`, `${y}.${m}.${d}`
            ];
            for (const format of formats) {
                if (!seen.has(format)) {
                    seen.add(format);
                    tokens.push(format);
                }
            }
        };

        if (lowerSource.includes('today') || lowerSource.includes('daily note') || lowerSource.includes('daily recap')) {
            injectDateFormats(now);
        }
        if (lowerSource.includes('yesterday')) {
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            injectDateFormats(yesterday);
        }

        for (const word of matches) {
            if (tokens.length >= VAULT_BROWSE_MAX_TOKENS) break;
            
            // Clean punctuation from edges
            const cleanWord = word.replace(/^[-_]+|[-_]+$/g, '');
            if (cleanWord.length < 3) continue;
            
            if (VAULT_BROWSE_STOPWORDS.has(cleanWord)) continue;
            if (seen.has(cleanWord)) continue;
            seen.add(cleanWord);
            tokens.push(cleanWord);
        }

        return tokens;
    }

    async generateSearchQueries(userPrompt, model, vaultStructure) {
        if (!this.plugin.settings.enableVaultBrowse) return [];

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        const systemPrompt = `You are an internal search query generator for an Obsidian vault.
The user is asking a question. To help answer it, you must decide which files to search for.
Today's Date is: ${dateStr}
Vault Structure Overview:
${vaultStructure || 'Not provided'}

Identify up to 3 specific file names, folder paths, or exact search phrases you want to look up based on the user's query.
Return ONLY a JSON array of strings. Do not include markdown formatting or explanations.
User Query: "${userPrompt}"
Example response: ["Project Proposal", "daily recap", "meeting notes"]`;

        try {
            const response = await fetch(`${this.plugin.settings.ollamaUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    prompt: systemPrompt,
                    stream: false,
                    options: { temperature: 0.1, num_predict: 50 }
                })
            });

            if (response.ok) {
                const data = await response.json();
                const text = data.response.trim();
                const match = text.match(/\[.*\]/s);
                if (match) {
                    const queries = JSON.parse(match[0]);
                    return Array.isArray(queries) ? queries : [];
                }
            }
        } catch (e) {
            console.error('Failed to generate search queries', e);
        }
        return [];
    }

    getPriorityPathsFromStructure() {
        if (!this.plugin.settings.vaultStructure) return [];

        const structureLines = this.plugin.settings.vaultStructure.split('\n');
        return structureLines
            .filter(line => line.trim().startsWith('- ') || line.trim().startsWith('* '))
            .map(line => {
                let p = line.replace(/^[-*]\s+/, '').trim();

                const containsIndex = p.indexOf(' (Contains');
                if (containsIndex !== -1) {
                    p = p.substring(0, containsIndex).trim();
                }

                const descIndex = p.indexOf(':');
                if (descIndex !== -1) {
                    p = p.substring(0, descIndex).trim();
                }

                p = p.replace(/\\/g, '/');
                return p;
            })
            .filter(p => p.length > 0 && p !== 'Root' && p !== 'Root (/)' && p !== 'Root (/)');
    }

    getFileScanPriority(file, activeFile, priorityPaths) {
        let score = 0;

        const activeFolder = activeFile?.parent?.path;
        if (activeFolder && file.path.startsWith(`${activeFolder}/`)) {
            score += 2;
        }

        if (priorityPaths && priorityPaths.length > 0) {
            if (priorityPaths.some(p => file.path.startsWith(p))) {
                score += 1;
            }
        }

        return score;
    }

    compareFileScanPriority(a, b, activeFile, priorityPaths) {
        const aPriority = this.getFileScanPriority(a, activeFile, priorityPaths);
        const bPriority = this.getFileScanPriority(b, activeFile, priorityPaths);

        if (aPriority !== bPriority) {
            return bPriority - aPriority;
        }

        return (b.stat?.mtime || 0) - (a.stat?.mtime || 0);
    }

    sortFilesForScan(files, activeFile, priorityPaths) {
        return files.sort((a, b) => this.compareFileScanPriority(a, b, activeFile, priorityPaths));
    }

    async scoreFileContent(file, searchTokens) {
        if (!searchTokens || searchTokens.length === 0) return 0;

        let content = '';
        try {
            content = await this.readVaultFile(file);
        } catch (e) {
            return 0;
        }

        if (!content) return 0;

        const lowerContent = content.toLowerCase().substring(0, VAULT_BROWSE_MAX_CONTENT_SCAN_CHARS);
        let uniqueHits = 0;

        for (const token of searchTokens) {
            if (lowerContent.includes(token)) {
                uniqueHits += 1;
            }
        }

        if (uniqueHits === 0) return 0;
        return Math.min(uniqueHits * 2, 12);
    }

    async findRelatedFiles(activeFile, searchTokens, excludedPaths) {
        if (!searchTokens || searchTokens.length === 0) return [];

        const priorityPaths = this.getPriorityPathsFromStructure();
        let files = [...this.app.vault.getMarkdownFiles()];
        files = this.sortFilesForScan(files, activeFile, priorityPaths);

        const candidates = [];
        let scanned = 0;

        for (const file of files) {
            if (excludedPaths?.has(file.path)) {
                continue;
            }

            if (activeFile && file.path === activeFile.path) {
                continue;
            }

            scanned += 1;
            if (scanned > VAULT_BROWSE_MAX_RELATED_SCAN) break;

            const cache = this.app.metadataCache.getFileCache(file);
            const score = this.scoreFile(file, cache, searchTokens, priorityPaths);
            candidates.push({ file, score });
        }

        if (candidates.length === 0) return [];

        let scored = candidates.filter(item => item.score >= VAULT_BROWSE_RELATED_MIN_SCORE);
        const hasStrongMatch = scored.some(item => item.score >= 3);

        if (scored.length < VAULT_BROWSE_MAX_RELATED_FILES || !hasStrongMatch) {
            const contentCandidates = candidates
                .filter(item => item.score < VAULT_BROWSE_RELATED_MIN_SCORE)
                .sort((a, b) => this.compareFileScanPriority(a.file, b.file, activeFile, priorityPaths))
                .slice(0, VAULT_BROWSE_MAX_CONTENT_SCAN);

            const contentResults = await Promise.allSettled(
                contentCandidates.map(async (item) => {
                    const contentScore = await this.scoreFileContent(item.file, searchTokens);
                    return { item, contentScore };
                })
            );

            for (const result of contentResults) {
                if (result.status !== 'fulfilled') continue;
                const { item, contentScore } = result.value;
                if (contentScore > 0) {
                    item.score += contentScore;
                }
            }

            scored = candidates.filter(item => item.score >= VAULT_BROWSE_RELATED_MIN_SCORE);
        }

        // Sort by score first, then by modification time (newest first) for tie-breakers
        scored.sort((a, b) => {
            if (b.score !== a.score) {
                return b.score - a.score;
            }
            return (b.file.stat?.mtime || 0) - (a.file.stat?.mtime || 0);
        });
        
        return scored.slice(0, VAULT_BROWSE_MAX_RELATED_FILES).map(item => item.file);
    }

    scoreFile(file, cache, tokens, structurePaths) {
        if (!tokens || tokens.length === 0) return 0;
        let score = 0;
        
        const lowerPath = file.path.toLowerCase();
        const lowerName = file.basename.toLowerCase();
        
        if (structurePaths && structurePaths.length > 0) {
            if (structurePaths.some(p => file.path.startsWith(p))) {
                score += 2;
            }
        }

        for (const token of tokens) {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escaped}\\b`, 'i');
            
            if (regex.test(lowerName)) {
                score += 5;
            } else if (regex.test(lowerPath)) {
                score += 3;
            }
            
            let metaHit = false;
            if (cache?.headings) {
                for (const h of cache.headings) {
                    if (regex.test(h.heading)) { score += 3; metaHit = true; }
                }
            }
            if (cache?.tags) {
                for (const t of cache.tags) {
                    if (regex.test(t.tag)) { score += 3; metaHit = true; }
                }
            }
            
            if (!metaHit && cache?.frontmatter) {
                const fmText = this.flattenFrontmatter(cache.frontmatter);
                if (regex.test(fmText)) { score += 1; }
            }
        }

        return score;
    }

    flattenFrontmatter(value) {
        const parts = [];

        const collect = (item) => {
            if (item === null || item === undefined) return;
            if (Array.isArray(item)) {
                item.forEach(collect);
                return;
            }
            if (typeof item === 'object') {
                Object.values(item).forEach(collect);
                return;
            }
            parts.push(String(item));
        };

        collect(value);
        return parts.join(' ');
    }

    extractLinkedFiles(activeFile, activeContent) {
        if (!activeFile || !activeContent) return [];

        const linkedPaths = new Set();

        const wikiLinkRegex = /\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
        for (const match of activeContent.matchAll(wikiLinkRegex)) {
            const linkPath = match[1].trim();
            if (!linkPath) continue;

            const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, activeFile.path);
            if (resolved && resolved.extension === 'md') {
                linkedPaths.add(resolved.path);
            }
        }

        const markdownLinkRegex = /\[[^\]]*\]\(([^)]+)\)/g;
        for (const match of activeContent.matchAll(markdownLinkRegex)) {
            let linkPath = match[1].trim();
            if (!linkPath) continue;

            if (linkPath.startsWith('http:') || linkPath.startsWith('https:') || linkPath.startsWith('mailto:')) {
                continue;
            }

            linkPath = linkPath.split('#')[0].trim();
            if (!linkPath) continue;

            const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, activeFile.path);
            if (resolved && resolved.extension === 'md') {
                linkedPaths.add(resolved.path);
            }
        }

        const files = [];
        for (const path of linkedPaths) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file && file.extension === 'md') {
                files.push(file);
            }
        }

        return files;
    }

    extractBacklinkedFiles(activeFile) {
        if (!activeFile) return [];

        const resolvedLinks = this.app.metadataCache.resolvedLinks || {};
        const backlinks = [];

        for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
            if (!targets || !targets[activeFile.path]) continue;
            const file = this.app.vault.getAbstractFileByPath(sourcePath);
            if (file && file.extension === 'md') {
                backlinks.push(file);
            }
        }

        return backlinks;
    }

    buildChatMemoryBlock(summary) {
        if (!summary || !summary.trim()) return '';

        const sanitized = summary.replace(/-->/g, '-- >').trim();
        return `<!-- ollama-memory:start\n${sanitized}\nollama-memory:end -->`;
    }

    extractChatMemoryBlock(bodyContent) {
        if (!bodyContent) {
            return { summary: '', bodyContent: '' };
        }

        const match = bodyContent.match(CHAT_MEMORY_BLOCK_REGEX);
        if (!match) {
            return { summary: '', bodyContent };
        }

        let summary = match[0]
            .replace(/<!--\s*ollama-memory:start/i, '')
            .replace(/ollama-memory:end\s*-->/i, '')
            .trim();

        summary = summary.replace(/\r\n/g, '\n');

        const cleanedBody = bodyContent.replace(CHAT_MEMORY_BLOCK_REGEX, '').trimStart();
        return { summary, bodyContent: cleanedBody };
    }

    buildRecentTurnsContext(userPrompt) {
        const recentTurns = Math.max(this.plugin.settings.chatMemoryRecentTurns || 0, 0);
        if (recentTurns === 0) return '';

        const messages = this.getMessagesForContext(userPrompt);
        if (messages.length === 0) return '';

        const lines = ['Recent chat (last turns):'];

        for (const message of messages) {
            const label = message.role === 'user' ? 'User' : 'Assistant';
            lines.push(`${label}: ${message.content}`);
        }

        return lines.join('\n') + '\n\n';
    }

    getMessagesForContext(userPrompt) {
        const recentTurns = Math.max(this.plugin.settings.chatMemoryRecentTurns || 0, 0);
        if (recentTurns === 0) return [];

        const messages = [...this.messages];
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === 'user' && lastMessage.content === userPrompt) {
            messages.pop();
        }

        const collected = [];
        let turnCount = 0;

        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const message = messages[i];
            if (message.role === 'assistant') {
                collected.push(message);
                if (i > 0 && messages[i - 1].role === 'user') {
                    collected.push(messages[i - 1]);
                    turnCount += 1;
                    i -= 1;
                }
            }

            if (turnCount >= recentTurns) {
                break;
            }
        }

        return collected.reverse();
    }

    async updateChatMemorySummary(userMessage, assistantMessage, model) {
        if (!this.plugin.settings.enableChatMemory) return;

        const summaryPrompt = this.buildMemorySummaryPrompt(
            this.chatMemorySummary,
            this.trimText(userMessage, CHAT_MEMORY_MAX_MESSAGE_CHARS),
            this.trimText(assistantMessage, CHAT_MEMORY_MAX_MESSAGE_CHARS),
            this.plugin.settings.chatMemoryMaxChars
        );

        const options = {
            temperature: this.plugin.settings.chatMemorySummaryTemperature
        };

        try {
            const summary = await this.callOllamaSummary(model, summaryPrompt, options);
            if (summary) {
                this.chatMemorySummary = summary.trim();
            }
        } catch (error) {
            console.warn('Failed to update chat memory summary:', error);
        }
    }

    buildMemorySummaryPrompt(previousSummary, userMessage, assistantMessage, maxChars) {
        const summaryText = previousSummary && previousSummary.trim() ? previousSummary.trim() : 'None yet.';

        return [
            'You are a memory manager for a chat conversation. Update the summary below with new information.',
            'Rules:',
            `- Keep it under ${maxChars} characters.`,
            '- Track: key facts, user preferences, decisions made, file/note names mentioned, open questions.',
            '- Preserve important context from the previous summary.',
            '- Do not include raw dialogue, formatting, or pleasantries.',
            '- Use concise bullet points or short fragments.',
            '- If the user references vault files or notes, include those names.',
            '',
            `Current summary:\n${summaryText}`,
            '',
            'New exchange:',
            `User: ${userMessage}`,
            `Assistant: ${assistantMessage}`,
            '',
            'Updated summary:'
        ].join('\n');
    }

    async callOllamaSummary(model, prompt, options) {
        const response = await fetch(`${this.plugin.settings.ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model,
                prompt,
                stream: false,
                options
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama summary API error: ${response.status}`);
        }

        const data = await response.json();
        return data?.response || '';
    }

    trimText(text, maxChars) {
        if (!text) return '';
        if (!maxChars || text.length <= maxChars) return text;
        return text.substring(0, maxChars) + '...';
    }

    // Copy button helpers
    _createCopyButton(container) {
        const btn = container.createEl('button', {
            cls: 'ollama-copy-button',
            attr: { 'aria-label': 'Copy message', 'title': 'Copy to clipboard' }
        });
        btn.appendChild(this._svgIcon(['M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z']));
        btn.insertAdjacentText('beforeend', ' Copy');
        return btn;
    }

    setupCopyButton(btn, text) {
        btn.addEventListener('click', async () => {
            await navigator.clipboard.writeText(text);
            btn.textContent = '';
            btn.appendChild(this._svgIcon('M20 6L9 17l-5-5'));
            btn.insertAdjacentText('beforeend', ' Copied');
            setTimeout(() => {
                btn.textContent = '';
                btn.appendChild(this._svgIcon(['M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2', 'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z']));
                btn.insertAdjacentText('beforeend', ' Copy');
            }, 1500);
        });
    }

    scrollToBottom() {
        if (!this.outputElement) return;
        // Wait for DOM to reflow before scrolling
        requestAnimationFrame(() => {
            if (this.outputElement) this.outputElement.scrollTop = this.outputElement.scrollHeight;
            // Markdown rendering sometimes needs an extra tick
            setTimeout(() => {
                if (this.outputElement) this.outputElement.scrollTop = this.outputElement.scrollHeight;
            }, 50);
        });
    }

    async renderMessage(role, content) {
        const messageDiv = this.outputElement.createDiv(`ollama-message ollama-${role}`);
        const bubble = messageDiv.createDiv('ollama-bubble');
        
        const headerDiv = bubble.createDiv('ollama-message-header');
        headerDiv.createSpan({ text: role === 'user' ? 'You' : 'Ollama', cls: 'ollama-role' });
        
        // Always-visible copy button with icon
        const copyButton = this._createCopyButton(headerDiv);
        this.setupCopyButton(copyButton, content);
        
        const contentDiv = bubble.createDiv('ollama-content');
        
        if (role === 'assistant') {
            await MarkdownRenderer.renderMarkdown(
                content,
                contentDiv,
                '',
                this
            );
        } else {
            contentDiv.setText(content);
        }
        
        this.scrollToBottom();
    }

    interruptGeneration() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    async onClose() {
        // Stop automatic status checking
        this.stopStatusChecking();

        // Unregister leaf change listener
        if (this._leafChangeRef) {
            this.app.workspace.offref(this._leafChangeRef);
        }
        
        // Cancel any pending requests
        if (this.abortController) {
            this.abortController.abort();
        }
        
        // Auto-save current chat if it has messages
        if (this.messages.length > 0) {
            await this.saveCurrentChat();
        }
    }
}

// OllamaSettingsTab class
class OllamaSettingsTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Ollama Sidechat Settings' });

        // Connection section
        containerEl.createEl('h3', { text: 'Connection' });

        new Setting(containerEl)
            .setName('Ollama Status')
            .setDesc(this.plugin.isOllamaRunning ? '● Service is running' : '○ Service is not detected')
            .addButton(button => {
                button.setButtonText('Check Status & Refresh Models');
                button.onClick(async () => {
                    await this.plugin.checkOllamaStatus();
                    if (this.plugin.isOllamaRunning) {
                        await this.plugin.refreshAvailableModels();
                        new Notice('Ollama is running - models refreshed');
                    } else {
                        new Notice('Ollama is not running. Please start Ollama manually.');
                    }
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName('Ollama URL')
            .setDesc('URL of your Ollama instance')
            .addText(text => {
                text.setPlaceholder('http://localhost:11434')
                    .setValue(this.plugin.settings.ollamaUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.ollamaUrl = value;
                        await this.plugin.saveSettings();
                    });
            });

        // Model section
        containerEl.createEl('h3', { text: 'Model Settings' });

        new Setting(containerEl)
            .setName('Default Model')
            .setDesc('Default model to use for chat')
            .addText(text => {
                text.setPlaceholder(' --- ')
                    .setValue(this.plugin.settings.defaultModel)
                    .onChange(async (value) => {
                        this.plugin.settings.defaultModel = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Temperature')
            .setDesc('Model temperature (0.0 - 1.0). Higher = more creative, lower = more focused.')
            .addSlider(slider => {
                slider.setLimits(0, 1, 0.1)
                    .setValue(this.plugin.settings.temperature)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.temperature = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Max Tokens')
            .setDesc('Maximum tokens per response. Use -1 or 0 for unlimited (model decides).')
            .addText(text => {
                text.setPlaceholder('-1')
                    .setValue(this.plugin.settings.maxTokens.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value);
                        this.plugin.settings.maxTokens = isNaN(parsed) ? -1 : parsed;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Custom Instructions')
            .setDesc('Custom instructions that will be added to the beginning of every prompt (e.g., "You are a helpful assistant...")')
            .addTextArea(text => {
                text.setPlaceholder('Enter custom instructions here...')
                    .setValue(this.plugin.settings.customInstructions)
                    .onChange(async (value) => {
                        this.plugin.settings.customInstructions = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 4;
                text.inputEl.cols = 50;
            });

        // Chat History section
        containerEl.createEl('h3', { text: 'Chat History' });

        new Setting(containerEl)
            .setName('Chat History Folder')
            .setDesc('Folder path where chat history will be saved (relative to vault root, use forward slashes)')
            .addText(text => {
                text.setPlaceholder('Ollama Chats/')
                    .setValue(this.plugin.settings.chatHistoryPath)
                    .onChange(async (value) => {
                        // Normalize path - replace backslashes, ensure ends with /
                        value = (value || 'Ollama Chats/').replace(/\\/g, '/');
                        if (!value.endsWith('/')) {
                            value = value + '/';
                        }
                        this.plugin.settings.chatHistoryPath = value;
                        await this.plugin.saveSettings();
                        await this.plugin.ensureChatHistoryFolder();
                    });
            });

        new Setting(containerEl)
            .setName('Include Note Context')
            .setDesc('Automatically include the content of the active note as context for your questions')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.includeNoteContext);
                toggle.onChange(async (value) => {
                    this.plugin.settings.includeNoteContext = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Enable Vault Browsing')
            .setDesc('Include relative file listings, linked note excerpts, and related note matches when building context')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.enableVaultBrowse);
                toggle.onChange(async (value) => {
                    this.plugin.settings.enableVaultBrowse = value;
                    await this.plugin.saveSettings();
                });
            });

        // Chat Memory section
        containerEl.createEl('h3', { text: 'Chat Memory' });

        new Setting(containerEl)
            .setName('Enable Chat Memory')
            .setDesc('Keep a rolling summary and recent turns for the current chat')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.enableChatMemory);
                toggle.onChange(async (value) => {
                    this.plugin.settings.enableChatMemory = value;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName('Memory Summary Size')
            .setDesc('Maximum characters for the rolling summary')
            .addText(text => {
                text.setPlaceholder('3000')
                    .setValue(this.plugin.settings.chatMemoryMaxChars.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value);
                        this.plugin.settings.chatMemoryMaxChars = isNaN(parsed) ? 3000 : Math.max(parsed, 500);
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Recent Turns in Prompt')
            .setDesc('How many recent user/assistant turns to include')
            .addText(text => {
                text.setPlaceholder('4')
                    .setValue(this.plugin.settings.chatMemoryRecentTurns.toString())
                    .onChange(async (value) => {
                        const parsed = parseInt(value);
                        this.plugin.settings.chatMemoryRecentTurns = isNaN(parsed) ? 4 : Math.max(parsed, 0);
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Memory Summary Temperature')
            .setDesc('Lower values keep summaries stable and concise')
            .addSlider(slider => {
                slider.setLimits(0, 1, 0.1)
                    .setValue(this.plugin.settings.chatMemorySummaryTemperature)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.chatMemorySummaryTemperature = value;
                        await this.plugin.saveSettings();
                    });
            });

        // Vault Structure section
        containerEl.createEl('h3', { text: 'Vault Structure' });
        
        new Setting(containerEl)
            .setName('Vault Structure Overview')
            .setDesc('A general map of where things are located. Helps the AI understand your vault organization.')
            .addTextArea(text => {
                text.setPlaceholder('e.g.,\n- Work/ : Work related notes\n- Personal/ : Journal and ideas')
                    .setValue(this.plugin.settings.vaultStructure)
                    .onChange(async (value) => {
                        this.plugin.settings.vaultStructure = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 8;
                text.inputEl.cols = 50;
            });
            
        new Setting(containerEl)
            .setName('Auto-Generate Vault Structure')
            .setDesc('Scan your vault to automatically generate a basic structure overview. This will replace the text above.')
            .addButton(button => {
                button.setButtonText('Generate Structure')
                    .onClick(async () => {
                        const allFiles = this.app.vault.getMarkdownFiles();
                        const folderCounts = {};
                        
                        for (const file of allFiles) {
                            let parent = file.parent;
                            let rootPath = '';
                            if (parent && parent.path !== '/') {
                                const parts = parent.path.split('/');
                                rootPath = parts[0] + '/';
                            } else {
                                rootPath = 'Root (/)';
                            }
                            folderCounts[rootPath] = (folderCounts[rootPath] || 0) + 1;
                        }
                        
                        const sortedFolders = Object.entries(folderCounts)
                            .sort((a, b) => b[1] - a[1]);
                            
                        let structure = 'General Vault Structure:\n';
                        for (const [folder, count] of sortedFolders) {
                            if (count > 0) {
                                structure += `- ${folder} (Contains ~${count} notes)\n`;
                            }
                        }
                        
                        this.plugin.settings.vaultStructure = structure;
                        await this.plugin.saveSettings();
                        new Notice('Vault structure generated!');
                        this.display();
                    });
            });
    }
}

// Main Plugin class
class OllamaPlugin extends Plugin {
    constructor(app, manifest) {
        super(app, manifest);
        this.settings = { ...DEFAULT_SETTINGS };
        this.isOllamaRunning = false;
        this.availableModels = [];
        this.currentChatId = null;
        this.abortController = null;
        this.refreshIntervalId = null;
    }

    async onload() {
        await this.loadSettings();
        
        // Ensure chat history folder exists
        await this.ensureChatHistoryFolder();

        // Check Ollama status on startup
        await this.checkOllamaStatus();

        this.registerView(
            VIEW_TYPE_OLLAMA,
            (leaf) => new OllamaSideView(leaf, this)
        );

        this.addRibbonIcon('brain-circuit', 'Ollama Chat', () => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-ollama-side-view',
            name: 'Open Ollama Chat',
            callback: () => {
                this.activateView();
            }
        });

        this.addCommand({
            id: 'check-ollama-status',
            name: 'Check Ollama Status & Refresh Models',
            callback: async () => {
                await this.checkOllamaStatus();
                if (this.isOllamaRunning) {
                    await this.refreshAvailableModels();
                    new Notice('Ollama is running - models refreshed');
                } else {
                    new Notice('Ollama is not running. Please start Ollama manually.');
                }
            }
        });

        this.addSettingTab(new OllamaSettingsTab(this.app, this));

        this.refreshIntervalId = window.setInterval(() => {
            if (this.isOllamaRunning) {
                this.refreshAvailableModels();
            }
        }, 60000);
        
        this.registerInterval(this.refreshIntervalId);
    }

    async onunload() {
        if (this.abortController) {
            this.abortController.abort();
        }
        if (this.refreshIntervalId) {
            window.clearInterval(this.refreshIntervalId);
        }
    }

    async ensureChatHistoryFolder() {
        // Normalize path - replace backslashes with forward slashes, trim trailing slash
        const folderPath = this.settings.chatHistoryPath
            .replace(/\\/g, '/')
            .replace(/\/+$/, '');
        
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            try {
                await this.app.vault.createFolder(folderPath);
            } catch (e) {
                // Folder might already exist or parent doesn't exist
                console.log('Could not create chat history folder:', e);
            }
        }
    }

    async activateView() {
        const workspace = this.app.workspace;
        let leaf = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_OLLAMA);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({
                type: VIEW_TYPE_OLLAMA,
                active: true
            });
        }

        workspace.revealLeaf(leaf);
        
        // Check status and refresh models when opening view
        await this.checkOllamaStatus();
        if (this.isOllamaRunning) {
            await this.refreshAvailableModels();
        }
    }

    async checkOllamaStatus() {
        try {
            const response = await fetch(`${this.settings.ollamaUrl}/api/tags`, {
                method: 'GET'
            });
            
            this.isOllamaRunning = response.ok;
            return response.ok;
        } catch (error) {
            this.isOllamaRunning = false;
            return false;
        }
    }

    async refreshAvailableModels() {
        if (!this.isOllamaRunning) return;

        try {
            const response = await fetch(`${this.settings.ollamaUrl}/api/tags`);
            if (response.ok) {
                const data = await response.json();
                this.availableModels = data.models ? data.models.map(model => model.name) : [];
            } else {
                this.availableModels = [];
            }
        } catch (error) {
            console.error('Failed to fetch models:', error);
            this.availableModels = [];
        }
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

module.exports = OllamaPlugin;
module.exports.default = OllamaPlugin;
