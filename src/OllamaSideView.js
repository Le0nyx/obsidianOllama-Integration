const { ItemView, Notice, TFolder } = require('obsidian');
const { VIEW_TYPE_OLLAMA } = require('./constants');

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
                    text: `📎 Context: ${activeFile.basename}`,
                    cls: 'ollama-context-text'
                });
            } else {
                this.contextNotePath = null;
                this.contextIndicator.createSpan({ 
                    text: '📎 No note context',
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

        // Create placeholder for streaming response
        const responseDiv = this.outputElement.createDiv('ollama-message ollama-assistant');
        const roleSpan = responseDiv.createSpan({ text: 'Ollama: ' });
        roleSpan.addClass('ollama-role');
        const contentSpan = responseDiv.createSpan({ text: '' });
        contentSpan.addClass('ollama-content');

        try {
            const selectedModel = this.modelSelect.value || this.plugin.settings.defaultModel;
            const response = await this.callOllamaStreaming(message, selectedModel, contentSpan);
            this.messages.push({ role: 'assistant', content: response });
            
            // Auto-save after each exchange
            await this.saveCurrentChat();
        } catch (error) {
            if (error.name !== 'AbortError') {
                contentSpan.setText(`Error: ${error.message}`);
                this.messages.push({ role: 'assistant', content: `Error: ${error.message}` });
            }
        } finally {
            this.inputElement.disabled = false;
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
        const roleSpan = messageDiv.createSpan({ text: role === 'user' ? 'You: ' : 'Ollama: ' });
        roleSpan.addClass('ollama-role');
        
        const contentSpan = messageDiv.createSpan({ text: content });
        contentSpan.addClass('ollama-content');
        
        this.outputElement.scrollTop = this.outputElement.scrollHeight;
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

module.exports = OllamaSideView;
