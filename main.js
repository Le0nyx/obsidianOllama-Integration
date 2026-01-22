const { Plugin, Notice, ItemView, PluginSettingTab, Setting, TFolder } = require('obsidian');
const { spawn } = require('child_process');

// Constants
const VIEW_TYPE_OLLAMA = 'ollama-side-view';

const DEFAULT_SETTINGS = {
    ollamaUrl: 'http://localhost:11434',
    defaultModel: '---',
    temperature: 0.7,
    maxTokens: -1,
    autoStart: false,
    chatHistoryPath: 'Ollama Chats/',
    includeNoteContext: true
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

        this.startStopButton = statusContainer.createEl('button', {
            text: this.plugin.isOllamaRunning ? 'Stop Ollama' : 'Start Ollama',
            cls: 'ollama-start-stop-button'
        });
        
        this.startStopButton.addEventListener('click', async () => {
            await this.plugin.toggleOllamaService();
            this.updateUI();
        });

        const modelContainer = controlsSection.createDiv('ollama-model-container');
        modelContainer.createSpan({ text: 'Model: ' });
        
        const modelSelect = modelContainer.createEl('select', { cls: 'ollama-model-select' });
        this.modelSelect = modelSelect;
        this.populateModelDropdown();

        const refreshButton = modelContainer.createEl('button', {
            text: 'Refresh',
            cls: 'ollama-refresh-button'
        });
        refreshButton.addEventListener('click', async () => {
            await this.plugin.refreshAvailableModels();
            this.populateModelDropdown();
            new Notice('Models refreshed');
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
    }

    updateContextIndicator() {
        this.contextIndicator.empty();
        if (this.plugin.settings.includeNoteContext) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile && activeFile.extension === 'md') {
                this.contextNotePath = activeFile.path;
                this.contextIndicator.createSpan({ 
                    text: `- Context: ${activeFile.basename}`,
                    cls: 'ollama-context-text'
                });
            } else {
                this.contextNotePath = null;
                this.contextIndicator.createSpan({ 
                    text: '- No note context',
                    cls: 'ollama-context-text ollama-context-none'
                });
            }
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
        this.outputElement.empty();
        this.chatSearchInput.value = '';
        this.openInTabButton.style.display = 'none';
        this.updateContextIndicator();
        
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
                this.renderMessage(msg.role, msg.content);
            }
            
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
        
        this.startStopButton.setText(isRunning ? 'Stop Ollama' : 'Start Ollama');
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

        const defaultModel = this.plugin.settings.defaultModel;
        if (this.plugin.availableModels.includes(defaultModel)) {
            this.modelSelect.value = defaultModel;
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
        this.renderMessage('user', message);
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
            text: '📋',
            cls: 'ollama-copy-button',
            attr: { 'aria-label': 'Copy message', 'title': 'Copy to clipboard' }
        });
        
        const contentSpan = responseDiv.createSpan({ text: '' });
        contentSpan.addClass('ollama-content');

        try {
            const selectedModel = this.modelSelect.value || this.plugin.settings.defaultModel;
            const response = await this.callOllamaStreaming(message, selectedModel, contentSpan);
            this.messages.push({ role: 'assistant', content: response });
            
            // Setup copy button handler after response is complete
            copyButton.addEventListener('click', async () => {
                await navigator.clipboard.writeText(response);
                copyButton.setText('✓');
                setTimeout(() => {
                    copyButton.setText('📋');
                }, 1500);
            });
            
            // Auto-save after each exchange
            await this.saveCurrentChat();
        } catch (error) {
            if (error.name !== 'AbortError') {
                contentSpan.setText(`Error: ${error.message}`);
                this.messages.push({ role: 'assistant', content: `Error: ${error.message}` });
            } else {
                // Generation was interrupted
                const partialResponse = contentSpan.getText();
                if (partialResponse) {
                    this.messages.push({ role: 'assistant', content: partialResponse + '\n\n[Generation interrupted]' });
                    contentSpan.setText(partialResponse + '\n\n[Generation interrupted]');
                } else {
                    contentSpan.setText('[Generation interrupted]');
                }
                new Notice('Generation interrupted');
            }
        } finally {
            this.inputElement.disabled = false;
            this.interruptButton.style.display = 'none';
            this.inputElement.focus();
        }
    }

    async callOllamaStreaming(prompt, model, contentSpan) {
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
                        contentSpan.setText(fullResponse);
                        this.outputElement.scrollTop = this.outputElement.scrollHeight;
                    }
                } catch (e) {
                    // Skip malformed JSON lines
                }
            }
        }

        this.abortController = null;
        return fullResponse;
    }

    async buildPrompt(userPrompt) {
        if (!this.plugin.settings.includeNoteContext) {
            return userPrompt;
        }
        
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            try {
                const content = await this.app.vault.read(activeFile);
                this.contextNotePath = activeFile.path;
                return `Context from note "${activeFile.basename}":\n\n${content}\n\n---\n\nUser question: ${userPrompt}`;
            } catch (e) {
                // Failed to read file, continue without context
            }
        }
        return userPrompt;
    }

    renderMessage(role, content) {
        const messageDiv = this.outputElement.createDiv(`ollama-message ollama-${role}`);
        
        const headerDiv = messageDiv.createDiv('ollama-message-header');
        const roleSpan = headerDiv.createSpan({ text: role === 'user' ? 'You: ' : 'Ollama: ' });
        roleSpan.addClass('ollama-role');
        
        // Add copy button
        const copyButton = headerDiv.createEl('button', {
            text: '📋',
            cls: 'ollama-copy-button',
            attr: { 'aria-label': 'Copy message', 'title': 'Copy to clipboard' }
        });
        copyButton.addEventListener('click', async () => {
            await navigator.clipboard.writeText(content);
            copyButton.setText('✓');
            setTimeout(() => {
                copyButton.setText('📋');
            }, 1500);
        });
        
        const contentSpan = messageDiv.createSpan({ text: content });
        contentSpan.addClass('ollama-content');
        
        this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }

    interruptGeneration() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
    }

    async onClose() {
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
            .setDesc(this.plugin.isOllamaRunning ? '● Service is running' : '○ Service is stopped')
            .addButton(button => {
                button.setButtonText(this.plugin.isOllamaRunning ? 'Stop Service' : 'Start Service');
                button.onClick(async () => {
                    await this.plugin.toggleOllamaService();
                    this.display();
                });
            });

        new Setting(containerEl)
            .setName('Auto-start Ollama')
            .setDesc('Automatically check Ollama status on plugin startup')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.autoStart);
                toggle.onChange(async (value) => {
                    this.plugin.settings.autoStart = value;
                    await this.plugin.saveSettings();
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
                text.setPlaceholder('llama3.1')
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
        this.ollamaProcess = null;
    }

    async onload() {
        await this.loadSettings();
        
        // Ensure chat history folder exists
        await this.ensureChatHistoryFolder();

        if (this.settings.autoStart) {
            await this.checkOllamaStatus();
        }

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
            id: 'toggle-ollama-service',
            name: 'Start/Stop Ollama Service',
            callback: () => {
                this.toggleOllamaService();
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
        // Kill Ollama process if we started it
        if (this.ollamaProcess) {
            this.killOllamaProcess();
        }
    }

    killOllamaProcess() {
        if (this.ollamaProcess) {
            try {
                // On Windows, we need to kill the process tree
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/pid', this.ollamaProcess.pid.toString(), '/f', '/t']);
                } else {
                    this.ollamaProcess.kill('SIGTERM');
                }
            } catch (e) {
                console.error('Failed to kill Ollama process:', e);
            }
            this.ollamaProcess = null;
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
        
        if (this.isOllamaRunning) {
            await this.refreshAvailableModels();
        }
    }

    async toggleOllamaService() {
        if (this.isOllamaRunning) {
            await this.stopOllamaService();
        } else {
            await this.startOllamaService();
        }
    }

    async startOllamaService() {
        try {
            // First check if Ollama is already running
            await this.checkOllamaStatus();
            
            if (this.isOllamaRunning) {
                new Notice('Ollama service is already running');
                await this.refreshAvailableModels();
                return true;
            }
            
            // Try to start Ollama
            new Notice('Starting Ollama service...');
            
            try {
                // Spawn ollama serve command
                const ollamaCmd = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
                
                this.ollamaProcess = spawn(ollamaCmd, ['serve'], {
                    detached: false,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    shell: true
                });
                
                this.ollamaProcess.on('error', (err) => {
                    console.error('Failed to start Ollama:', err);
                    new Notice('Failed to start Ollama. Make sure it is installed and in your PATH.');
                    this.ollamaProcess = null;
                });
                
                this.ollamaProcess.on('exit', (code) => {
                    if (code !== 0 && code !== null) {
                        console.log('Ollama process exited with code:', code);
                    }
                    this.ollamaProcess = null;
                    this.isOllamaRunning = false;
                });
                
                // Wait a moment for Ollama to start up
                await this.waitForOllama(10, 500);
                
                if (this.isOllamaRunning) {
                    new Notice('Ollama service started successfully');
                    await this.refreshAvailableModels();
                    return true;
                } else {
                    new Notice('Ollama started but not responding. Please check the installation.');
                    return false;
                }
            } catch (spawnError) {
                // If spawn fails, Ollama might already be running as a system service
                await this.checkOllamaStatus();
                if (this.isOllamaRunning) {
                    new Notice('Ollama service is running');
                    await this.refreshAvailableModels();
                    return true;
                }
                throw spawnError;
            }
        } catch (error) {
            console.error('Failed to start Ollama service:', error);
            new Notice('Failed to start Ollama service. Please ensure Ollama is installed.');
            return false;
        }
    }

    async waitForOllama(maxAttempts, delayMs) {
        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            const isRunning = await this.checkOllamaStatus();
            if (isRunning) {
                return true;
            }
        }
        return false;
    }

    async stopOllamaService() {
        try {
            // If we started the process, kill it
            if (this.ollamaProcess) {
                this.killOllamaProcess();
                new Notice('Ollama service stopped');
            } else {
                // We didn't start it, just disconnect
                new Notice('Disconnected from Ollama service');
            }
            
            this.isOllamaRunning = false;
            this.availableModels = [];
            return true;
        } catch (error) {
            console.error('Failed to stop Ollama service:', error);
            new Notice('Failed to stop Ollama service');
            return false;
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
                this.availableModels = data.models.map(model => model.name);
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
