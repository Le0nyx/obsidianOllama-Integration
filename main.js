const { Plugin, WorkspaceLeaf } = require('obsidian');

const DEFAULT_SETTINGS = {
    ollamaUrl: 'http://localhost:11434',
    defaultModel: 'llama3.1',
    temperature: 0.7,
    maxTokens: 1000,
    autoStart: false
};

class OllamaPlugin extends Plugin {
    constructor(app, manifest) {
        super(app, manifest);
        this.settings = { ...DEFAULT_SETTINGS };
        this.isOllamaRunning = false;
        this.availableModels = [];
    }

    async onload() {
        await this.loadSettings();

        if (this.settings.autoStart) {
            await this.checkOllamaStatus();
        }

        this.registerView(
            'ollama-side-view',
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

        this.registerInterval(window.setInterval(() => {
            if (this.isOllamaRunning) {
                this.refreshAvailableModels();
            }
        }, 60000));
    }

    async activateView() {
        const workspace = this.app.workspace;
        let leaf = null;
        const leaves = workspace.getLeavesOfType('ollama-side-view');

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({
                type: 'ollama-side-view',
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
            await this.checkOllamaStatus();
            
            if (!this.isOllamaRunning) {
                const response = await fetch(`${this.settings.ollamaUrl}/api/tags`, {
                    method: 'GET'
                });
                
                if (response.ok) {
                    this.isOllamaRunning = true;
                    new Notice('Ollama service is running');
                    await this.refreshAvailableModels();
                    return true;
                } else {
                    new Notice('Please make sure Ollama is installed and running');
                    return false;
                }
            }
            return true;
        } catch (error) {
            new Notice('Failed to start Ollama service. Please ensure Ollama is installed and running.');
            return false;
        }
    }

    async stopOllamaService() {
        try {
            this.isOllamaRunning = false;
            this.availableModels = [];
            new Notice('Disconnected from Ollama service');
            return true;
        } catch (error) {
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

class OllamaSideView {
    constructor(leaf, plugin) {
        this.leaf = leaf;
        this.plugin = plugin;
        this.conversationHistory = [];
    }

    getViewType() {
        return 'ollama-side-view';
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

        const header = container.createDiv('ollama-header');
        header.createEl('h3', { text: 'Ollama Chat' });

        const controlsSection = container.createDiv('ollama-controls-section');
        
        const statusContainer = controlsSection.createDiv('ollama-status-container');
        this.statusElement = statusContainer.createDiv('ollama-status');
        this.updateStatusIndicator();

        this.startStopButton = statusContainer.createEl('button', {
            text: this.plugin.isOllamaRunning ? 'Stop Ollama' : 'Start Ollama',
            cls: 'ollama-start-stop-button'
        });
        
        this.startStopButton.addEventListener('click', () => {
            this.plugin.toggleOllamaService();
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
        refreshButton.addEventListener('click', () => {
            this.plugin.refreshAvailableModels().then(() => {
                this.populateModelDropdown();
                new Notice('Models refreshed');
            });
        });

        this.outputElement = container.createDiv('ollama-output');

        const inputContainer = container.createDiv('ollama-input-container');
        
        this.inputElement = inputContainer.createEl('textarea', {
            placeholder: 'Ask Ollama anything...',
            cls: 'ollama-textarea'
        });
        this.inputElement.rows = 3;
        this.inputElement.disabled = !this.plugin.isOllamaRunning;

        this.sendButton = inputContainer.createEl('button', {
            text: 'Send',
            cls: 'ollama-send-button'
        });
        this.sendButton.disabled = !this.plugin.isOllamaRunning;

        this.sendButton.addEventListener('click', () => {
            this.sendMessage();
        });

        this.inputElement.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                this.sendMessage();
            }
        });

        this.updateUI();
    }

    updateUI() {
        const isRunning = this.plugin.isOllamaRunning;
        
        this.startStopButton.setText(isRunning ? 'Stop Ollama' : 'Start Ollama');
        this.updateStatusIndicator();
        
        this.inputElement.disabled = !isRunning;
        this.sendButton.disabled = !isRunning;
        
        if (isRunning) {
            this.populateModelDropdown();
        } else {
            this.modelSelect.empty();
            const option = this.modelSelect.createEl('option');
            option.value = '';
            option.text = 'No models available';
        }
    }

    updateStatusIndicator() {
        this.statusElement.empty();
        const statusText = this.plugin.isOllamaRunning ? '● Running' : '○ Stopped';
        const statusClass = this.plugin.isOllamaRunning ? 'running' : 'stopped';
        
        this.statusElement.setText(statusText);
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

        this.addMessage('user', message);
        this.inputElement.value = '';
        this.sendButton.disabled = true;

        try {
            const selectedModel = this.modelSelect.value || this.plugin.settings.defaultModel;
            const response = await this.callOllama(message, selectedModel);
            this.addMessage('assistant', response);
        } catch (error) {
            this.addMessage('assistant', `Error: ${error.message}`);
        } finally {
            this.sendButton.disabled = false;
        }
    }

    async callOllama(prompt, model) {
        const ollamaUrl = this.plugin.settings.ollamaUrl;
        
        const requestBody = {
            model: model,
            prompt: this.buildPrompt(prompt),
            stream: false,
            options: {
                temperature: this.plugin.settings.temperature,
                num_predict: this.plugin.settings.maxTokens
            }
        };

        const response = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status}`);
        }

        const data = await response.json();
        return data.response;
    }

    buildPrompt(userPrompt) {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            return `Based on the context: [user's note content]\n\nUser question: ${userPrompt}`;
        }
        return userPrompt;
    }

    addMessage(role, content) {
        const messageDiv = this.outputElement.createDiv(`ollama-message ollama-${role}`);
        const roleSpan = messageDiv.createSpan({ text: role === 'user' ? 'You: ' : 'Ollama: ' });
        roleSpan.addClass('ollama-role');
        
        const contentSpan = messageDiv.createSpan({ text: content });
        contentSpan.addClass('ollama-content');
        
        this.outputElement.scrollTop = this.outputElement.scrollHeight;
    }

    async onClose() {
        // Clean up if needed
    }
}

class OllamaSettingsTab {
    constructor(app, plugin) {
        this.app = app;
        this.plugin = plugin;
    }

    display() {
        const containerEl = this.containerEl;
        containerEl.empty();

        const statusSetting = new Setting(containerEl)
            .setName('Ollama Status')
            .setDesc(this.plugin.isOllamaRunning ? '● Service is running' : '○ Service is stopped');
        
        statusSetting.addButton(button => {
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
            .setDesc('Model temperature (0.0 - 1.0)')
            .addSlider(slider => {
                slider.setLimits(0, 1, 0.1)
                    .setValue(this.plugin.settings.temperature)
                    .onChange(async (value) => {
                        this.plugin.settings.temperature = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Max Tokens')
            .setDesc('Maximum tokens to generate')
            .addText(text => {
                text.setPlaceholder('1000')
                    .setValue(this.plugin.settings.maxTokens.toString())
                    .onChange(async (value) => {
                        this.plugin.settings.maxTokens = parseInt(value) || 1000;
                        await this.plugin.saveSettings();
                    });
            });
    }
}

module.exports = OllamaPlugin;
