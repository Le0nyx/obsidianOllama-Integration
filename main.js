const { Plugin, Notice, ItemView, PluginSettingTab, Setting, TFolder, MarkdownRenderer } = require('obsidian');

// Constants
const VIEW_TYPE_OLLAMA = 'ollama-side-view';

const VAULT_BROWSE_MAX_FILES = 40;
const VAULT_BROWSE_MAX_LINKED_FILES = 5;
const VAULT_BROWSE_MAX_RELATED_FILES = 5;
const VAULT_BROWSE_MAX_RELATED_SCAN = 400;
const VAULT_BROWSE_MAX_FILE_CHARS = 2000;
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
    chatMemorySummaryTemperature: 0.2
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

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.addClass('ollama-side-container');

        // Header with title, chat selector, and new chat button
        const header = container.createDiv('ollama-header');
        const headerLeft = header.createDiv('ollama-header-left');
        headerLeft.createEl('h3', { text: 'Ollama Chat' });
        
        const headerRight = header.createDiv('ollama-header-right');
        
        // Chat selector dropdown
        const chatSelectorContainer = headerRight.createDiv('ollama-chat-selector-container');
        
        this.chatSearchInput = chatSelectorContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search chats...',
            cls: 'ollama-chat-search'
        });
        
        this.chatListContainer = chatSelectorContainer.createDiv('ollama-chat-list');
        this.chatListContainer.style.display = 'none';
        
        this.chatSearchInput.addEventListener('focus', () => {
            this.refreshChatList();
            this.chatListContainer.style.display = 'block';
        });
        
        this.chatSearchInput.addEventListener('blur', (e) => {
            // Delay hiding to allow click on items
            setTimeout(() => {
                this.chatListContainer.style.display = 'none';
            }, 200);
        });
        
        this.chatSearchInput.addEventListener('input', () => {
            this.filterChatList(this.chatSearchInput.value);
        });
        
        // Open in new tab button
        this.openInTabButton = headerRight.createEl('button', {
            text: '↗',
            cls: 'ollama-open-tab-button',
            attr: { 'aria-label': 'Open in New Tab', 'title': 'Open current chat in new tab' }
        });
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
        
        // New chat button
        const newChatButton = headerRight.createEl('button', {
            text: '+',
            cls: 'ollama-new-chat-button',
            attr: { 'aria-label': 'New Chat', 'title': 'New Chat' }
        });
        newChatButton.addEventListener('click', () => {
            this.createNewChat();
        });

        const controlsSection = container.createDiv('ollama-controls-section');
        
        const statusContainer = controlsSection.createDiv('ollama-status-container');
        this.statusElement = statusContainer.createDiv('ollama-status');
        this.updateStatusIndicator();

        const modelContainer = controlsSection.createDiv('ollama-model-container');
        modelContainer.createSpan({ text: 'Model: ' });
        
        const modelSelect = modelContainer.createEl('select', { cls: 'ollama-model-select' });
        this.modelSelect = modelSelect;
        this.populateModelDropdown();
        
        // Track user's model selection
        this.modelSelect.addEventListener('change', () => {
            this.userSelectedModel = this.modelSelect.value;
        });

        const refreshButton = modelContainer.createEl('button', {
            text: 'Refresh',
            cls: 'ollama-refresh-button'
        });
        refreshButton.addEventListener('click', async () => {
            await this.plugin.refreshAvailableModels();
            this.populateModelDropdown();
            new Notice('Models refreshed');
        });

        const vaultBrowseContainer = controlsSection.createDiv('ollama-vault-browse-container');
        vaultBrowseContainer.createSpan({ text: 'Vault Browse: ' });

        this.vaultBrowseToggle = vaultBrowseContainer.createEl('button', {
            cls: 'ollama-vault-browse-toggle',
            attr: { 'aria-label': 'Toggle vault browsing', 'title': 'Toggle vault browsing for relative and related files' }
        });

        this.vaultBrowseToggle.addEventListener('click', async () => {
            this.plugin.settings.enableVaultBrowse = !this.plugin.settings.enableVaultBrowse;
            await this.plugin.saveSettings();
            this.updateVaultBrowseToggle();
            this.updateContextIndicator();
        });

        // Context note indicator
        this.contextIndicator = container.createDiv('ollama-context-indicator');
        this.updateContextIndicator();

        this.outputElement = container.createDiv('ollama-output');

        const inputContainer = container.createDiv('ollama-input-container');
        
        this.inputElement = inputContainer.createEl('textarea', {
            placeholder: 'Ask Ollama anything... (Shift+Enter for new line)',
            cls: 'ollama-textarea'
        });
        this.inputElement.rows = 3;
        this.inputElement.disabled = !this.plugin.isOllamaRunning;

        this.inputElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.sendMessage();
            }
        });

        // Add interrupt button
        this.interruptButton = inputContainer.createEl('button', {
            text: 'Interrupt',
            cls: 'ollama-interrupt-button',
            attr: { 'aria-label': 'Interrupt generation', 'title': 'Stop generation' }
        });
        this.interruptButton.style.display = 'none';
        this.interruptButton.addEventListener('click', () => {
            this.interruptGeneration();
        });

        this.updateUI();
        await this.refreshChatList();
        
        // Start automatic status checking every 2 seconds
        this.startStatusChecking();
    }

    updateContextIndicator() {
        this.contextIndicator.empty();

        const noteRow = this.contextIndicator.createDiv('ollama-context-row');
        if (this.plugin.settings.includeNoteContext) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile && activeFile.extension === 'md') {
                this.contextNotePath = activeFile.path;
                noteRow.createSpan({ 
                    text: `- Context: ${activeFile.basename}`,
                    cls: 'ollama-context-text'
                });
            } else {
                this.contextNotePath = null;
                noteRow.createSpan({ 
                    text: '- No note context',
                    cls: 'ollama-context-text ollama-context-none'
                });
            }
        } else {
            noteRow.createSpan({
                text: '- Note context: off',
                cls: 'ollama-context-text ollama-context-none'
            });
        }

        const browseRow = this.contextIndicator.createDiv('ollama-context-row');
        browseRow.createSpan({
            text: this.plugin.settings.enableVaultBrowse ? '- Vault browse: on' : '- Vault browse: off',
            cls: this.plugin.settings.enableVaultBrowse ? 'ollama-context-text' : 'ollama-context-text ollama-context-none'
        });

        const memoryRow = this.contextIndicator.createDiv('ollama-context-row');
        memoryRow.createSpan({
            text: this.plugin.settings.enableChatMemory ? '- Memory: on' : '- Memory: off',
            cls: this.plugin.settings.enableChatMemory ? 'ollama-context-text' : 'ollama-context-text ollama-context-none'
        });
    }

    startStatusChecking() {
        // Check immediately
        this.checkStatus();
        
        // Then check every 2 seconds
        this.statusCheckInterval = window.setInterval(() => {
            this.checkStatus();
        }, 2000);
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
        
        // If status changed, update UI and refresh models
        if (wasRunning !== this.plugin.isOllamaRunning) {
            if (this.plugin.isOllamaRunning) {
                await this.plugin.refreshAvailableModels();
            }
            this.updateUI();
        } else if (this.plugin.isOllamaRunning) {
            // If still running, just update models silently
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
        
        // Build frontmatter
        const now = new Date().toISOString();
        const firstUserMsg = this.messages.find(m => m.role === 'user');
        const title = firstUserMsg 
            ? firstUserMsg.content.substring(0, 60).replace(/\n/g, ' ')
            : 'Ollama Chat';
        
        let frontmatter = `---
title: "${title.replace(/"/g, '\\"')}"
createdAt: ${this.currentChatFile ? '' : now}
updatedAt: ${now}
model: "${this.modelSelect?.value || this.plugin.settings.defaultModel}"`;
        
        if (this.contextNotePath) {
            frontmatter += `\ncontextNote: "[[${this.contextNotePath}]]"`;
        }
        
        frontmatter += '\n---\n\n';
        
        // Build message content
        let content = frontmatter;

        const memoryBlock = this.buildChatMemoryBlock(this.chatMemorySummary);
        if (memoryBlock) {
            content += memoryBlock + '\n\n';
        }

        for (const msg of this.messages) {
            const roleHeader = msg.role === 'user' ? '## You' : '## Ollama';
            content += `${roleHeader}\n${msg.content}\n\n`;
        }
        
        // Save or update file
        const existingFile = this.app.vault.getAbstractFileByPath(filePath);
        if (existingFile) {
            await this.app.vault.modify(existingFile, content);
        } else {
            await this.app.vault.create(filePath, content);
            this.currentChatFile = filePath;
            this.openInTabButton.style.display = 'inline-block';
        }
        
        await this.refreshChatList();
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
                } else if (roleText === 'ollama') {
                    this.messages.push({ role: 'assistant', content: messageContent });
                }
            }
            
            // Render messages
            this.outputElement.empty();
            for (const msg of this.messages) {
                await this.renderMessage(msg.role, msg.content);
            }
            
            // Scroll to bottom after loading all messages
            this.outputElement.scrollTop = this.outputElement.scrollHeight;
            
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
        this.statusElement.empty();
        const statusText = this.plugin.isOllamaRunning ? '● Running' : '○ Stopped';
        const statusClass = this.plugin.isOllamaRunning ? 'running' : 'stopped';
        
        this.statusElement.setText(statusText);
        this.statusElement.removeClass('ollama-status-running', 'ollama-status-stopped');
        this.statusElement.addClass(`ollama-status-${statusClass}`);
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
        this.interruptButton.style.display = 'inline-block';

        // Create placeholder for streaming response
        const responseDiv = this.outputElement.createDiv('ollama-message ollama-assistant');
        
        const headerDiv = responseDiv.createDiv('ollama-message-header');
        const roleSpan = headerDiv.createSpan({ text: 'Ollama: ' });
        roleSpan.addClass('ollama-role');
        
        // Add copy button for streaming response
        const copyButton = headerDiv.createEl('button', {
            text: 'copy',
            cls: 'ollama-copy-button',
            attr: { 'aria-label': 'Copy message', 'title': 'Copy to clipboard' }
        });
        
        const contentDiv = responseDiv.createDiv('ollama-content');

        try {
            const selectedModel = this.modelSelect.value || this.plugin.settings.defaultModel;
            const response = await this.callOllamaStreaming(message, selectedModel, contentDiv);
            this.messages.push({ role: 'assistant', content: response });

            if (this.plugin.settings.enableChatMemory) {
                await this.updateChatMemorySummary(message, response, selectedModel);
            }
            
            // Setup copy button handler after response is complete
            copyButton.addEventListener('click', async () => {
                await navigator.clipboard.writeText(response);
                copyButton.setText('✓');
                setTimeout(() => {
                    copyButton.setText('copy');
                }, 1500);
            });
            
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
            this.inputElement.focus();
        }
    }

    async callOllamaStreaming(prompt, model, contentDiv) {
        const ollamaUrl = this.plugin.settings.ollamaUrl;
        
        // Build prompt with context
        const fullPrompt = await this.buildPrompt(prompt);
        
        // Build options - only include num_predict if it's a positive value
        const options = {
            temperature: this.plugin.settings.temperature
        };
        
        // Only set num_predict if user specified a positive limit
        // -1 or 0 means unlimited (let model decide)
        if (this.plugin.settings.maxTokens > 0) {
            options.num_predict = this.plugin.settings.maxTokens;
        }
        
        const requestBody = {
            model: model,
            prompt: fullPrompt,
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

        // Handle streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        let lastRenderTime = 0;
        const renderInterval = 100; // Render every 100ms for smooth updates

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
                        
                        // Throttle markdown rendering for performance
                        const now = Date.now();
                        if (now - lastRenderTime > renderInterval) {
                            contentDiv.empty();
                            await MarkdownRenderer.renderMarkdown(
                                fullResponse,
                                contentDiv,
                                '',
                                this
                            );
                            this.outputElement.scrollTop = this.outputElement.scrollHeight;
                            lastRenderTime = now;
                        }
                    }
                } catch (e) {
                    // Skip malformed JSON lines
                }
            }
        }

        // Final render to ensure complete markdown
        contentDiv.empty();
        await MarkdownRenderer.renderMarkdown(
            fullResponse,
            contentDiv,
            '',
            this
        );
        this.outputElement.scrollTop = this.outputElement.scrollHeight;

        this.abortController = null;
        return fullResponse;
    }

    async buildPrompt(userPrompt) {
        let fullPrompt = '';
        
        // Add custom instructions if provided
        if (this.plugin.settings.customInstructions && this.plugin.settings.customInstructions.trim()) {
            fullPrompt += this.plugin.settings.customInstructions.trim() + '\n\n';
        }

        if (this.plugin.settings.enableChatMemory) {
            if (this.chatMemorySummary && this.chatMemorySummary.trim()) {
                fullPrompt += `Chat memory summary:\n${this.chatMemorySummary.trim()}\n\n`;
            }

            const recentTurnsContext = this.buildRecentTurnsContext(userPrompt);
            if (recentTurnsContext) {
                fullPrompt += recentTurnsContext;
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
            fullPrompt += `Context from note "${activeFile.basename}":\n\n${activeContent}\n\n---\n\n`;
        }

        // Add vault browsing context if enabled
        if (this.plugin.settings.enableVaultBrowse) {
            const vaultContext = await this.buildVaultBrowseContext(activeFile, activeContent, userPrompt);
            if (vaultContext) {
                fullPrompt += vaultContext;
            }
        }
        
        fullPrompt += userPrompt;
        return fullPrompt;
    }

    async buildVaultBrowseContext(activeFile, activeContent, userPrompt) {
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

        const linkedFiles = this.extractLinkedFiles(activeFile, activeContent)
            .slice(0, VAULT_BROWSE_MAX_LINKED_FILES);

        linkedFiles.forEach(file => excludedPaths.add(file.path));

        let totalChars = 0;

        if (linkedFiles.length > 0) {
            const linkedBlock = await this.buildFileExcerptsBlock(
                linkedFiles,
                'Linked file excerpts',
                [],
                totalChars
            );

            if (linkedBlock.block) {
                contextParts.push(linkedBlock.block);
            }

            totalChars = linkedBlock.totalChars;
        }

        const tokenSource = [
            userPrompt || '',
            activeContent ? activeContent.substring(0, VAULT_BROWSE_MAX_TOKEN_SOURCE_CHARS) : ''
        ].join(' ');

        const searchTokens = this.extractSearchTokens(tokenSource);

        const relatedFiles = this.findRelatedFiles(activeFile, searchTokens, excludedPaths);

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

    async buildFileExcerptsBlock(files, heading, searchTokens, totalChars) {
        if (!files || files.length === 0 || totalChars >= VAULT_BROWSE_MAX_TOTAL_CHARS) {
            return { block: '', totalChars };
        }

        let contentBlock = `${heading}:\n`;

        for (const file of files) {
            if (totalChars >= VAULT_BROWSE_MAX_TOTAL_CHARS) break;

            try {
                const content = await this.app.vault.read(file);
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
            } catch (e) {
                // Skip unreadable files
            }
        }

        return { block: contentBlock.trim(), totalChars };
    }

    getBestExcerpt(content, searchTokens) {
        if (!content) return '';

        if (!searchTokens || searchTokens.length === 0) {
            return content;
        }

        const lowerContent = content.toLowerCase();
        let bestIndex = -1;

        for (const token of searchTokens) {
            const index = lowerContent.indexOf(token);
            if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
                bestIndex = index;
            }
        }

        if (bestIndex === -1) {
            return content;
        }

        const windowSize = VAULT_BROWSE_MAX_FILE_CHARS;
        const start = Math.max(0, bestIndex - Math.floor(windowSize * 0.25));
        const end = Math.min(content.length, start + windowSize);
        let excerpt = content.substring(start, end);

        if (start > 0) {
            excerpt = '...\n' + excerpt;
        }

        if (end < content.length) {
            excerpt += '\n...';
        }

        return excerpt;
    }

    extractSearchTokens(sourceText) {
        if (!sourceText) return [];

        const matches = sourceText.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
        const tokens = [];
        const seen = new Set();

        for (const word of matches) {
            if (tokens.length >= VAULT_BROWSE_MAX_TOKENS) break;
            if (VAULT_BROWSE_STOPWORDS.has(word)) continue;
            if (seen.has(word)) continue;
            seen.add(word);
            tokens.push(word);
        }

        return tokens;
    }

    findRelatedFiles(activeFile, searchTokens, excludedPaths) {
        if (!searchTokens || searchTokens.length === 0) return [];

        const files = this.app.vault.getMarkdownFiles();
        const scored = [];
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
            const metaText = this.buildMetadataText(file, cache);
            const score = this.scoreText(searchTokens, metaText);

            if (score >= VAULT_BROWSE_RELATED_MIN_SCORE) {
                scored.push({ file, score });
            }
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, VAULT_BROWSE_MAX_RELATED_FILES).map(item => item.file);
    }

    buildMetadataText(file, cache) {
        const parts = [file.basename, file.path];

        if (cache?.headings?.length) {
            parts.push(cache.headings.map(heading => heading.heading).join(' '));
        }

        if (cache?.tags?.length) {
            parts.push(cache.tags.map(tag => tag.tag).join(' '));
        }

        if (cache?.frontmatter) {
            parts.push(this.flattenFrontmatter(cache.frontmatter));
        }

        return parts.join(' ');
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

    scoreText(tokens, text) {
        if (!tokens || tokens.length === 0 || !text) return 0;
        const lowerText = text.toLowerCase();
        let score = 0;

        for (const token of tokens) {
            if (lowerText.includes(token)) {
                score += 1;
            }
        }

        return score;
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
            'You are updating a concise memory summary of a chat.',
            'Rules:',
            `- Keep it under ${maxChars} characters.`,
            '- Focus on key facts, decisions, preferences, and open questions.',
            '- Do not include raw dialogue or formatting.',
            '- Use short sentences or fragments.',
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

    async renderMessage(role, content) {
        const messageDiv = this.outputElement.createDiv(`ollama-message ollama-${role}`);
        
        const headerDiv = messageDiv.createDiv('ollama-message-header');
        const roleSpan = headerDiv.createSpan({ text: role === 'user' ? 'You: ' : 'Ollama: ' });
        roleSpan.addClass('ollama-role');
        
        // Add copy button
        const copyButton = headerDiv.createEl('button', {
            text: 'copy',
            cls: 'ollama-copy-button',
            attr: { 'aria-label': 'Copy message', 'title': 'Copy to clipboard' }
        });
        copyButton.addEventListener('click', async () => {
            await navigator.clipboard.writeText(content);
            copyButton.setText('✓');
            setTimeout(() => {
                copyButton.setText('copy');
            }, 1500);
        });
        
        const contentDiv = messageDiv.createDiv('ollama-content');
        
        // Render markdown for assistant messages, plain text for user messages
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
        
        this.outputElement.scrollTop = this.outputElement.scrollHeight;
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
