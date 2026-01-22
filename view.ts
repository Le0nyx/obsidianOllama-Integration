import { ItemView, WorkspaceLeaf, DropdownComponent } from 'obsidian';

export const VIEW_TYPE_OLLAMA_SIDE = 'ollama-side-view';

export class OllamaSideView extends ItemView {
    plugin: any;
    inputElement: HTMLTextAreaElement;
    outputElement: HTMLDivElement;
    sendButton: HTMLButtonElement;
    statusElement: HTMLDivElement;
    modelDropdown: DropdownComponent;
    startStopButton: HTMLButtonElement;
    conversationHistory: string[] = [];

    constructor(leaf: WorkspaceLeaf, plugin: any) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return VIEW_TYPE_OLLAMA_SIDE;
    }

    getDisplayText(): string {
        return 'Ollama Chat';
    }

    getIcon(): string {
        return 'brain-circuit';
    }

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.addClass('ollama-side-container');

        // Header with controls
        const header = container.createDiv('ollama-header');
        header.createEl('h3', { text: 'Ollama Chat' });

        // Status and controls section
        const controlsSection = container.createDiv('ollama-controls-section');
        
        // Status indicator
        const statusContainer = controlsSection.createDiv('ollama-status-container');
        this.statusElement = statusContainer.createDiv('ollama-status');
        this.updateStatusIndicator();

        // Start/Stop button
        this.startStopButton = statusContainer.createEl('button', {
            text: this.plugin.isOllamaRunning ? 'Stop Ollama' : 'Start Ollama',
            cls: 'ollama-start-stop-button'
        });
        
        this.startStopButton.addEventListener('click', () => {
            this.plugin.toggleOllamaService();
            this.updateUI();
        });

        // Model selection
        const modelContainer = controlsSection.createDiv('ollama-model-container');
        modelContainer.createSpan({ text: 'Model: ' });
        
        const modelSelect = modelContainer.createEl('select', { cls: 'ollama-model-select' });
        this.modelDropdown = new DropdownComponent(modelSelect);
        this.populateModelDropdown();

        // Refresh models button
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

        // Conversation history area
        this.outputElement = container.createDiv('ollama-output');

        // Input area
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

        // Set up UI based on current status
        this.updateUI();

        // Listen for status changes
        this.plugin.registerEvent(this.app.workspace.on('ollama-status-change', () => {
            this.updateUI();
        }));
    }

    updateUI() {
        const isRunning = this.plugin.isOllamaRunning;
        
        // Update button text and status
        this.startStopButton.setText(isRunning ? 'Stop Ollama' : 'Start Ollama');
        this.updateStatusIndicator();
        
        // Enable/disable input and send button
        this.inputElement.disabled = !isRunning;
        this.sendButton.disabled = !isRunning;
        
        // Refresh models if running
        if (isRunning) {
            this.populateModelDropdown();
        } else {
            this.modelDropdown.selectEl.empty();
            this.modelDropdown.addOption('', 'No models available');
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
        this.modelDropdown.selectEl.empty();
        
        if (this.plugin.availableModels.length === 0) {
            this.modelDropdown.addOption('', 'Loading models...');
            return;
        }

        this.plugin.availableModels.forEach(model => {
            this.modelDropdown.addOption(model, model);
        });

        // Select the default model if available
        const defaultModel = this.plugin.settings.defaultModel;
        if (this.plugin.availableModels.includes(defaultModel)) {
            this.modelDropdown.setValue(defaultModel);
        } else if (this.plugin.availableModels.length > 0) {
            this.modelDropdown.setValue(this.plugin.availableModels[0]);
        }
    }

    async sendMessage() {
        if (!this.plugin.isOllamaRunning) {
            new Notice('Ollama service is not running');
            return;
        }

        const message = this.inputElement.value.trim();
        if (!message) return;

        // Add to conversation
        this.addMessage('user', message);
        this.inputElement.value = '';
        this.sendButton.disabled = true;

        try {
            const selectedModel = this.modelDropdown.getValue() || this.plugin.settings.defaultModel;
            const response = await this.callOllama(message, selectedModel);
            this.addMessage('assistant', response);
        } catch (error) {
            this.addMessage('assistant', `Error: ${error.message}`);
        } finally {
            this.sendButton.disabled = false;
        }
    }

    async callOllama(prompt: string, model: string): Promise<string> {
        const { ollamaUrl } = this.plugin.settings;
        
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

    buildPrompt(userPrompt: string): string {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            return `Based on the context: [user's note content]\n\nUser question: ${userPrompt}`;
        }
        return userPrompt;
    }

    addMessage(role: 'user' | 'assistant', content: string) {
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
