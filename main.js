const { Plugin, Notice } = require('obsidian');
const { spawn } = require('child_process');

const { VIEW_TYPE_OLLAMA, DEFAULT_SETTINGS } = require('./src/constants');
const OllamaSideView = require('./src/OllamaSideView');
const OllamaSettingsTab = require('./src/OllamaSettingsTab');

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
