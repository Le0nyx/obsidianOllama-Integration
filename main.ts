import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { OllamaSideView, VIEW_TYPE_OLLAMA_SIDE } from './view';
import { OllamaSettingsTab } from './settings';

interface OllamaSettings {
    ollamaUrl: string;
    defaultModel: string;
    temperature: number;
    maxTokens: number;
    autoStart: boolean;
}

const DEFAULT_SETTINGS: OllamaSettings = {
    ollamaUrl: 'http://localhost:11434',
    defaultModel: 'llama3.1',
    temperature: 0.7,
    maxTokens: 1000,
    autoStart: false
};

export default class OllamaPlugin extends Plugin {
    settings: OllamaSettings;
    isOllamaRunning: boolean = false;
    availableModels: string[] = [];

    async onload() {
        await this.loadSettings();

        // Check Ollama status on startup
        if (this.settings.autoStart) {
            await this.checkOllamaStatus();
        }

        // Register the side view
        this.registerView(
            VIEW_TYPE_OLLAMA_SIDE,
            (leaf) => new OllamaSideView(leaf, this)
        );

        // Add ribbon icon
        this.addRibbonIcon('brain-circuit', 'Ollama Chat', () => {
            this.activateView();
        });

        // Add commands
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

        // Add settings tab
        this.addSettingTab(new OllamaSettingsTab(this.app, this));

        // Refresh models every minute
        this.registerInterval(window.setInterval(() => {
            if (this.isOllamaRunning) {
                this.refreshAvailableModels();
            }
        }, 60000));
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_OLLAMA_SIDE);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            await leaf.setViewState({
                type: VIEW_TYPE_OLLAMA_SIDE,
                active: true
            });
        }

        workspace.revealLeaf(leaf);
        
        // Refresh models when view opens
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

    async startOllamaService(): Promise<boolean> {
        try {
            // Try to start Ollama (this might not work on all systems - depends on Ollama installation)
            // You might need to run this via CLI commands
            await this.checkOllamaStatus();
            
            if (!this.isOllamaRunning) {
                // Try alternative method - check if Ollama executable exists
                const response = await fetch(`${this.settings.ollamaUrl}/api/tags`, {
                    method: 'GET',
                    timeout: 5000
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

    async stopOllamaService(): Promise<boolean> {
        try {
            // Note: This might not actually stop the Ollama service
            // It just disconnects from it. Stopping the service typically requires CLI commands
            this.isOllamaRunning = false;
            this.availableModels = [];
            new Notice('Disconnected from Ollama service');
            return true;
        } catch (error) {
            new Notice('Failed to stop Ollama service');
            return false;
        }
    }

    async checkOllamaStatus(): Promise<boolean> {
        try {
            const response = await fetch(`${this.settings.ollamaUrl}/api/tags`, {
                method: 'GET',
                timeout: 3000
            });
            
            this.isOllamaRunning = response.ok;
            return response.ok;
        } catch (error) {
            this.isOllamaRunning = false;
            return false;
        }
    }

    async refreshAvailableModels(): Promise<void> {
        if (!this.isOllamaRunning) return;

        try {
            const response = await fetch(`${this.settings.ollamaUrl}/api/tags`);
            if (response.ok) {
                const data = await response.json();
                this.availableModels = data.models.map((model: any) => model.name);
            }
        } catch (error) {
            console.error('Failed to fetch models:', error);
            this.availableModels = [];
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
